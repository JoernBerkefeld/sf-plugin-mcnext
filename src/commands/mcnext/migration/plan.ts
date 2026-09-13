import { readFile } from 'node:fs/promises';
import { Messages, Org, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import {
  buildMigrationPlan,
  OpaqueCmsDependency,
  runMigrationPreflight,
  writeMigrationPlan,
} from '../../../migration/migrationPlan.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.migration.plan');

export type MigrationPlanResult = {
  outputFile: string;
  sourceOrgId: string;
  targetOrgId: string;
  preflightPassed: boolean;
  inventoryItems: number;
  deferredCmsDependencies: number;
  readOnly: true;
};

export default class MigrationPlanCommand extends SfCommand<MigrationPlanResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:migration:plan'];

  public static readonly flags = {
    'source-org': Flags.string({
      required: true,
      summary: messages.getMessage('flags.source-org.summary'),
    }),
    'target-org': Flags.string({
      // eslint-disable-next-line sf-plugin/dash-o -- target-org convention intentionally uses -o
      char: 'o',
      required: true,
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'output-file': Flags.string({
      required: true,
      summary: messages.getMessage('flags.output-file.summary'),
    }),
    'cms-evidence-file': Flags.string({
      summary: messages.getMessage('flags.cms-evidence-file.summary'),
    }),
  };

  public async run(): Promise<MigrationPlanResult> {
    const { flags } = await this.parse(MigrationPlanCommand);
    const source = await Org.create({ aliasOrUsername: flags['source-org'] });
    const target = await Org.create({ aliasOrUsername: flags['target-org'] });
    const preflight = await runMigrationPreflight(source, target);
    const deferredCmsDependencies = flags['cms-evidence-file']
      ? await readCmsEvidence(flags['cms-evidence-file'])
      : [];
    const plan = buildMigrationPlan({
      sourceOrgId: source.getOrgId(),
      targetOrgId: target.getOrgId(),
      preflight,
      deferredCmsDependencies,
    });

    await writeMigrationPlan(plan, flags['output-file']);
    this.table({ data: preflight, title: 'Migration prerequisite preflight' });

    const blocked = preflight.filter((check) => check.status === 'blocked');
    if (blocked.length > 0) {
      this.warn(messages.getMessage('warnings.blocked', [blocked.length]));
    }

    return {
      outputFile: flags['output-file'],
      sourceOrgId: plan.sourceOrgId,
      targetOrgId: plan.targetOrgId,
      preflightPassed: blocked.length === 0,
      inventoryItems: plan.inventory.length,
      deferredCmsDependencies: plan.deferredCmsDependencies.length,
      readOnly: true,
    };
  }
}

async function readCmsEvidence(file: string): Promise<OpaqueCmsDependency[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    throw new SfError(`Could not read CMS evidence file ${file}: ${(error as Error).message}`, 'InvalidCmsEvidenceError');
  }

  if (!Array.isArray(parsed) || !parsed.every(isOpaqueCmsDependency)) {
    throw new SfError(
      'CMS evidence must be an array containing only owner, status, sourceReference, and blockedOperation strings.',
      'InvalidCmsEvidenceError'
    );
  }
  return parsed;
}

function isOpaqueCmsDependency(value: unknown): value is OpaqueCmsDependency {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'blockedOperation,owner,sourceReference,status' &&
    record.owner === 'cms-service' &&
    record.status === 'deferred: cms-service-contract' &&
    typeof record.sourceReference === 'string' &&
    typeof record.blockedOperation === 'string'
  );
}
