import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import filesystem, { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseStringPromise } from 'xml2js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
} from '../filesystem/runOwnedTemp.js';
import { runCampaign, type CampaignExportDiagnostics } from './campaignCli.js';
import { FlowJobError, runCore, runFlow, type CoreRunner } from './flowCli.js';

export type CampaignFlowRetrievalInput = {
  projectRoot: string;
  targetOrg: string;
  expectedOrgId: string;
  apiVersion: string;
  campaignId: string;
  waitMinutes?: number;
};
export type CampaignFlowAssociationArtifact = {
  schemaVersion: 1;
  kind: 'campaign-flow-associations';
  source: { orgId: string; apiVersion: string; campaignId: string };
  flows: Array<{
    member: string;
    flowRecordId: string;
    associatedRecordId: string;
    segmentId: string | null;
    definitionId: string;
    latestVersionId: string;
    nativeFile: string;
    nativeSha256: string;
  }>;
};
export type CampaignFlowRetrievalResult = {
  campaignId: string;
  state: 'succeeded' | 'blocked' | 'pending' | 'failed';
  members: string[];
  files: Array<{ member: string; filePath: string }>;
  associationPersistence: 'blocked';
  associationArtifactFile?: string;
  associationArtifact?: CampaignFlowAssociationArtifact;
  diagnostics: string[];
  jobId?: string;
  stagingProject?: string;
  retainedRoot?: string;
};
type Discovery = CampaignExportDiagnostics['associatedArtifacts'];
type DiscoveredFlow = NonNullable<Discovery['flows']>[number];
const execute = promisify(execFile);
const namespace = 'http://soap.sforce.com/2006/04/metadata';

/** Retrieve native bytes only. Campaign attachment persistence and portable restore remain blocked. */
export async function retrieveCampaignFlows(
  input: CampaignFlowRetrievalInput,
  runner: CoreRunner = runCore
): Promise<CampaignFlowRetrievalResult> {
  const result: CampaignFlowRetrievalResult = {
    campaignId: input.campaignId,
    state: 'blocked',
    members: [],
    files: [],
    associationPersistence: 'blocked',
    diagnostics: ['Native Flow XML does not preserve Campaign attachment; this is not a full backup'],
  };
  try {
    if (input.apiVersion !== '67.0') throw new Error('Campaign Flow association evidence requires API 67.0');
    const campaign = await runCampaign({ ...input, operation: 'export', recordId: input.campaignId }, runner);
    if (campaign.operation !== 'export') throw new Error('Expected fresh Campaign export discovery');
    const discovery = campaign.diagnostics.associatedArtifacts;
    result.diagnostics.push(discovery.reason);
    result.diagnostics.push(...(discovery.flows ?? []).flatMap((flow) => (flow.reason ? [flow.reason] : [])));
    const flows = validateDiscovery(discovery, input.campaignId);
    result.members = flows.map((flow) => String(flow.record.ApiName));
    if (!flows.length) return { ...result, state: 'succeeded' };
    const root = resolve(input.projectRoot);
    await safePath(root);
    await safePath(join(root, 'sfdx-project.json'));
    const project: unknown = JSON.parse(await readFile(join(root, 'sfdx-project.json'), 'utf8'));
    const packages = validateProject(project);
    await Promise.all(packages.map(async (entry) => safePath(join(root, entry.path))));
    const run = await createRunOwnedTemp('mcnext-campaign-flows');
    const staging = await createRunOwnedDirectory(run, 'project');
    result.stagingProject = staging;
    result.state = 'failed';
    await Promise.all(packages.map(async (entry) => mkdir(join(staging, entry.path), { recursive: true })));
    await writeFile(
      join(staging, 'sfdx-project.json'),
      JSON.stringify({ packageDirectories: packages, sourceApiVersion: input.apiVersion }),
      { flag: 'wx' }
    );
    const native = await runFlow(
      {
        projectRoot: staging,
        targetOrg: input.targetOrg,
        apiVersion: input.apiVersion,
        members: result.members,
        operation: 'retrieve',
        waitMinutes: input.waitMinutes,
      },
      async (args, cwd) => {
        const response = await runner(args, cwd);
        try {
          const envelope: unknown = JSON.parse(response.stdout);
          if (object(envelope) && object(envelope.result) && typeof envelope.result.id === 'string')
            result.jobId = envelope.result.id;
        } catch {
          // runFlow reports malformed JSON; no job identity is invented.
        }
        return response;
      }
    );
    result.jobId = native.jobId;
    result.diagnostics.push(...(native.diagnostics ?? []).map((entry) => JSON.stringify(entry)));
    if (native.state === 'pending') return { ...result, state: 'pending' };
    const files = native.coreResult.files as Array<Record<string, unknown>>;
    if (files.length !== flows.length) throw new Error('Native result must contain exactly one file per selected Flow');
    const publications = await Promise.all(
      flows.map(async (flow) => {
        const member = String(flow.record.ApiName);
        const selected = files.filter((file) => file.type === 'Flow' && file.fullName === member);
        if (selected.length !== 1 || typeof selected[0].filePath !== 'string')
          throw new Error('Duplicate or missing authoritative Flow path');
        if (/[\0*?]/.test(selected[0].filePath) || selected[0].filePath.split(/[\\/]/).includes('..'))
          throw new Error('Unsafe authoritative Flow path');
        const source = resolve(staging, selected[0].filePath);
        const owners = packages.filter(
          (entry) => source === join(staging, entry.path, 'main', 'default', 'flows', `${member}.flow-meta.xml`)
        );
        if (owners.length !== 1) throw new Error('Native Flow path is not an exact configured-package member path');
        await safePath(source);
        if (!(await lstat(source)).isFile() || (await realpath(source)) !== source)
          throw new Error('Native Flow source is not a regular canonical file');
        const bytes = await readFile(source);
        await validateXml(bytes, flow);
        const destination = join(root, relative(staging, source));
        await safePath(destination);
        if (await exists(destination)) throw new Error('Native Flow destination already exists; no overwrite');
        return { member, destination, bytes, flow };
      })
    );
    const associationFile = join(
      root,
      'mcnext',
      'campaign-flow-associations',
      `${input.campaignId}.mcn-flow-associations.json`
    );
    await safePath(associationFile);
    if (await exists(associationFile)) {
      result.diagnostics.push(`Association artifact publication not confirmed: ${associationFile}`);
      throw new Error('Association artifact destination already exists; no overwrite');
    }
    const artifact: CampaignFlowAssociationArtifact = {
      schemaVersion: 1,
      kind: 'campaign-flow-associations',
      source: { orgId: input.expectedOrgId, apiVersion: input.apiVersion, campaignId: input.campaignId },
      flows: publications.map(({ member, destination, bytes, flow }) => ({
        member,
        flowRecordId: String(flow.record.Id),
        associatedRecordId: String(flow.record.AssociatedRecordId),
        segmentId: flow.record.SegmentId as string | null,
        definitionId: String(flow.toolingDefinition!.Id),
        latestVersionId: String(flow.toolingDefinition!.LatestVersionId),
        nativeFile: relative(root, destination),
        nativeSha256: createHash('sha256').update(bytes).digest('hex'),
      })),
    };
    // All paths and XML pass preflight before any repository file is published.
    for (const publication of publications) {
      // eslint-disable-next-line no-await-in-loop -- publication order reports exact partial outcomes
      await safePath(publication.destination);
      // eslint-disable-next-line no-await-in-loop -- create only validated missing destination parents
      await mkdir(dirname(publication.destination), { recursive: true });
      // eslint-disable-next-line no-await-in-loop -- recheck newly created parents before exclusive publication
      await safePath(publication.destination);
      try {
        // eslint-disable-next-line no-await-in-loop -- exclusive creation prevents overwrite races
        const handle = await filesystem.open(publication.destination, 'wx');
        try {
          // eslint-disable-next-line no-await-in-loop -- retain truthful per-file publication outcomes
          await handle.writeFile(publication.bytes);
        } finally {
          // eslint-disable-next-line no-await-in-loop -- release each exclusively owned publication handle
          await handle.close();
        }
        result.files.push({ member: publication.member, filePath: publication.destination });
      } catch (error) {
        result.diagnostics.push(`Native Flow publication not confirmed: ${publication.destination}`);
        throw error;
      }
    }
    try {
      await safePath(associationFile);
      await mkdir(dirname(associationFile), { recursive: true });
      await safePath(associationFile);
      const handle = await filesystem.open(associationFile, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(artifact, undefined, 2)}\n`);
      } finally {
        await handle.close();
      }
      result.associationArtifactFile = associationFile;
      result.associationArtifact = artifact;
    } catch (error) {
      result.diagnostics.push(`Association artifact publication not confirmed: ${associationFile}`);
      throw error;
    }
    result.state = 'succeeded';
    try {
      await removeRunOwnedPath(run, staging);
      delete result.stagingProject;
      result.retainedRoot = run.root;
      await removeRunOwnedRoot(run);
      delete result.retainedRoot;
    } catch (error) {
      result.diagnostics.push(`Native Flow cleanup warning: ${String(error)}`);
    }
  } catch (error) {
    if (error instanceof FlowJobError) {
      if (typeof error.coreResult.id === 'string') result.jobId = error.coreResult.id;
      result.diagnostics.push(...error.diagnostics.map((entry) => JSON.stringify(entry)));
    }
    result.diagnostics.push(String(error));
  }
  return result;
}

function validateDiscovery(discovery: Discovery, campaignId: string): DiscoveredFlow[] {
  if (discovery.status !== 'complete' || !Array.isArray(discovery.flows))
    throw new Error(`Incomplete association discovery: ${discovery.reason}`);
  const ids = new Set<string>();
  const members = new Set<string>();
  for (const flow of discovery.flows) {
    const { record, toolingDefinition: definition, toolingFlow: version } = flow;
    if (flow.status !== 'complete') throw new Error(`Incomplete Flow discovery: ${flow.reason ?? discovery.reason}`);
    if (
      typeof record.Id !== 'string' ||
      !/^2aF[A-Za-z0-9]{15}$/.test(record.Id) ||
      ids.has(record.Id) ||
      record.AssociatedRecordId !== campaignId ||
      typeof record.ApiName !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(record.ApiName) ||
      members.has(record.ApiName) ||
      !definition ||
      !version
    )
      throw new Error('Duplicate, malformed or mismatched associated Flow identity');
    validateToolingIdentity(definition, version, record.ApiName);
    const start = (version.Metadata as Record<string, unknown>).start;
    const selectedSegment = object(start) ? start.segment : undefined;
    validateSegmentSelection(record.SegmentId, selectedSegment, 'Tooling start');
    ids.add(record.Id);
    members.add(record.ApiName);
  }
  return discovery.flows;
}

function validateSegmentSelection(recordSegment: unknown, selectedSegment: unknown, origin: string): void {
  if (
    recordSegment === null
      ? selectedSegment !== undefined && selectedSegment !== null
      : typeof recordSegment !== 'string' ||
        !/^1sg[A-Za-z0-9]{15}$/.test(recordSegment) ||
        selectedSegment !== recordSegment
  )
    throw new Error(`FlowRecord SegmentId does not match the discovered ${origin} selection`);
}

function validateToolingIdentity(
  definition: Record<string, unknown>,
  version: Record<string, unknown>,
  member: string
): void {
  if (
    typeof definition.Id !== 'string' ||
    !/^300[A-Za-z0-9]{15}$/.test(definition.Id) ||
    definition.DeveloperName !== member ||
    typeof definition.LatestVersionId !== 'string' ||
    !/^301[A-Za-z0-9]{15}$/.test(definition.LatestVersionId) ||
    version.Id !== definition.LatestVersionId ||
    version.DefinitionId !== definition.Id ||
    !object(version.Metadata)
  )
    throw new Error('Malformed or mismatched Tooling Flow identity');
}

function validateProject(project: unknown): Array<{ path: string; default?: boolean }> {
  if (!object(project) || !Array.isArray(project.packageDirectories) || !project.packageDirectories.length)
    throw new Error('Configured DX package roots are required');
  const packages = project.packageDirectories.map((entry: unknown) => {
    if (
      !object(entry) ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      isAbsolute(entry.path) ||
      /[:*?\0]/.test(entry.path) ||
      entry.path
        .replaceAll('\\', '/')
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      (entry.default !== undefined && typeof entry.default !== 'boolean')
    )
      throw new Error('Unsafe configured package root');
    return {
      path: entry.path.replaceAll('\\', '/'),
      ...(entry.default === undefined ? {} : { default: entry.default }),
    };
  });
  if (packages.filter((entry) => entry.default).length !== 1)
    throw new Error('Exactly one default package root is required');
  for (const entry of packages) {
    if (
      packages.some(
        (other) =>
          other !== entry &&
          (relative(resolve(other.path), resolve(entry.path)) === '' ||
            descendant(resolve(other.path), resolve(entry.path)))
      )
    )
      throw new Error('Duplicate or overlapping package roots');
  }
  return packages;
}

async function validateXml(bytes: Buffer, flow: DiscoveredFlow): Promise<void> {
  const parsed: unknown = await parseStringPromise(bytes.toString('utf8'), { explicitArray: true, strict: true });
  if (!object(parsed) || !object(parsed.Flow) || !object(parsed.Flow.$) || parsed.Flow.$.xmlns !== namespace)
    throw new Error('Native XML must have a Salesforce Flow root');
  const metadata = flow.toolingFlow!.Metadata as Record<string, unknown>;
  const start = metadata.start;
  const xmlStart = Array.isArray(parsed.Flow.start) ? (parsed.Flow.start[0] as unknown) : undefined;
  const xmlSegment: unknown = object(xmlStart) && Array.isArray(xmlStart.segment) ? xmlStart.segment[0] : undefined;
  validateSegmentSelection(flow.record.SegmentId, xmlSegment, 'native XML');
  if (object(start) && start.triggerType === 'Segment') {
    if (
      !object(xmlStart) ||
      !Array.isArray(xmlStart.triggerType) ||
      xmlStart.triggerType[0] !== 'Segment' ||
      !Array.isArray(xmlStart.segment) ||
      xmlStart.segment[0] !== start.segment
    )
      throw new Error('Native XML does not retain the discovered Segment trigger/reference');
  }
  const expected = contentReferences(metadata.actionCalls, false);
  const actual = contentReferences(parsed.Flow.actionCalls, true);
  if (expected.length && JSON.stringify(expected.sort()) !== JSON.stringify(actual.sort()))
    throw new Error('Native XML does not retain discovered CMS contentId references');
}

function contentReferences(actions: unknown, xml: boolean): string[] {
  if (actions === undefined) return [];
  if (!Array.isArray(actions)) throw new Error('Malformed native Flow actions');
  return actions.flatMap((action: unknown) => {
    if (!object(action)) throw new Error('Malformed native Flow action');
    const parameters = action.inputParameters;
    if (parameters === undefined) return [];
    if (!Array.isArray(parameters)) throw new Error('Malformed native Flow input parameters');
    return parameters.flatMap((parameter: unknown) => {
      if (!object(parameter)) throw new Error('Malformed native Flow input parameter');
      const name: unknown = xml && Array.isArray(parameter.name) ? parameter.name[0] : parameter.name;
      if (name !== 'contentId') return [];
      const value = xml && Array.isArray(parameter.value) ? (parameter.value[0] as unknown) : parameter.value;
      const reference: unknown = object(value)
        ? xml && Array.isArray(value.stringValue)
          ? value.stringValue[0]
          : value.stringValue
        : undefined;
      if (typeof reference !== 'string' || !reference) throw new Error('Malformed CMS contentId reference');
      return [reference];
    });
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function descendant(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Check all existing ancestors, including Windows reparse types not exposed by Node. */
async function safePath(target: string): Promise<void> {
  if (process.platform === 'win32') {
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; $p=$env:SF_MCNEXT_FLOW_PATH; while ($p) { if (Test-Path -LiteralPath $p) { $i=Get-Item -LiteralPath $p -Force; if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Flow path reparse point rejected' } }; $next=[IO.Path]::GetDirectoryName($p); if ($next -eq $p) { break }; $p=$next }",
      ],
      { env: { ...process.env, SF_MCNEXT_FLOW_PATH: target }, windowsHide: true }
    );
  }
  let current = target;
  while (current) {
    // eslint-disable-next-line no-await-in-loop -- validate every existing ancestor before reading or writing
    if (await exists(current)) {
      // eslint-disable-next-line no-await-in-loop -- symlinks must not redirect provider IO
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Flow path ancestor link rejected');
      if (current !== target && !stat.isDirectory()) throw new Error('Flow path ancestor is not a directory');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
