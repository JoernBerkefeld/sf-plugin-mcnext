import { Messages } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { runFlow, type FlowResult } from '../../../core/flowCli.js';
import { createFlow, updateFlow } from '../../../core/flowCreate.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-plugin-mcnext', 'mcnext.flow.source');

export default class FlowSource extends SfCommand<FlowResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly flags = {
    operation: Flags.option({
      summary: messages.getMessage('flags.operation.summary'),
      options: ['retrieve', 'validate', 'create', 'update'] as const,
      required: true,
    })(),
    member: Flags.string({ summary: messages.getMessage('flags.member.summary'), multiple: true, required: true }),
    'target-org': Flags.string({ summary: messages.getMessage('flags.target-org.summary'), required: true }),
    'project-dir': Flags.directory({
      summary: messages.getMessage('flags.project-dir.summary'),
      required: true,
      exists: true,
    }),
    'source-file': Flags.string({ summary: messages.getMessage('flags.source-file.summary') }),
    'expected-org-id': Flags.string({ summary: messages.getMessage('flags.expected-org-id.summary') }),
    'expected-definition-id': Flags.string({ summary: messages.getMessage('flags.expected-definition-id.summary') }),
    'expected-latest-version-id': Flags.string({
      summary: messages.getMessage('flags.expected-latest-version-id.summary'),
    }),
    'source-org-id': Flags.string({ summary: messages.getMessage('flags.source-org-id.summary') }),
    'reuse-same-org-references': Flags.boolean({
      summary: messages.getMessage('flags.reuse-same-org-references.summary'),
    }),
    'expect-unchanged': Flags.boolean({ summary: messages.getMessage('flags.expect-unchanged.summary') }),
    wait: Flags.integer({ summary: messages.getMessage('flags.wait.summary'), min: 1, max: 30, default: 10 }),
  };

  public async run(): Promise<FlowResult> {
    const { flags } = await this.parse(FlowSource);
    const mutation = flags.operation === 'create' || flags.operation === 'update';
    if (mutation && (flags.member.length !== 1 || !flags['source-file'] || !flags['expected-org-id']))
      throw new Error('CREATE/UPDATE requires one exact member, source-file and expected-org-id');
    if (
      !mutation &&
      [flags['source-file'], flags['expected-org-id'], flags['source-org-id'], flags['reuse-same-org-references']].some(
        Boolean
      )
    )
      throw new Error('Mutation flags require operation create or update');
    if (
      flags.operation !== 'update' &&
      (flags['expected-definition-id'] !== undefined ||
        flags['expected-latest-version-id'] !== undefined ||
        flags['expect-unchanged'] === true)
    )
      throw new Error('Target baseline flags require operation update');
    const selection = {
      member: flags.member[0],
      sourceFile: flags['source-file']!,
      sourceOrgId: flags['source-org-id'] ?? '',
      reuseSameOrgReferences: flags['reuse-same-org-references'],
      expectedOrgId: flags['expected-org-id']!,
      targetOrg: flags['target-org'],
      projectRoot: flags['project-dir'],
      waitMinutes: flags.wait,
    };
    let result: FlowResult;
    if (flags.operation === 'update')
      result = await updateFlow({
        ...selection,
        expectedDefinitionId: flags['expected-definition-id'] ?? '',
        expectedLatestVersionId: flags['expected-latest-version-id'] ?? '',
        expectUnchanged: flags['expect-unchanged'],
      });
    else if (flags.operation === 'create') result = await createFlow(selection);
    else
      result = await runFlow({
        operation: flags.operation,
        members: flags.member,
        targetOrg: flags['target-org'],
        projectRoot: flags['project-dir'],
        waitMinutes: flags.wait,
      });
    if (result.state === 'pending') process.exitCode = 69;
    this.log(`${result.operation}: ${result.state}; Core job ${result.jobId}; runtime readiness not assessed`);
    for (const diagnostic of result.diagnostics ?? []) this.log(JSON.stringify(diagnostic));
    return result;
  }
}
