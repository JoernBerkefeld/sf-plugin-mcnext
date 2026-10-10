import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  preparePortableRetrieval,
  assertPortableRetrievalSidecar,
  writePreparedPortableRetrieval,
} from '../../src/capabilities/retrievalPersistence.js';
import {
  createResolutionCache,
  refreshResolutionCache,
  type ResolutionCacheScope,
  type TargetedResolutionRequest,
} from '../../src/capabilities/resolutionCache.js';
import { METADATA_CAPABILITY_CONTRACT, METADATA_CAPABILITY_FIXTURE_SHA256 } from '../../src/capabilities/contracts.js';
import {
  createRunOwnedTemp,
  createRunOwnedDirectory,
  removeRunOwnedPath,
  removeRunOwnedRoot,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';

const campaignScope: ResolutionCacheScope = {
  sourceOrgId: '00D000000000001AAA',
  targetOrgId: '00D000000000002AAA',
  provider: 'sf-plugin-mcnext',
  apiVersion: '66.0',
  capabilityContract: METADATA_CAPABILITY_CONTRACT,
  capabilityFixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
  declaration: { type: 'Campaign', profile: 'relationship-free-scalar-resolver' },
  nativeContext: { packageDirectory: 'custom-source' },
};

function campaign(): TargetedResolutionRequest {
  return {
    kind: 'Campaign',
    source: {
      portableName: 'Autumn Campaign',
      context: { businessUnitApiName: 'north' },
      records: [
        {
          serverId: '701000000000001AAA',
          portableName: 'Autumn Campaign',
          context: { businessUnitApiName: 'north' },
          relationships: {
            ParentId: null,
            RecordTypeId: null,
            BriefId: null,
            CampaignImageId: null,
            CampaignMemberRecordTypeId: null,
          },
        },
      ],
      totalSize: 1,
      queryDone: true,
      completion: {
        strategy: 'targeted',
        completionProof: 'exact scalar record match',
        calls: 1,
        items: 1,
        pages: 1,
        complete: true,
      },
    },
  };
}

function dataSpace(): TargetedResolutionRequest {
  return {
    kind: 'Data Space',
    source: {
      DataSpaceApiName: 'customer_data',
      records: [{ serverId: '0vh000000000001AAA', DataSpaceApiName: 'customer_data' }],
      totalSize: 1,
      queryDone: true,
      completion: {
        strategy: 'retrieve-all',
        completionProof: 'complete bounded Data Space inventory',
        calls: 1,
        items: 1,
        pages: 1,
        complete: true,
      },
    },
  };
}

function dataSpaceScope(): ResolutionCacheScope {
  return {
    ...campaignScope,
    declaration: { type: 'Data Space', profile: 'scope-identity-resolver' },
    nativeContext: { dataSpaceApiName: 'customer_data' },
  };
}

async function rejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
    expect.fail('expected rejection');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}

async function cleanup(run: RunOwnedTemp, paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => removeRunOwnedPath(run, path)));
  await unlink(join(run.root, 'sfdx-project.json')).catch(() => undefined);
  await removeRunOwnedRoot(run);
}

describe('portable retrieval pre-persistence integration', () => {
  it('keeps Campaign sidecars beside artifacts in the configured package root and preserves strict artifacts', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-retrieval');
    try {
      await writeFile(
        join(run.root, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: 'custom-source' }] })
      );
      await createRunOwnedDirectory(run, 'custom-source');
      const artifact = join(run.root, 'custom-source', 'main', 'default', 'campaigns', 'Autumn.json');
      await mkdir(join(run.root, 'custom-source', 'main', 'default', 'campaigns'), { recursive: true });
      const strictBytes = '{"sourceId":"701000000000001AAA","fields":{"Name":"Autumn Campaign"}}\n';
      await writeFile(artifact, strictBytes);
      const request = campaign();
      const prepared = await preparePortableRetrieval({
        projectRoot: run.root,
        nativeArtifactPath: artifact,
        request,
        cache: createResolutionCache(campaignScope),
        load: async () => request,
        observedAt: '2026-10-02T10:00:00.000Z',
      });
      expect(prepared.destination).to.equal(`${artifact}.portable.json`);
      assertPortableRetrievalSidecar(prepared.sidecar);
      for (const bad of [
        { ...prepared.sidecar, extra: true },
        { ...prepared.sidecar, version: '2.0.0' },
        { ...prepared.sidecar, contentHash: '0'.repeat(64) },
      ])
        expect(() => assertPortableRetrievalSidecar(bad)).to.throw();
      expect(prepared.cacheHit).to.equal(false);
      expect(prepared.report.metrics).to.deep.equal({
        cacheHits: 0,
        cacheMisses: 1,
        cacheRefreshes: 1,
        loaderCalls: 1,
        evidenceCalls: 1,
        evidenceItems: 1,
        evidencePages: 1,
      });
      expect(prepared.bytes).not.to.include('701000000000001AAA');
      await writePreparedPortableRetrieval(prepared);
      expect(await readFile(artifact, 'utf8')).to.equal(strictBytes);
      expect(JSON.parse(await readFile(prepared.destination, 'utf8'))).to.deep.include({
        role: 'artifact-identity',
        deployableDefinition: false,
      });
    } finally {
      await cleanup(run, [join(run.root, 'custom-source')]);
    }
  });

  it('uses an exact cache hit before loading evidence and serializes deterministically', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-retrieval');
    try {
      await writeFile(join(run.root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'pkg' }] }));
      await createRunOwnedDirectory(run, 'pkg');
      const request = campaign();
      const cache = await refreshResolutionCache(
        createResolutionCache(campaignScope),
        [request],
        async () => request,
        '2026-10-02T10:00:00.000Z'
      );
      let calls = 0;
      const options = {
        projectRoot: run.root,
        nativeArtifactPath: 'pkg/Campaign.json',
        request,
        cache,
        load: async () => {
          calls += 1;
          return request;
        },
        observedAt: '2026-10-02T11:00:00.000Z',
      };
      const first = await preparePortableRetrieval(options);
      const second = await preparePortableRetrieval(options);
      expect(calls).to.equal(0);
      expect(first.cacheHit).to.equal(true);
      expect(first.bytes).to.equal(second.bytes);
      expect(first.report).to.deep.equal(second.report);
      expect(first.report.metrics).to.deep.equal({ cacheHits: 1, cacheMisses: 0, cacheRefreshes: 0, loaderCalls: 0 });
      expect(first.sidecar.contentHash).to.match(/^[a-f0-9]{64}$/);
    } finally {
      await cleanup(run, [join(run.root, 'pkg')]);
    }
  });

  for (const failure of ['relationships', 'incomplete'] as const) {
    it(`rejects cached Campaign reuse when current ${failure} evidence changed`, async () => {
      const run = await createRunOwnedTemp('sf-mcnext-retrieval');
      try {
        await writeFile(join(run.root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'pkg' }] }));
        await createRunOwnedDirectory(run, 'pkg');
        const original = campaign();
        const cache = await refreshResolutionCache(
          createResolutionCache(campaignScope),
          [original],
          async () => original,
          '2026-10-02T10:00:00.000Z'
        );
        const request = campaign();
        if (request.kind !== 'Campaign') throw new Error('expected Campaign request');
        if (failure === 'relationships') request.source.records[0].relationships.ParentId = '701000000000002AAA';
        else request.source.completion.complete = false;
        let calls = 0;
        await rejects(
          () =>
            preparePortableRetrieval({
              projectRoot: run.root,
              nativeArtifactPath: 'pkg/Campaign.json',
              request,
              cache,
              load: async (current) => {
                expect(current).to.equal(request);
                calls += 1;
                return current;
              },
              observedAt: '2026-10-02T11:00:00.000Z',
            }),
          failure === 'relationships' ? 'relationships' : 'completion'
        );
        expect(calls).to.equal(1);
        await rejects(() => readFile(join(run.root, 'pkg', 'Campaign.json.portable.json'), 'utf8'), 'ENOENT');
      } finally {
        await cleanup(run, [join(run.root, 'pkg')]);
      }
    });
  }

  it('refreshes only the exact cached Campaign root when its source fingerprint changes', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-retrieval');
    try {
      await writeFile(join(run.root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'pkg' }] }));
      await createRunOwnedDirectory(run, 'pkg');
      const original = campaign();
      const cache = await refreshResolutionCache(
        createResolutionCache(campaignScope),
        [original],
        async () => original,
        '2026-10-02T10:00:00.000Z'
      );
      const request = campaign();
      if (request.kind !== 'Campaign') throw new Error('expected Campaign request');
      request.source.records[0].serverId = '701000000000002AAA';
      let calls = 0;
      const prepared = await preparePortableRetrieval({
        projectRoot: run.root,
        nativeArtifactPath: 'pkg/Campaign.json',
        request,
        cache,
        load: async (current) => {
          expect(current).to.equal(request);
          calls += 1;
          return current;
        },
        observedAt: '2026-10-02T11:00:00.000Z',
      });
      expect(calls).to.equal(1);
      expect(prepared.cacheHit).to.equal(false);
      expect(prepared.cache.entries).to.have.length(1);
      expect(prepared.cache.entries[0].sourceHash).not.to.equal(cache.entries[0].sourceHash);
      expect(prepared.cache.entries[0].evidenceIdentity.value).to.equal('701000000000002AAA');
    } finally {
      await cleanup(run, [join(run.root, 'pkg')]);
    }
  });

  it('writes Data Space resolver metadata only below its data360 scope without claiming transport', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-retrieval');
    try {
      await createRunOwnedDirectory(run, 'data360');
      const request = dataSpace();
      const prepared = await preparePortableRetrieval({
        projectRoot: run.root,
        request,
        cache: createResolutionCache(dataSpaceScope()),
        load: async () => request,
        observedAt: '2026-10-02T10:00:00.000Z',
      });
      expect(prepared.destination).to.equal(join(run.root, 'data360', 'customer_data', 'portable-identity.json'));
      expect(prepared.sidecar).to.deep.include({ role: 'resolver-scope-only', deployableDefinition: false });
      expect(prepared.bytes).not.to.include('0vh000000000001AAA');
      await writePreparedPortableRetrieval(prepared);
    } finally {
      await cleanup(run, [join(run.root, 'data360')]);
    }
  });

  it('publishes nothing when root validation or bounded evidence fails', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-retrieval');
    try {
      await writeFile(join(run.root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'pkg' }] }));
      await createRunOwnedDirectory(run, 'pkg');
      const related = campaign();
      if (related.kind !== 'Campaign') throw new Error('expected Campaign request');
      related.source.records[0].relationships.ParentId = '701000000000002AAA';
      const destination = join(run.root, 'pkg', 'Campaign.json.portable.json');
      await rejects(
        () =>
          preparePortableRetrieval({
            projectRoot: run.root,
            nativeArtifactPath: 'pkg/Campaign.json',
            request: related,
            cache: createResolutionCache(campaignScope),
            load: async () => related,
            observedAt: '2026-10-02T10:00:00.000Z',
          }),
        'relationships'
      );
      await rejects(() => readFile(destination, 'utf8'), 'ENOENT');

      const incomplete = dataSpace();
      if (incomplete.kind !== 'Data Space') throw new Error('expected Data Space request');
      incomplete.source.records[0].DataSpaceApiName = null;
      await rejects(
        () =>
          preparePortableRetrieval({
            projectRoot: run.root,
            request: incomplete,
            cache: createResolutionCache(dataSpaceScope()),
            load: async () => incomplete,
            observedAt: '2026-10-02T10:00:00.000Z',
          }),
        'DataSpaceApiName'
      );
      await rejects(
        () => readFile(join(run.root, 'data360', 'customer_data', 'portable-identity.json'), 'utf8'),
        'ENOENT'
      );
    } finally {
      await cleanup(run, [join(run.root, 'pkg')]);
    }
  });

  it('rejects Campaign output outside configured package directories before publication', async () => {
    const run = await createRunOwnedTemp('sf-mcnext-retrieval');
    try {
      await writeFile(
        join(run.root, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: 'custom-source' }] })
      );
      await createRunOwnedDirectory(run, 'custom-source');
      const request = campaign();
      await rejects(
        () =>
          preparePortableRetrieval({
            projectRoot: run.root,
            nativeArtifactPath: 'force-app/Campaign.json',
            request,
            cache: createResolutionCache(campaignScope),
            load: async () => request,
            observedAt: '2026-10-02T10:00:00.000Z',
          }),
        'configured Salesforce package directory'
      );
    } finally {
      await cleanup(run, [join(run.root, 'custom-source')]);
    }
  });
});
