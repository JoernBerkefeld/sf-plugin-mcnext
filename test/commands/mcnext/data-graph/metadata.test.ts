import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import DataGraphMetadata from '../../../../src/commands/mcnext/data-graph/metadata.js';

describe('mcnext data-graph metadata', () => {
  const $$ = new TestContext();
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mcnext-data-graph-'));
  });

  afterEach(async () => {
    $$.restore();
    await rm(directory, { force: true, recursive: true });
  });

  it('performs one authenticated read against the exact metadata endpoint', async () => {
    const tokenFile = join(directory, 'token.txt');
    await writeFile(tokenFile, 'private-token\n');
    const fetchStub = $$.SANDBOX.stub(globalThis, 'fetch').resolves(
      new Response(JSON.stringify({ dataGraphs: [{ name: 'CustomerGraph' }] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    );
    const command = Object.create(DataGraphMetadata.prototype) as DataGraphMetadata;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: { 'instance-url': new URL('https://tenant.example.com'), 'access-token-file': tokenFile },
      }),
    });

    const result = await command.run();
    expect(result).to.deep.equal({ dataGraphs: [{ name: 'CustomerGraph' }] });
    expect(fetchStub.calledOnce).to.equal(true);
    expect(String(fetchStub.firstCall.args[0])).to.equal('https://tenant.example.com/api/v1/dataGraph/metadata');
    expect(fetchStub.firstCall.args[1]).to.deep.equal({ headers: { authorization: 'Bearer private-token' } });
  });
});
