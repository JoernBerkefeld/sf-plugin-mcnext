import { expect } from 'chai';
import {
  OrgIdentityError,
  resolveExpectedOrgIdentity,
  type ExpectedOrgIdentity,
  type OrgIdentityResolver,
} from '../../src/mutation/orgIdentity.js';

const sourceOrgId = '00D000000000001AAA';
const targetOrgId = '00D000000000002AAA';
const sensitiveValues = ['admin@example.com', 'https://example.my.salesforce.com', 'secret-token'];

function expected(patch: Partial<ExpectedOrgIdentity> = {}): ExpectedOrgIdentity {
  return {
    targetOrg: 'authenticated-org',
    expectedOrgId: sourceOrgId,
    role: 'source',
    ...patch,
  };
}

async function captureError(input: ExpectedOrgIdentity, resolver: OrgIdentityResolver): Promise<OrgIdentityError> {
  let error: unknown;
  try {
    await resolveExpectedOrgIdentity(input, resolver);
  } catch (caught) {
    error = caught;
  }
  expect(error).to.be.instanceOf(OrgIdentityError);
  return error as OrgIdentityError;
}

describe('expected org identity guard', () => {
  it('returns only the verified 18-character org ID', async () => {
    const result = await resolveExpectedOrgIdentity(expected(), async () => sourceOrgId);

    expect(result).to.deep.equal({ orgId: sourceOrgId });
  });

  it('rejects malformed and 15-character IDs before resolving authentication', async () => {
    await Promise.all(
      ['not-an-org-id', '00D000000000001'].map(async (expectedOrgId) => {
        let resolverCalls = 0;
        const error = await captureError(expected({ expectedOrgId }), async () => {
          resolverCalls++;
          return sourceOrgId;
        });

        expect(error.code).to.equal('INVALID_EXPECTED_ORG_ID');
        expect(error.role).to.equal('source');
        expect(resolverCalls).to.equal(0);
      })
    );
  });

  it('rejects source and target identity mismatches exactly', async () => {
    await Promise.all(
      (['source', 'target'] as const).map(async (role) => {
        const error = await captureError(expected({ role }), async () => targetOrgId);

        expect(error.code).to.equal('ORG_ID_MISMATCH');
        expect(error.role).to.equal(role);
      })
    );
  });

  it('prevents downstream transport after identity failure', async () => {
    let transportCalls = 0;
    const guardedMutation = async (): Promise<void> => {
      await resolveExpectedOrgIdentity(expected(), async () => targetOrgId);
      transportCalls++;
    };

    let error: unknown;
    try {
      await guardedMutation();
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(OrgIdentityError);
    expect(transportCalls).to.equal(0);
  });

  it('keeps normal mismatch and resolver diagnostics free of org IDs and authentication details', async () => {
    const mismatch = await captureError(expected({ targetOrg: sensitiveValues[0] }), async () => targetOrgId);
    const resolution = await captureError(expected({ targetOrg: sensitiveValues[0] }), async () => {
      throw new Error(sensitiveValues.join(' '));
    });

    expect(resolution.code).to.equal('ORG_RESOLUTION_FAILED');
    for (const error of [mismatch, resolution]) {
      const diagnostic = JSON.stringify({
        name: error.name,
        message: error.message,
        code: error.code,
        role: error.role,
      });
      expect(diagnostic).not.to.contain(sourceOrgId).and.not.to.contain(targetOrgId);
      for (const value of sensitiveValues) expect(diagnostic).not.to.contain(value);
    }
  });
});
