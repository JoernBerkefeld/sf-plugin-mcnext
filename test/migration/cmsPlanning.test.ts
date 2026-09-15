import { createHash } from 'node:crypto';
import { expect } from 'chai';
import { buildCmsPlanningState, CmsWorkspaceMapError, parseCmsWorkspaceMap } from '../../src/migration/cmsPlanning.js';

const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

function parse(value: string, limits?: { maxBytes?: number; maxEntries?: number }) {
  return parseCmsWorkspaceMap(Buffer.from(value), limits);
}

function expectMapError(value: string, message: string, limits?: { maxBytes?: number; maxEntries?: number }): void {
  expect(() => parse(value, limits)).to.throw(CmsWorkspaceMapError, message);
}

describe('CMS planning', () => {
  it('parses exact workspace maps with deterministic routes and exact-byte provenance', () => {
    const bytes = Buffer.from('{"version":1,"workspaces":{"source-z":"target-z","source-a":"target-a"}}\n');
    const result = parseCmsWorkspaceMap(bytes);
    expect(result).to.deep.equal({
      version: 1,
      sha256: hash(bytes),
      byteLength: bytes.byteLength,
      routes: [
        { sourceWorkspaceId: 'source-a', targetWorkspaceId: 'target-a' },
        { sourceWorkspaceId: 'source-z', targetWorkspaceId: 'target-z' },
      ],
    });
    expect(parseCmsWorkspaceMap(Buffer.from(bytes)).sha256).to.equal(result.sha256);
    expect(parseCmsWorkspaceMap(Buffer.from(`${bytes.toString()} `)).sha256).not.to.equal(result.sha256);
  });

  it('rejects malformed, unsupported, empty, duplicate, and wrong-shaped maps', () => {
    expectMapError('{', 'object key must be a string');
    expectMapError('{"version":2,"workspaces":{"a":"b"}}', 'version must be 1');
    expectMapError('{"version":1,"workspaces":{}}', 'must not be empty');
    expectMapError('{"version":1,"version":1,"workspaces":{"a":"b"}}', 'duplicate JSON key: version');
    expectMapError('{"version":1,"workspaces":{"a":"b","a":"c"}}', 'duplicate JSON key: a');
    expectMapError('{"version":1,"workspaces":{"a":"b"},"extra":true}', 'fields must be exactly');
    expectMapError('{"version":1,"workspaces":[]}', 'workspaces must be an object');
    expectMapError('{"version":1,"workspaces":{"":"b"}}', 'source workspace ID');
    expectMapError('{"version":1,"workspaces":{"a":""}}', 'target workspace ID');
    expectMapError('{"version":1,"workspaces":{" a":"b"}}', 'source workspace ID');
    expectMapError('{"version":1,"workspaces":{"a":"same","b":"same"}}', 'duplicate target workspace route');
  });

  it('enforces workspace-map byte and entry bounds', () => {
    expectMapError('{"version":1,"workspaces":{"a":"b"}}', 'input exceeds byte limit', { maxBytes: 10 });
    expectMapError('{"version":1,"workspaces":{"a":"b","c":"d"}}', 'workspace entry limit exceeded', {
      maxEntries: 1,
    });
  });

  it('builds deterministic planning-only state and preserves visible experimental evidence', () => {
    const base = {
      state: 'partial' as const,
      capabilities: {
        pluginVersion: '0.3.1',
        bulkExport: 'implemented' as const,
        externalReferenceCorrelation: 'experimental' as const,
        experimental: true,
      },
      exportProvenance: {
        sourceOrgId: '00Dsource',
        pluginVersion: '0.3.1',
        exportSetId: 'export-1',
        command: 'sf cms export workspace',
        generatedAt: '2026-09-13T20:00:00.000Z',
      },
      workspaceMap: { version: 1 as const, sha256: 'a'.repeat(64), byteLength: 42 },
      packages: [
        {
          sourceWorkspaceId: 'source-z',
          artifactPath: 'z',
          manifestPath: 'z/manifest.json',
          packageManifestSha256: 'b'.repeat(64),
        },
        {
          sourceWorkspaceId: 'source-a',
          artifactPath: 'a',
          manifestPath: 'a/manifest.json',
          packageManifestSha256: 'c'.repeat(64),
        },
      ],
      routes: [
        {
          sourceWorkspaceId: 'source-z',
          targetWorkspaceId: 'target-z',
          packageManifestSha256: 'b'.repeat(64),
          status: 'partial' as const,
          state: 'partial' as const,
          experimental: true,
          diagnostics: [{ code: 'Z', message: 'later' }],
        },
        {
          sourceWorkspaceId: 'source-a',
          targetWorkspaceId: 'target-a',
          packageManifestSha256: 'c'.repeat(64),
          status: 'success' as const,
          state: 'ready-for-execution' as const,
          experimental: false,
          diagnostics: [],
        },
      ],
      diagnostics: [
        { code: 'Z', message: 'later' },
        { code: 'A', message: 'first' },
      ],
    };
    const result = buildCmsPlanningState(base);
    expect(result.kind).to.equal('cms-planning-only');
    expect(result.experimental).to.equal(true);
    expect(result.packages.map((item) => item.sourceWorkspaceId)).to.deep.equal(['source-a', 'source-z']);
    expect(result.routes.map((item) => item.sourceWorkspaceId)).to.deep.equal(['source-a', 'source-z']);
    expect(result.diagnostics.map((item) => item.code)).to.deep.equal(['A', 'Z']);
    expect(result.executablePayloads).to.deep.equal([]);
    expect(result.imports).to.deep.equal([]);
    expect(result.rewrites).to.deep.equal([]);
    expect(result.mutations).to.deep.equal([]);
    expect(JSON.stringify(buildCmsPlanningState(base))).to.equal(JSON.stringify(result));
  });

  it('rejects route evidence without a matching verified package', () => {
    const input = {
      state: 'blocked' as const,
      capabilities: {
        pluginVersion: '0.3.1',
        bulkExport: 'implemented' as const,
        externalReferenceCorrelation: 'implemented' as const,
        experimental: false,
      },
      exportProvenance: {
        sourceOrgId: '00Dsource',
        pluginVersion: '0.3.1',
        exportSetId: 'export-1',
        command: 'sf cms export workspace',
        generatedAt: '2026-09-13T20:00:00.000Z',
      },
      workspaceMap: { version: 1 as const, sha256: 'a'.repeat(64), byteLength: 42 },
      packages: [],
      routes: [
        {
          sourceWorkspaceId: 'missing',
          targetWorkspaceId: 'target',
          packageManifestSha256: 'b'.repeat(64),
          status: 'blocked' as const,
          state: 'blocked' as const,
          experimental: false,
          diagnostics: [],
        },
      ],
    };
    expect(() => buildCmsPlanningState(input)).to.throw(CmsWorkspaceMapError, 'route has no verified package: missing');
    expect(() =>
      buildCmsPlanningState({
        ...input,
        packages: [
          {
            sourceWorkspaceId: 'missing',
            artifactPath: 'a',
            manifestPath: 'a/manifest.json',
            packageManifestSha256: 'c'.repeat(64),
          },
        ],
      })
    ).to.throw(CmsWorkspaceMapError, 'route package mismatch: missing');
  });

  it('rejects duplicate package and route evidence', () => {
    const common = {
      state: 'blocked' as const,
      capabilities: {
        pluginVersion: '0.3.1',
        bulkExport: 'implemented' as const,
        externalReferenceCorrelation: 'implemented' as const,
        experimental: false,
      },
      exportProvenance: {
        sourceOrgId: '00Dsource',
        pluginVersion: '0.3.1',
        exportSetId: 'export-1',
        command: 'sf cms export workspace',
        generatedAt: '2026-09-13T20:00:00.000Z',
      },
      workspaceMap: { version: 1 as const, sha256: 'a'.repeat(64), byteLength: 42 },
    };
    const packageEvidence = {
      sourceWorkspaceId: 'source',
      artifactPath: 'a',
      manifestPath: 'a/manifest.json',
      packageManifestSha256: 'b'.repeat(64),
    };
    const routeEvidence = {
      sourceWorkspaceId: 'source',
      targetWorkspaceId: 'target',
      packageManifestSha256: 'b'.repeat(64),
      status: 'success' as const,
      state: 'ready-for-execution' as const,
      experimental: false,
      diagnostics: [],
    };
    expect(() =>
      buildCmsPlanningState({ ...common, packages: [packageEvidence, packageEvidence], routes: [routeEvidence] })
    ).to.throw(CmsWorkspaceMapError, 'duplicate package evidence: source');
    expect(() =>
      buildCmsPlanningState({ ...common, packages: [packageEvidence], routes: [routeEvidence, routeEvidence] })
    ).to.throw(CmsWorkspaceMapError, 'duplicate workspace route: source');
  });
});
