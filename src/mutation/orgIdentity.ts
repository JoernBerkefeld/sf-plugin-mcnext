import { Org } from '@salesforce/core';

export type OrgIdentityRole = 'source' | 'target';

export type ExpectedOrgIdentity = {
  targetOrg: string;
  expectedOrgId: string;
  role: OrgIdentityRole;
};

export type ResolvedOrgIdentity = {
  orgId: string;
};

export type OrgIdentityResolver = (targetOrg: string) => Promise<string>;

export type OrgIdentityErrorCode = 'INVALID_EXPECTED_ORG_ID' | 'ORG_RESOLUTION_FAILED' | 'ORG_ID_MISMATCH';

/** Reports an identity guard failure without exposing authentication details. */
export class OrgIdentityError extends Error {
  public constructor(public readonly code: OrgIdentityErrorCode, public readonly role: OrgIdentityRole) {
    super(
      code === 'INVALID_EXPECTED_ORG_ID'
        ? `Expected ${role} org ID must be a valid 18-character Salesforce org ID`
        : code === 'ORG_RESOLUTION_FAILED'
        ? `Authenticated ${role} org could not be resolved`
        : `Authenticated ${role} org does not match the expected org ID`
    );
    this.name = 'OrgIdentityError';
  }
}

const orgIdPattern = /^00D[A-Za-z0-9]{15}$/;

/** Resolve an authenticated org and verify its exact identity before mutation transport. */
export async function resolveExpectedOrgIdentity(
  expected: ExpectedOrgIdentity,
  resolver: OrgIdentityResolver = resolveSalesforceCoreOrgId
): Promise<ResolvedOrgIdentity> {
  if (!orgIdPattern.test(expected.expectedOrgId)) {
    throw new OrgIdentityError('INVALID_EXPECTED_ORG_ID', expected.role);
  }

  let orgId: string;
  try {
    orgId = await resolver(expected.targetOrg);
  } catch {
    throw new OrgIdentityError('ORG_RESOLUTION_FAILED', expected.role);
  }
  if (orgId !== expected.expectedOrgId) {
    throw new OrgIdentityError('ORG_ID_MISMATCH', expected.role);
  }

  return { orgId };
}

async function resolveSalesforceCoreOrgId(targetOrg: string): Promise<string> {
  const org = await Org.create({ aliasOrUsername: targetOrg });
  return org.getOrgId();
}
