import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { runCampaign, type CampaignArtifact, type CampaignResult } from '../../../core/campaignCli.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.campaign.config');

export default class CampaignConfig extends SfCommand<CampaignResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly flags = {
    operation: Flags.option({
      summary: messages.getMessage('flags.operation.summary'),
      options: ['export', 'create', 'update'] as const,
      required: true,
    })(),
    'target-org': Flags.string({ summary: messages.getMessage('flags.target-org.summary'), required: true }),
    'expected-org-id': Flags.string({ summary: messages.getMessage('flags.expected-org-id.summary'), required: true }),
    'api-version': Flags.string({ summary: messages.getMessage('flags.api-version.summary'), required: true }),
    'project-dir': Flags.directory({
      summary: messages.getMessage('flags.project-dir.summary'),
      required: true,
      exists: true,
    }),
    'record-id': Flags.string({ summary: messages.getMessage('flags.record-id.summary') }),
    'expected-name': Flags.string({ summary: messages.getMessage('flags.expected-name.summary') }),
    'target-name': Flags.string({ summary: messages.getMessage('flags.target-name.summary') }),
    'input-file': Flags.string({ summary: messages.getMessage('flags.input-file.summary') }),
    'output-file': Flags.string({ summary: messages.getMessage('flags.output-file.summary') }),
    'journal-file': Flags.string({ summary: messages.getMessage('flags.journal-file.summary') }),
  };

  public async run(): Promise<CampaignResult> {
    const { flags: f } = await this.parse(CampaignConfig);
    if (f.operation === 'export' ? !f['output-file'] || f['input-file'] : !f['input-file'] || f['output-file'])
      throw new Error('Export requires output-file only; mutations require input-file only');
    const result = await runCampaign({
      operation: f.operation,
      projectRoot: f['project-dir'],
      targetOrg: f['target-org'],
      expectedOrgId: f['expected-org-id'],
      apiVersion: f['api-version'],
      recordId: f['record-id'],
      expectedName: f['expected-name'],
      targetName: f['target-name'],
      journalFile: f['journal-file'],
      artifact: f['input-file']
        ? (JSON.parse(await readFile(resolve(f['project-dir'], f['input-file']), 'utf8')) as CampaignArtifact)
        : undefined,
    });
    if (f['output-file'])
      await writeFile(resolve(f['project-dir'], f['output-file']), JSON.stringify(result.artifact, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    this.log(`${result.operation}: ${result.targetId}`);
    return result;
  }
}
