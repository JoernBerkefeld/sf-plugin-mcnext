import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Builder } from 'xml2js';
import { OrgIdentityError, resolveExpectedOrgIdentity, type OrgIdentityResolver } from '../mutation/orgIdentity.js';
import {
  applySegmentDefinitionMappings,
  compareSegmentDefinitions,
  inventorySegmentDefinitionReferences,
  parseSegmentDefinitionXml,
  serializeSegmentDefinitionCriteria,
  type SegmentDefinition,
  type SegmentDefinitionMappingFile,
} from './segmentDefinition.js';
import { parseSegmentCoreResult, type SegmentCoreRunner } from './segmentDefinitionCli.js';

export type SegmentDescriptor = Record<string, unknown> & {
  apiName?: string;
  displayName?: string;
  marketSegmentDefinitionId?: string;
  marketSegmentId?: string;
  publishStatus?: string;
  segmentStatus?: string;
  segmentType?: string;
};

export type SegmentConnectTransport = {
  list(): Promise<SegmentDescriptor[]>;
  show(apiName: string): Promise<unknown>;
};

export type SegmentDefinitionCreateSelection = {
  projectRoot: string;
  sourceOrg: string;
  targetOrg: string;
  expectedSourceOrgId: string;
  expectedTargetOrgId: string;
  sourceFile: string;
  member: string;
  mappingFile: SegmentDefinitionMappingFile;
  dryRun?: boolean;
  waitMinutes?: number;
  visibilityPolls?: number;
};

export type SegmentDefinitionCreateResult = {
  operation: 'create';
  state: 'validated' | 'succeeded' | 'pending';
  member: string;
  validationJobId: string;
  applyJobId?: string;
  marketSegmentDefinitionId?: string;
  marketSegmentId?: string;
};

export type SegmentDefinitionCreateServices = {
  resolveOrgIdentity: OrgIdentityResolver;
  core: SegmentCoreRunner;
  connect: SegmentConnectTransport;
  initialIdentitiesVerified?: boolean;
};

const metadataType = 'MarketSegmentDefinition';
const suffix = '.marketSegmentDefinition-meta.xml';

/** Execute bounded CREATE through Core, then independently prove source and Connect correlation. */
export async function createSegmentDefinition(
  selection: SegmentDefinitionCreateSelection,
  services: SegmentDefinitionCreateServices
): Promise<SegmentDefinitionCreateResult> {
  const wait = validateSelection(selection);
  if (!services.initialIdentitiesVerified) await resolveBothOrgIdentities(selection, services.resolveOrgIdentity);
  const { sourceXml, packageDirectory } = await loadSource(selection);
  const source = await parseSegmentDefinitionXml(sourceXml, selection.member, selection.sourceFile);
  inventorySegmentDefinitionReferences(source);
  const transformed = applySegmentDefinitionMappings(source, selection.mappingFile);
  const transformedXml = serializeDefinition(transformed);
  await assertTargetAbsent(selection.member, services.connect);

  const isolated = await createIsolatedProject(packageDirectory, selection.member, transformedXml);
  let failure: unknown;
  let outcome: SegmentDefinitionCreateResult | undefined;
  try {
    const validation = parseSegmentCoreResult(
      'validate',
      selection.member,
      await services.core(deployArgs(selection.targetOrg, selection.member, wait, true), isolated.root)
    );
    if (selection.dryRun) {
      outcome = {
        operation: 'create',
        state: 'validated',
        member: selection.member,
        validationJobId: validation.jobId,
      };
    } else {
      await resolveBothOrgIdentities(selection, services.resolveOrgIdentity);
      await assertTargetAbsent(selection.member, services.connect);
      const applied = parseSegmentCoreResult(
        'create',
        selection.member,
        await services.core(deployArgs(selection.targetOrg, selection.member, wait, false), isolated.root)
      );
      const retrieved = await retrieveIndependent(selection, packageDirectory, wait, services.core);
      const readback = await parseSegmentDefinitionXml(retrieved, selection.member, `${selection.member}${suffix}`);
      const comparison = compareSegmentDefinitions(transformed, readback);
      if (!comparison.equal)
        throw new Error(`Independent Segment Definition readback differs: ${comparison.differences.join(', ')}`);
      const correlated = await correlateVisibility(selection, services.connect);
      outcome = {
        operation: 'create',
        state: correlated ? 'succeeded' : 'pending',
        member: selection.member,
        validationJobId: validation.jobId,
        applyJobId: applied.jobId,
        ...(correlated
          ? {
              marketSegmentDefinitionId: correlated.marketSegmentDefinitionId,
              marketSegmentId: correlated.marketSegmentId,
            }
          : {}),
      };
    }
  } catch (error) {
    failure = error;
  }
  try {
    await rm(isolated.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    throw new Error(
      `Segment Definition outcome: ${String(failure ?? outcome)}; scratch cleanup failed: ${String(error)}`
    );
  }
  if (failure) throw failure;
  if (!outcome) throw new Error('Segment Definition CREATE ended without a result');
  return outcome;
}

function validateSelection(selection: SegmentDefinitionCreateSelection): number {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(selection.member))
    throw new Error('Explicit Segment Definition member is required');
  for (const alias of [selection.sourceOrg, selection.targetOrg])
    if (!alias.trim() || alias.startsWith('-') || alias.includes('\0'))
      throw new Error('Explicit source and target aliases are required');
  const wait = selection.waitMinutes ?? 10;
  if (!Number.isSafeInteger(wait) || wait < 1 || wait > 30) throw new Error('Wait must be 1–30 minutes');
  const polls = selection.visibilityPolls ?? 3;
  if (!Number.isSafeInteger(polls) || polls < 1 || polls > 10) throw new Error('Visibility polls must be 1–10');
  return wait;
}

export async function resolveBothOrgIdentities(
  selection: SegmentDefinitionCreateSelection,
  resolver: OrgIdentityResolver
): Promise<void> {
  if (!/^00D[A-Za-z0-9]{15}$/.test(selection.expectedSourceOrgId))
    throw new OrgIdentityError('INVALID_EXPECTED_ORG_ID', 'source');
  if (!/^00D[A-Za-z0-9]{15}$/.test(selection.expectedTargetOrgId))
    throw new OrgIdentityError('INVALID_EXPECTED_ORG_ID', 'target');
  if (selection.expectedSourceOrgId === selection.expectedTargetOrgId)
    throw new Error('Source and target org identities must be distinct');
  const source = await resolveExpectedOrgIdentity(
    { targetOrg: selection.sourceOrg, expectedOrgId: selection.expectedSourceOrgId, role: 'source' },
    resolver
  );
  const target = await resolveExpectedOrgIdentity(
    { targetOrg: selection.targetOrg, expectedOrgId: selection.expectedTargetOrgId, role: 'target' },
    resolver
  );
  if (source.orgId === target.orgId) throw new Error('Source and target org identities must be distinct');
}

async function loadSource(
  selection: SegmentDefinitionCreateSelection
): Promise<{ sourceXml: string; packageDirectory: string }> {
  const projectRoot = resolve(selection.projectRoot);
  const project = JSON.parse(await readFile(join(projectRoot, 'sfdx-project.json'), 'utf8')) as {
    packageDirectories?: Array<{ path: string }>;
  };
  if (!Array.isArray(project.packageDirectories) || project.packageDirectories.length === 0)
    throw new Error('Configured packageDirectories required');
  const sourceFile = resolve(projectRoot, selection.sourceFile);
  if (basename(sourceFile) !== `${selection.member}${suffix}`)
    throw new Error('Source file must be the exact selected Segment Definition member');
  const owner = project.packageDirectories.find((entry) => {
    if (!entry.path || isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) return false;
    const rel = relative(resolve(projectRoot, entry.path), sourceFile);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!owner) throw new Error('Segment Definition source must be inside a configured project package directory');
  return { sourceXml: await readFile(sourceFile, 'utf8'), packageDirectory: owner.path };
}

async function createIsolatedProject(packageDirectory: string, member: string, xml: string): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mcnext-segment-create-'));
  const folder = join(root, packageDirectory, 'main', 'default', 'marketSegmentDefinitions');
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(root, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: packageDirectory, default: true }] })
  );
  await writeFile(join(folder, `${member}${suffix}`), xml);
  return { root };
}

function deployArgs(targetOrg: string, member: string, wait: number, dryRun: boolean): string[] {
  return [
    'project',
    'deploy',
    'start',
    '--target-org',
    targetOrg,
    '--metadata',
    `${metadataType}:${member}`,
    '--wait',
    String(wait),
    ...(dryRun ? ['--dry-run'] : []),
    '--json',
  ];
}

async function assertTargetAbsent(member: string, connect: SegmentConnectTransport): Promise<void> {
  const segments = await connect.list();
  if (segments.some((segment) => !segment.apiName))
    throw new Error('Malformed Connect Segment Definition collection item');
  if (segments.some((segment) => segment.apiName === member))
    throw new Error('Segment Definition identity already exists; CREATE will not update or overwrite');
}

async function retrieveIndependent(
  selection: SegmentDefinitionCreateSelection,
  packageDirectory: string,
  wait: number,
  core: SegmentCoreRunner
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcnext-segment-readback-'));
  try {
    await mkdir(join(root, packageDirectory), { recursive: true });
    await writeFile(
      join(root, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: [{ path: packageDirectory, default: true }] })
    );
    parseSegmentCoreResult(
      'retrieve',
      selection.member,
      await core(
        [
          'project',
          'retrieve',
          'start',
          '--target-org',
          selection.targetOrg,
          '--metadata',
          `${metadataType}:${selection.member}`,
          '--wait',
          String(wait),
          '--json',
        ],
        root
      )
    );
    const folder = join(root, packageDirectory, 'main', 'default', 'marketSegmentDefinitions');
    const files = await readdir(folder);
    if (files.length !== 1 || files[0] !== `${selection.member}${suffix}`)
      throw new Error('Independent Segment Definition retrieval must materialize exactly one selected file');
    return await readFile(join(folder, files[0]), 'utf8');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function correlateVisibility(
  selection: SegmentDefinitionCreateSelection,
  connect: SegmentConnectTransport
): Promise<SegmentDescriptor | undefined> {
  const polls = selection.visibilityPolls ?? 3;
  for (let index = 0; index < polls; index++) {
    // eslint-disable-next-line no-await-in-loop -- bounded read-only visibility polling is intentionally sequential
    const listed = (await connect.list()).filter((segment) => segment.apiName === selection.member);
    if (listed.length > 1) throw new Error('Connect returned ambiguous Segment Definition identity');
    if (listed.length === 1) {
      // eslint-disable-next-line no-await-in-loop -- details must correlate with the unique listed identity
      const detailed = unwrapSegmentDetail(await connect.show(selection.member));
      if (!sameIdentity(listed[0], detailed))
        throw new Error('Connect Segment Definition identity correlation mismatch');
      if (!validLifecycle(detailed)) throw new Error('Connect returned an unsupported Segment Definition lifecycle');
      return detailed;
    }
  }
  return undefined;
}

function unwrapSegmentDetail(value: unknown): SegmentDescriptor {
  if (!isRecord(value) || !Array.isArray(value.segments) || value.segments.length !== 1 || !isRecord(value.segments[0]))
    throw new Error('Malformed Connect Segment Definition response envelope');
  return value.segments[0];
}

function sameIdentity(listed: SegmentDescriptor, detailed: SegmentDescriptor): boolean {
  return (
    listed.apiName === detailed.apiName &&
    listed.marketSegmentDefinitionId === detailed.marketSegmentDefinitionId &&
    listed.marketSegmentId === detailed.marketSegmentId &&
    typeof detailed.marketSegmentDefinitionId === 'string' &&
    /^3HX[A-Za-z0-9]{15}$/.test(detailed.marketSegmentDefinitionId) &&
    typeof detailed.marketSegmentId === 'string' &&
    /^1sg[A-Za-z0-9]{15}$/.test(detailed.marketSegmentId)
  );
}

function validLifecycle(segment: SegmentDescriptor): boolean {
  return (
    ['UI', 'DBT'].includes(String(segment.segmentType)) &&
    !['PUBLISHED', 'ACTIVE', 'RUNNING', 'SCHEDULED'].includes(String(segment.publishStatus).toUpperCase()) &&
    !['PUBLISHED', 'ACTIVE', 'RUNNING', 'SCHEDULED'].includes(String(segment.segmentStatus).toUpperCase())
  );
}

function serializeDefinition(definition: SegmentDefinition): string {
  const builder = new Builder({ headless: true, renderOpts: { pretty: true, indent: '    ', newline: '\n' } });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    builder.buildObject({
      MarketSegmentDefinition: {
        $: { xmlns: 'http://soap.sforce.com/2006/04/metadata' },
        includeCriteria: [serializeSegmentDefinitionCriteria(definition.includeCriteria)],
        masterLabel: [definition.masterLabel],
        ...(definition.segmentOn ? { segmentOn: [definition.segmentOn] } : {}),
        segmentType: [definition.segmentType],
      },
    }) +
    '\n'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
