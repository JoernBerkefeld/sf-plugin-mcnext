import filesystem from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Org } from '@salesforce/core';
import { McnClient, TESTED_API_VERSION } from '../client/mcnClient.js';
import { redact } from '../cms/cmsCli.js';
import type { IdentityResolutionConfiguration } from '../identityResolution/identityResolution.js';
import { inspectDestination, validateComponents, validateRetrievalProject } from './retrieve-resolver.js';

export type IdentityConfigurationInput = {
  projectRoot: string;
  targetOrg: string;
  expectedOrgId: string;
  apiVersion: string;
};
export type IdentityConfigurationServices = {
  createOrg?: (targetOrg: string) => Promise<Org>;
  createClient?: (org: Org, apiVersion: string) => Promise<McnClient>;
};
export type IdentityConfigurationCollection = Record<string, unknown> & {
  identityResolutions: IdentityResolutionConfiguration[];
};
export type IdentityConfigurationResult = {
  state: 'success' | 'blocked' | 'failed' | 'partial';
  files: string[];
  diagnostics: string[];
  result?: IdentityConfigurationCollection;
};

/** Download unchanged working configuration evidence, not a native Data360 backup. */
export async function retrieveIdentityConfiguration(
  input: IdentityConfigurationInput,
  services: IdentityConfigurationServices = {}
): Promise<IdentityConfigurationResult> {
  const outcome: IdentityConfigurationResult = { state: 'blocked', files: [], diagnostics: [] };
  const destination = join(input.projectRoot, 'data', 'identity-resolution.json');
  let phase: 'preflight' | 'request' | 'validation' | 'write' = 'preflight';
  try {
    await validateRetrievalProject(input.projectRoot);
    if (input.apiVersion !== TESTED_API_VERSION) throw new Error('Identity configuration requires API 67.0');
    if (!input.targetOrg.trim() || input.targetOrg.includes('\0') || !input.expectedOrgId.trim()) {
      throw new Error('Selected org and expected org identity are required');
    }
    validateComponents(relative(input.projectRoot, destination));
    await inspectDestination(input.projectRoot, destination, true);
    const org = await (services.createOrg ?? ((targetOrg): Promise<Org> => Org.create({ aliasOrUsername: targetOrg })))(
      input.targetOrg
    );
    if (org.getOrgId() !== input.expectedOrgId)
      throw new Error('Fresh selected org does not match expected org identity');
    const client = await (services.createClient ?? McnClient.create)(org, input.apiVersion);
    if (client.apiVersion !== input.apiVersion) throw new Error('Identity configuration client API binding mismatch');
    phase = 'request';
    const response = await client.request<unknown>({ path: '/ssot/identity-resolutions', method: 'GET' });
    phase = 'validation';
    const collection = validateCollection(response);
    const bytes = `${JSON.stringify(collection, undefined, 2)}\n`;
    outcome.result = collection;
    await inspectDestination(input.projectRoot, destination, true);
    phase = 'write';
    const directory = join(input.projectRoot, 'data');
    await inspectDestination(input.projectRoot, directory, false);
    try {
      await filesystem.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await inspectDestination(input.projectRoot, directory, false);
    await inspectDestination(input.projectRoot, destination, true);
    const handle = await filesystem.open(destination, 'wx');
    try {
      await handle.writeFile(bytes, 'utf8');
    } finally {
      await handle.close();
    }
    outcome.files.push(destination);
    outcome.state = 'success';
    outcome.diagnostics.push(
      'Working identity-resolution collection only; native Data360 backup and restore are unqualified.'
    );
  } catch (error) {
    outcome.state = phase === 'request' || phase === 'write' ? 'failed' : 'blocked';
    outcome.diagnostics.push(
      `Identity configuration ${phase}: ${redact(error instanceof Error ? error.message : String(error))}`
    );
    if (phase === 'write') outcome.diagnostics.push('Attempted output: data/identity-resolution.json (not published).');
  }
  return outcome;
}

function validateCollection(response: unknown): IdentityConfigurationCollection {
  if (!object(response) || !Array.isArray(response.identityResolutions)) {
    throw new Error('Identity configuration response requires an identityResolutions array');
  }
  const identities = new Set<string>();
  for (const row of response.identityResolutions as unknown[]) {
    if (!object(row) || typeof row.id !== 'string' || !/^[A-Za-z0-9]{18}$/u.test(row.id)) {
      throw new Error('Identity configuration row requires an actual Salesforce id');
    }
    const key = row.id.toLowerCase();
    if (identities.has(key)) throw new Error('Identity configuration contains conflicting Salesforce ids');
    identities.add(key);
  }
  return response as IdentityConfigurationCollection;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
