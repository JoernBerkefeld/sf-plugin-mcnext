import filesystem, { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection, Org } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import { McnClient } from '../../src/client/mcnClient.js';
import { createRunOwnedDirectory, createRunOwnedTemp, type RunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import {
  retrieveIdentityConfiguration,
  type IdentityConfigurationInput,
  type IdentityConfigurationServices,
} from '../../src/registry/retrieveData360.js';

const collection = {
  identityResolutions: [
    {
      id: '1iraj000000VkBeAAK',
      rulesetId: 'MKT',
      configurationType: 'Individual',
      dataSpaceName: 'default',
      objectApiName: 'ssot__Individual__dlm',
      filters: [{ field: 'Status', value: null }],
      matchRules: [{ criteria: [{ fieldName: 'Email', matchMethodType: 'exactnormalized' }] }],
      reconciliationRules: [{ unifiedDmoName: 'UnifiedIndividual__dlm', linkDmoName: 'IndividualIdentityLink__dlm' }],
      rulesetStatus: 'PUBLISHED',
      totalUnifiedProfiles: 12,
      doesRunAutomatically: true,
    },
  ],
  additionalProviderField: { unchanged: true },
};

describe('aggregate identity configuration retrieval', () => {
  let owner: RunOwnedTemp;
  let input: IdentityConfigurationInput;
  let services: IdentityConfigurationServices;
  let response: unknown;
  let org: Org;
  let request: sinon.SinonStub;
  let createOrg: sinon.SinonStub;
  let createClient: sinon.SinonStub;
  let destination: string;

  before(async () => {
    owner = await createRunOwnedTemp('mcnext-data360-tests');
  });
  beforeEach(async () => {
    const projectRoot = await createRunOwnedDirectory(owner, `project-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(projectRoot, 'native'));
    await writeFile(join(projectRoot, 'native', 'sentinel'), 'native\r\nbytes');
    await writeFile(
      join(projectRoot, 'sfdx-project.json'),
      '{"packageDirectories":[{"path":"native","default":true}]}\n'
    );
    input = { projectRoot, targetOrg: 'selected-alias', expectedOrgId: '00DSelected', apiVersion: '67.0' };
    destination = join(projectRoot, 'data', 'identity-resolution.json');
    response = structuredClone(collection);
    org = { getOrgId: () => '00DSelected' } as Org;
    request = sinon.stub().callsFake(async () => response);
    createOrg = sinon.stub().resolves(org);
    createClient = sinon.stub().resolves({ apiVersion: '67.0', request } as unknown as McnClient);
    services = { createOrg, createClient };
  });
  afterEach(async () => {
    sinon.restore();
    expect(await readFile(join(input.projectRoot, 'native', 'sentinel'), 'utf8')).to.equal('native\r\nbytes');
    expect(await readFile(join(input.projectRoot, 'sfdx-project.json'), 'utf8')).to.equal(
      '{"packageDirectories":[{"path":"native","default":true}]}\n'
    );
  });
  // Retain isolated OS-temp fixtures; no project deletion or rollback.

  it('binds the actual context, GET and original collection without transforming native fields', async () => {
    const result = await retrieveIdentityConfiguration(input, services);
    expect(result.state).to.equal('success');
    expect(result.files).to.deep.equal([destination]);
    expect(result.result).to.equal(response);
    expect(createOrg.firstCall.args).to.deep.equal(['selected-alias']);
    expect(createClient.firstCall.args).to.deep.equal([org, '67.0']);
    expect(request.firstCall.args).to.deep.equal([{ path: '/ssot/identity-resolutions', method: 'GET' }]);
    expect(request.callCount).to.equal(1);
    expect(await readFile(destination, 'utf8')).to.equal(`${JSON.stringify(response, undefined, 2)}\n`);
    expect(Object.keys(result).sort()).to.deep.equal(['diagnostics', 'files', 'result', 'state']);
    expect(result.diagnostics.join(' ')).to.include('native Data360 backup and restore are unqualified');
  });

  it('uses the real McnClient org connection and versioned transport by default', async () => {
    const transport = sinon.stub().resolves(response);
    const connection = { request: transport, retrieveMaxApiVersion: async () => '67.0' } as unknown as Connection;
    const getConnection = sinon.stub().returns(connection);
    const actualOrg = { getOrgId: () => input.expectedOrgId, getConnection } as unknown as Org;
    const result = await retrieveIdentityConfiguration(input, { createOrg: async () => actualOrg });
    expect(result.state).to.equal('success');
    expect(getConnection.args).to.deep.equal([[], ['67.0']]);
    expect(transport.firstCall.args).to.deep.equal([
      {
        method: 'GET',
        url: '/services/data/v67.0/ssot/identity-resolutions',
        headers: { 'Content-Type': 'application/json' },
      },
    ]);
  });

  it('accepts a fulfilled empty collection, not complete native backup', async () => {
    response = { identityResolutions: [] };
    expect((await retrieveIdentityConfiguration(input, services)).state).to.equal('success');
    expect(JSON.parse(await readFile(destination, 'utf8'))).to.deep.equal(response);
  });

  for (const [name, rows] of [
    ['official id-only schema', [{ id: '1ir1Q0000004CKHQA2', matchRules: [], unknownField: { retained: true } }]],
    [
      'retained live row shapes',
      [
        { id: '1iraj000000UiAIAA0', unknownField: null },
        { id: '1iraj000000UiF8AAK', rulesetId: 'mce', unknownField: ['retained'] },
        { id: '1iraj000000UiKGAA0', rulesetId: 'MC', unknownField: { retained: true } },
        { id: '1iraj000000VkBeAAK', rulesetId: 'MKT', unknownField: false },
      ],
    ],
    ['valid id without a prefix restriction', [{ id: '0Ii000000000001AAA', rulesetId: 'suffix' }]],
  ] as Array<[string, unknown[]]>) {
    it(`preserves ${name} without fallback, synthesis or mutation`, async () => {
      response = { identityResolutions: rows, unknownEnvelope: { retained: true } };
      const before = JSON.stringify(response, undefined, 2);
      const result = await retrieveIdentityConfiguration(input, services);
      expect(result.state).to.equal('success');
      expect(result.result).to.equal(response);
      expect(JSON.stringify(response, undefined, 2)).to.equal(before);
      expect(await readFile(destination, 'utf8')).to.equal(`${before}\n`);
      expect(request.callCount).to.equal(1);
    });
  }

  for (const [name, value] of [
    ['missing array', {}],
    ['null response', null],
    ['array response', []],
    ['non-array collection', { identityResolutions: {} }],
    ['non-object row', { identityResolutions: [null] }],
    ['missing id', { identityResolutions: [{}] }],
    ['non-string id', { identityResolutions: [{ id: 123 }] }],
    ['null id', { identityResolutions: [{ id: null }] }],
    ['malformed id', { identityResolutions: [{ id: '../escape' }] }],
    ['short id', { identityResolutions: [{ id: '1iraj000000VkBeA' }] }],
    ['long id', { identityResolutions: [{ id: '1iraj000000VkBeAAK0' }] }],
    ['non-alphanumeric id', { identityResolutions: [{ id: '1iraj000000VkBeAA!' }] }],
    ['valid rulesetId without id', { identityResolutions: [{ rulesetId: '1iraj000000VkBeAAK' }] }],
    [
      'valid rulesetId with invalid id',
      { identityResolutions: [{ id: 'opaque-provider-id', rulesetId: '1iraj000000VkBeAAK' }] },
    ],
    [
      'duplicate identity',
      { identityResolutions: [collection.identityResolutions[0], collection.identityResolutions[0]] },
    ],
    [
      'case-conflicting identity',
      { identityResolutions: [collection.identityResolutions[0], { id: '1IRAJ000000VKBEAAK', rulesetId: 'other' }] },
    ],
  ] as Array<[string, unknown]>) {
    it(`blocks ${name} before any project writes`, async () => {
      response = value;
      const result = await retrieveIdentityConfiguration(input, services);
      expect(result.state).to.equal('blocked');
      expect(result.files).to.deep.equal([]);
      expect(result.result).to.equal(undefined);
      expect(request.callCount).to.equal(1);
      if (name.includes('id') || name.includes('identity')) {
        expect(result.diagnostics.join(' ')).to.include('Salesforce id');
        expect(result.diagnostics.join(' ')).not.to.include('Salesforce rulesetId');
      }
      expect(await readdir(input.projectRoot)).to.deep.equal(['native', 'sfdx-project.json']);
    });
  }

  it('blocks mismatched fresh org without creating a client or requesting data', async () => {
    org.getOrgId = () => '00DOther';
    expect((await retrieveIdentityConfiguration(input, services)).state).to.equal('blocked');
    expect(createClient.called).to.equal(false);
    expect(request.called).to.equal(false);
  });
  it('blocks unsupported API and invalid project before provider calls', async () => {
    input.apiVersion = '66.0';
    expect((await retrieveIdentityConfiguration(input, services)).state).to.equal('blocked');
    input.apiVersion = '67.0';
    await writeFile(join(input.projectRoot, 'sfdx-project.json'), '{"packageDirectories":[{"path":"native"}]}');
    expect((await retrieveIdentityConfiguration(input, services)).state).to.equal('blocked');
    expect(createOrg.called).to.equal(false);
    await writeFile(
      join(input.projectRoot, 'sfdx-project.json'),
      '{"packageDirectories":[{"path":"native","default":true}]}\n'
    );
  });
  it('blocks client provenance/version mismatch', async () => {
    createClient.resolves({ apiVersion: '66.0', request });
    expect((await retrieveIdentityConfiguration(input, services)).state).to.equal('blocked');
    expect(request.called).to.equal(false);
  });
  it('blocks authentication failure and redacts secrets', async () => {
    createOrg.rejects(new Error('token=auth-secret'));
    const result = await retrieveIdentityConfiguration(input, services);
    expect(result.state).to.equal('blocked');
    expect(JSON.stringify(result)).not.to.include('auth-secret');
    expect(request.called).to.equal(false);
  });
  it('reports provider failure, preserving its safe error code and no auth context', async () => {
    request.rejects(new Error('INVALID_SESSION_ID Authorization: Bearer transport-secret'));
    const result = await retrieveIdentityConfiguration(input, services);
    expect(result.state).to.equal('failed');
    expect(result.files).to.deep.equal([]);
    expect(result.diagnostics.join(' ')).to.include('INVALID_SESSION_ID');
    expect(JSON.stringify(result)).not.to.include('transport-secret');
  });
  it('preserves an existing sentinel and never replaces it', async () => {
    await mkdir(join(input.projectRoot, 'data'));
    await writeFile(destination, 'original bytes\r\n');
    expect((await retrieveIdentityConfiguration(input, services)).state).to.equal('blocked');
    expect(await readFile(destination, 'utf8')).to.equal('original bytes\r\n');
    expect(request.called).to.equal(false);
  });
  it('rejects case aliases before provider effects on every platform', async () => {
    await mkdir(join(input.projectRoot, 'DATA'));
    expect((await retrieveIdentityConfiguration(input, services)).state).to.equal('blocked');
    expect(request.called).to.equal(false);
  });
  it('rejects output junctions/links without writes to their targets', async () => {
    const outside = await createRunOwnedDirectory(owner, `outside-${Math.random().toString(16).slice(2)}`);
    await symlink(outside, join(input.projectRoot, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await retrieveIdentityConfiguration(input, services)).state).to.equal('blocked');
    expect(await readdir(outside)).to.deep.equal([]);
    expect(request.called).to.equal(false);
  });
  it('rechecks the destination after GET and preserves raced-in output', async () => {
    request.callsFake(async () => {
      await mkdir(join(input.projectRoot, 'data'));
      await writeFile(destination, 'raced sentinel');
      return response;
    });
    const result = await retrieveIdentityConfiguration(input, services);
    expect(result.state).to.equal('blocked');
    expect(result.result).to.equal(response);
    expect(result.files).to.deep.equal([]);
    expect(await readFile(destination, 'utf8')).to.equal('raced sentinel');
  });
  for (const failure of ['open', 'write', 'close']) {
    it(`reports ${failure} failure and never lists an unclosed/unwritten path`, async () => {
      const original = filesystem.open;
      sinon.stub(filesystem, 'open').callsFake(async (...args: Parameters<typeof filesystem.open>) => {
        if (failure === 'open') throw new Error('exclusive open failed');
        const handle = await original(...args);
        if (failure === 'write') sinon.stub(handle, 'writeFile').rejects(new Error('write failed'));
        if (failure === 'close') {
          const close = handle.close.bind(handle);
          sinon.stub(handle, 'close').callsFake(async () => {
            await close();
            throw new Error('close failed');
          });
        }
        return handle;
      });
      const result = await retrieveIdentityConfiguration(input, services);
      expect(result.state).to.equal('failed');
      expect(result.files).to.deep.equal([]);
      expect(result.result).to.equal(response);
      expect(result.diagnostics.join(' ')).to.include('Attempted output: data/identity-resolution.json');
    });
  }
});
