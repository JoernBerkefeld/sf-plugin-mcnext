import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  createResolutionCache,
  createResolutionCacheEntry,
  lookupPortableIdentity,
  lookupServerIdentity,
  readResolutionCache,
  refreshResolutionCache,
  serializeResolutionCache,
  writeResolutionCache,
  type ResolutionCacheScope,
  type TargetedResolutionRequest,
} from '../../src/capabilities/resolutionCache.js';
import { METADATA_CAPABILITY_CONTRACT, METADATA_CAPABILITY_FIXTURE_SHA256 } from '../../src/capabilities/contracts.js';
import { createRunOwnedTemp, removeRunOwnedRoot } from '../../src/filesystem/runOwnedTemp.js';

const scope: ResolutionCacheScope = {
  sourceOrgId: '00D000000000001AAA',
  targetOrgId: '00D000000000002AAA',
  provider: 'sf-plugin-mcnext',
  apiVersion: '66.0',
  capabilityContract: METADATA_CAPABILITY_CONTRACT,
  capabilityFixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
  declaration: { type: 'Campaign', profile: 'relationship-free-scalar-resolver' },
  nativeContext: { coreContext: 'marketing' },
};

function campaign(name = 'Autumn Campaign', serverId = '701000000000001AAA'): TargetedResolutionRequest {
  return {
    kind: 'Campaign',
    source: {
      portableName: name,
      context: { businessUnitApiName: 'north' },
      records: [
        {
          serverId,
          portableName: name,
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

async function rejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
    expect.fail('expected rejection');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}

function withEntry(request = campaign()) {
  const entry = createResolutionCacheEntry(request);
  return refreshResolutionCache(
    createResolutionCache(scope),
    [request],
    async () => request,
    '2026-10-02T10:00:00.000Z'
  ).then((cache) => ({ cache, entry }));
}

describe('targeted resolution cache', () => {
  it('round-trips deterministically and supports bidirectional exact lookup', async () => {
    const { cache, entry } = await withEntry();
    const reversed = {
      ...cache,
      entries: [...cache.entries].reverse(),
      observations: [...cache.observations].reverse(),
    };
    expect(serializeResolutionCache(cache)).to.equal(serializeResolutionCache(reversed));
    expect(lookupServerIdentity(cache, entry.portableIdentity)).to.deep.equal(entry.evidenceIdentity);
    expect(lookupPortableIdentity(cache, entry.evidenceIdentity)).to.deep.equal(entry.portableIdentity);

    const run = await createRunOwnedTemp('sf-mcnext-cache-test');
    const path = join(run.root, 'cache.json');
    await writeResolutionCache(run.root, path, cache);
    const loaded = await readResolutionCache(run.root, path, scope);
    expect(loaded).to.deep.equal(cache);
    await writeResolutionCache(run.root, path, {
      ...cache,
      observations: [{ ...cache.observations[0], observedAt: '2026-10-02T11:00:00.000Z' }],
    });
    expect((await readFile(path, 'utf8')).includes('2026-10-02T11:00:00.000Z')).to.equal(true);
    await writeFile(path, serializeResolutionCache(cache));
    await unlink(path);
    await removeRunOwnedRoot(run);
  });

  it('isolates exact scope and rejects path escape', async () => {
    const { cache } = await withEntry();
    expect(() =>
      lookupServerIdentity(cache, { ...cache.entries[0].portableIdentity, context: { businessUnitApiName: 'south' } })
    ).not.to.throw();
    const run = await createRunOwnedTemp('sf-mcnext-cache-test');
    const path = join(run.root, 'cache.json');
    await writeResolutionCache(run.root, path, cache);
    await rejects(
      () => readResolutionCache(run.root, path, { ...scope, targetOrgId: '00D000000000003AAA' }),
      'scope mismatch'
    );
    await rejects(() => writeResolutionCache(run.root, join(run.root, '..', 'escape.json'), cache), 'escapes');
    await unlink(path);
    await removeRunOwnedRoot(run);
  });

  it('skips unchanged roots and refreshes only one changed root with fewer calls than cold retrieval', async () => {
    const first = campaign('Autumn Campaign', '701000000000001AAA');
    const second = campaign('Winter Campaign', '701000000000002AAA');
    let calls = 0;
    let cache = await refreshResolutionCache(
      createResolutionCache(scope),
      [first, second],
      async (request) => {
        calls += 1;
        return request;
      },
      '2026-10-02T10:00:00.000Z'
    );
    expect(calls).to.equal(2);
    calls = 0;
    cache = await refreshResolutionCache(
      cache,
      [first, second],
      async (request) => {
        calls += 1;
        return request;
      },
      '2026-10-02T11:00:00.000Z'
    );
    expect(calls).to.equal(0);

    const changed = campaign('Winter Campaign', '701000000000003AAA');
    changed.source.completion.calls = 2;
    calls = 0;
    cache = await refreshResolutionCache(
      cache,
      [first, changed],
      async (request) => {
        calls += 1;
        return request;
      },
      '2026-10-02T12:00:00.000Z'
    );
    expect(calls).to.equal(1);
    expect(cache.entries).to.have.length(2);
    expect(cache.entries.some((entry) => entry.evidenceIdentity.value === '701000000000002AAA')).to.equal(false);
  });

  it('removes stale positives and never persists partial, ambiguous, or relationship-bearing evidence', async () => {
    const valid = campaign();
    let cache = await refreshResolutionCache(
      createResolutionCache(scope),
      [valid],
      async () => valid,
      '2026-10-02T10:00:00.000Z'
    );
    const partial = campaign();
    partial.source.queryDone = false;
    partial.source.completion.calls = 2;
    cache = await refreshResolutionCache(cache, [partial], async () => partial, '2026-10-02T11:00:00.000Z');
    expect(cache.entries).to.have.length(0);

    const ambiguous = campaign();
    if (ambiguous.kind !== 'Campaign') throw new Error('expected Campaign request');
    ambiguous.source.records.push({ ...ambiguous.source.records[0], serverId: '701000000000002AAA' });
    ambiguous.source.totalSize = 2;
    ambiguous.source.completion.items = 2;
    expect(() => createResolutionCacheEntry(ambiguous)).to.throw('uniquely');

    const related = campaign();
    if (related.kind !== 'Campaign') throw new Error('expected Campaign request');
    related.source.records[0].relationships.ParentId = '701000000000002AAA';
    expect(() => createResolutionCacheEntry(related)).to.throw('relationships');
  });

  it('rejects unknown keys, fixture drift, hash corruption, leaks, conflicts, and bounds', async () => {
    const { cache } = await withEntry();
    expect(() => serializeResolutionCache({ ...cache, extra: true } as never)).to.throw('fields');
    expect(() =>
      serializeResolutionCache({ ...cache, scope: { ...scope, capabilityFixtureSha256: '0'.repeat(64) } } as never)
    ).to.throw('fixture');
    expect(() => serializeResolutionCache({ ...cache, contentHash: '0'.repeat(64) })).to.throw('content hash');
    expect(() => serializeResolutionCache({ ...cache, entries: [...cache.entries, cache.entries[0]] })).to.throw(
      'duplicate'
    );
    expect(() => createResolutionCache({ ...scope, nativeContext: { targetRecordId: 'portable-looking' } })).to.throw(
      'portable locator key leak'
    );
    expect(() =>
      serializeResolutionCache({ ...cache, entries: Array.from({ length: 1001 }, () => cache.entries[0]) })
    ).to.throw('bound');
  });
});
