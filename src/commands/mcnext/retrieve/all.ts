import { resolve } from 'node:path';
import { Messages, SfError } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { retrieveAll, projectRetrieveAllResult, type RetrieveAllPublicResult } from '../../../registry/retrieveAll.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.retrieve.all');

export const retrieveAllServices = { retrieveAll };

export default class RetrieveAll extends SfCommand<RetrieveAllPublicResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['mcn:retrieve:all'];
  public static readonly flags = {
    'target-org': Flags.string({ required: true, summary: messages.getMessage('flags.target-org.summary') }),
    'expected-org-id': Flags.string({ required: true, summary: messages.getMessage('flags.expected-org-id.summary') }),
    'project-dir': Flags.directory({
      required: true,
      exists: true,
      summary: messages.getMessage('flags.project-dir.summary'),
    }),
    'api-version': Flags.string({ default: '67.0', summary: messages.getMessage('flags.api-version.summary') }),
    wait: Flags.integer({ min: 1, max: 30, default: 10, summary: messages.getMessage('flags.wait.summary') }),
  };

  public async run(): Promise<RetrieveAllPublicResult> {
    const { flags } = await this.parse(RetrieveAll);
    if (flags['api-version'] !== '67.0')
      throw new SfError('Retrieve all supports only API 67.0.', 'UnsupportedApiVersion');
    if (!/^00D[A-Za-z0-9]{15}$/u.test(flags['expected-org-id']))
      throw new SfError('Expected org ID must be an exact 18-character Salesforce org ID.', 'InvalidSalesforceId');
    if (!flags['target-org'].trim() || flags['target-org'].startsWith('-') || flags['target-org'].includes('\0'))
      throw new SfError('An explicit org alias or username is required.', 'InvalidTargetOrg');
    // Keep path components visible to the coordinator's fresh non-linked project guard.
    const result = projectRetrieveAllResult(
      await retrieveAllServices.retrieveAll({
        projectRoot: resolve(flags['project-dir']),
        targetOrg: flags['target-org'],
        expectedOrgId: flags['expected-org-id'],
        apiVersion: flags['api-version'],
        waitMinutes: flags.wait,
      })
    );
    const exitCodes = { success: 0, partial: 2, blocked: 1, failed: 1, pending: 69 };
    process.exitCode = exitCodes[result.state];
    this.log(
      `Retrieve all: ${result.state}; complete: false; ${result.files.length} written files. Not a full backup or restore kit.`
    );
    for (const diagnostic of result.diagnostics) this.log(diagnostic);
    for (const file of result.files) this.log(`Written: ${file}`);
    for (const row of result.providers) {
      this.log(`${row.provider} / ${row.family}: ${row.state}; ${row.files.length} written files`);
      for (const diagnostic of row.diagnostics) this.log(diagnostic);
      if (row.stagingDirectory) this.log(`Retained staging: ${row.stagingDirectory}`);
      if (row.retainedRoot) this.log(`Retained temporary root: ${row.retainedRoot}`);
      if (row.jobId) this.log(`Core job: ${row.jobId}`);
      if (row.evidence) this.log(`Evidence: ${JSON.stringify(row.evidence)}`);
    }
    return result;
  }
}
