import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import { McnClient } from '../../../../src/client/mcnClient.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../../../../src/filesystem/runOwnedTemp.js';
import {
  exportIdentityResolutionConfiguration,
  listIdentityResolutions,
  showIdentityResolution,
} from '../../../../src/identityResolution/identityResolution.js';

type RequestOptions = Parameters<McnClient['request']>[0];

const RULESET = {
  id: 'opaque-identity-resolution-id',
  rulesetId: '1iraj000000VkBeAAK',
  label: 'Marketing',
  dataSpaceName: 'default',
  objectApiName: 'ssot__Individual__dlm',
  secondaryDmo: 'ssot__ContactPointEmail__dlm',
  filters: [{ field: 'Status', operator: 'EQUALS', value: 'Active' }],
  matchRules: [{ label: 'Email match', criteria: [{ field: 'Email' }] }],
  reconciliationRules: [
    {
      entityName: 'ssot__Individual__dlm',
      fields: ['ssot__FirstName__c'],
      linkDmoName: 'UnifiedLinkssotIndividualMkt__dlm',
      ruleType: 'SOURCE_PRIORITY',
      shouldIgnoreEmptyValue: true,
      sources: ['ssot__Individual__dlm'],
      unifiedDmoName: 'UnifiedssotIndividualMkt__dlm',
    },
  ],
  rulesetStatus: 'PUBLISHED',
  lastJobStatus: 'SUCCESS',
  lastJobCompleted: '2026-09-12T18:22:18.000Z',
  doesRunAutomatically: true,
  anonymousUnifiedProfiles: 0,
  knownUnifiedProfiles: 504,
  matchedSourceProfiles: 36,
  sourceProfiles: 522,
  totalUnifiedProfiles: 504,
  consolidationRate: 3,
};

function clientWith(handler: (request: RequestOptions) => unknown): McnClient {
  return { request: async (request: RequestOptions) => handler(request) } as McnClient;
}

describe('identity-resolution configuration', () => {
  let run: RunOwnedTemp;
  let directory: string;
  let sentinel: string;

  beforeEach(async () => {
    run = await createRunOwnedTemp('mcnext-identity-resolution');
    directory = await createRunOwnedDirectory(run, 'fixture');
    sentinel = join(run.root, 'sentinel.txt');
    await writeFile(sentinel, 'sibling-survives');
  });

  afterEach(async () => {
    await removeRunOwnedPath(run, directory);
    expect(await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code)).to.equal('ENOENT');
    expect(await readFile(sentinel, 'utf8')).to.equal('sibling-survives');
    await unlink(sentinel);
    await removeRunOwnedRoot(run);
    expect(await lstat(run.root).catch((error: NodeJS.ErrnoException) => error.code)).to.equal('ENOENT');
  });

  it('parses identityResolutions with one request and no invented pagination', async () => {
    const requests: RequestOptions[] = [];
    const client = clientWith((request) => {
      requests.push(request);
      return { identityResolutions: [RULESET] };
    });

    expect(await listIdentityResolutions(client)).to.deep.equal([RULESET]);
    expect(requests).to.deep.equal([{ path: '/ssot/identity-resolutions' }]);
  });

  it('returns a populated identityResolutions array unchanged', async () => {
    const configurations = [RULESET];
    const client = clientWith(() => ({ identityResolutions: configurations }));

    expect(await listIdentityResolutions(client)).to.equal(configurations);
  });

  it('accepts an empty identityResolutions array', async () => {
    const configurations: unknown[] = [];
    const client = clientWith(() => ({ identityResolutions: configurations }));

    expect(await listIdentityResolutions(client)).to.equal(configurations);
  });

  const malformedResponses: Array<{ label: string; response: unknown }> = [
    { label: 'missing collection', response: {} },
    { label: 'null collection', response: { identityResolutions: null } },
    { label: 'undefined collection', response: { identityResolutions: undefined } },
    { label: 'object collection', response: { identityResolutions: {} } },
    { label: 'string collection', response: { identityResolutions: 'invalid' } },
    { label: 'number collection', response: { identityResolutions: 1 } },
    { label: 'boolean collection', response: { identityResolutions: false } },
    { label: 'top-level array', response: [] },
    { label: 'null response', response: null },
    { label: 'undefined response', response: undefined },
    { label: 'string response', response: 'invalid' },
    { label: 'number response', response: 1 },
    { label: 'boolean response', response: false },
  ];

  for (const { label, response } of malformedResponses) {
    it(`rejects ${label} with a deliberate collection-envelope error`, async () => {
      const client = clientWith(() => response);
      let caught: unknown;
      try {
        await listIdentityResolutions(client);
      } catch (error) {
        caught = error;
      }

      expect(caught).to.be.instanceOf(Error);
      expect((caught as Error).message).to.equal(
        'Identity configuration response requires an identityResolutions array'
      );
    });
  }

  it('preserves list transport rejections unchanged', async () => {
    const failure = new Error('Transport failed');
    const client = clientWith(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      await listIdentityResolutions(client);
    } catch (error) {
      caught = error;
    }

    expect(caught).to.equal(failure);
  });

  it('parses the bare detail object by Salesforce ruleset ID', async () => {
    const client = clientWith((request) => {
      expect(request).to.deep.equal({ path: '/ssot/identity-resolutions/1iraj000000VkBeAAK' });
      return RULESET;
    });

    expect(await showIdentityResolution(client, '1iraj000000VkBeAAK')).to.deep.equal(RULESET);
  });

  it('exports the complete ruleset configuration without transforming DMO references or counts', async () => {
    const outputFile = join(directory, 'nested', 'identity-resolution.json');
    const client = clientWith(() => RULESET);

    const result = await exportIdentityResolutionConfiguration(client, '1iraj000000VkBeAAK', outputFile);
    const written = JSON.parse(await readFile(outputFile, 'utf8')) as typeof RULESET;

    expect(result).to.deep.equal(RULESET);
    expect(written.filters).to.deep.equal(RULESET.filters);
    expect(written.matchRules).to.deep.equal(RULESET.matchRules);
    expect(written.reconciliationRules).to.deep.equal(RULESET.reconciliationRules);
    expect(written.rulesetStatus).to.equal('PUBLISHED');
    expect(written.lastJobStatus).to.equal('SUCCESS');
    expect(written.totalUnifiedProfiles).to.equal(504);
    expect(written.sourceProfiles).to.equal(522);
    expect(written.reconciliationRules[0].unifiedDmoName).to.equal('UnifiedssotIndividualMkt__dlm');
    expect(written.reconciliationRules[0].linkDmoName).to.equal('UnifiedLinkssotIndividualMkt__dlm');
  });

  it('preserves ITEM_NOT_FOUND from the client', async () => {
    const missing = Object.assign(new Error('Identity Resolution not found'), { name: 'ITEM_NOT_FOUND' });
    const client = { request: async () => Promise.reject(missing) } as unknown as McnClient;

    let caught: unknown;
    try {
      await showIdentityResolution(client, 'missing');
    } catch (error) {
      caught = error;
    }

    expect(caught).to.equal(missing);
    expect((caught as Error).name).to.equal('ITEM_NOT_FOUND');
  });
});
