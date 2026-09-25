import { readFile } from 'node:fs/promises';
import { McnClient } from '../client/mcnClient.js';
import { listIdentityResolutions, showIdentityResolution } from './identityResolution.js';

const configurationFields = [
  'label',
  'dataSpaceName',
  'objectApiName',
  'secondaryDmo',
  'filters',
  'matchRules',
  'reconciliationRules',
] as const;
const filterFields = ['field', 'operator', 'value'] as const;
const matchRuleFields = ['label', 'criteria'] as const;
const criterionFields = ['field'] as const;
const reconciliationRuleFields = [
  'entityName',
  'fields',
  'linkDmoName',
  'ruleType',
  'shouldIgnoreEmptyValue',
  'sources',
  'unifiedDmoName',
] as const;

export type IdentityResolutionSupportedConfiguration = {
  label: string;
  dataSpaceName: string;
  objectApiName: string;
  secondaryDmo?: string;
  filters: Array<{ field: string; operator: string; value: string }>;
  matchRules: Array<{ label: string; criteria: Array<{ field: string }> }>;
  reconciliationRules: Array<{
    entityName: string;
    fields: string[];
    linkDmoName: string;
    ruleType: string;
    shouldIgnoreEmptyValue: boolean;
    sources: string[];
    unifiedDmoName: string;
  }>;
};

export type IdentityResolutionMapping = {
  field: string;
  source: string;
  target: string;
};

export type IdentityResolutionPlanInput = {
  configuration: IdentityResolutionSupportedConfiguration;
  mappings: IdentityResolutionMapping[];
};

export type IdentityResolutionDifference = {
  field: string;
  source: unknown;
  target: unknown;
};

export type IdentityResolutionCheckpoint = {
  state: 'blocked';
  reason: string;
};

export type IdentityResolutionPlanIntent = 'create' | 'update-shell';

export type IdentityResolutionTargetExpectation = {
  rulesetId: string;
  label: string;
  key: string;
  status: string;
};

export type IdentityResolutionPlanSelection =
  | { intent: 'create' }
  | { intent: 'update-shell'; expectedTarget: IdentityResolutionTargetExpectation };

export type IdentityResolutionPlan = {
  family: 'identity-resolution';
  mutationFree: true;
  intent: IdentityResolutionPlanIntent;
  target: { rulesetId?: string; label: string; key: string; status?: string };
  sourceProjection: IdentityResolutionSupportedConfiguration;
  targetProjection?: IdentityResolutionSupportedConfiguration;
  mappings: IdentityResolutionMapping[];
  differences: IdentityResolutionDifference[];
  checkpoints: {
    createWritableSchema: IdentityResolutionCheckpoint;
    patchWritableSchema: IdentityResolutionCheckpoint;
    lifecycle: IdentityResolutionCheckpoint;
  };
  prospectiveRequestBody?: never;
  allowedMethods: ['GET'];
  forbiddenPaths: ['POST', 'PATCH', 'publication', 'scheduling', 'run-now'];
};

type IdentityResolutionReadClient = Pick<McnClient, 'request'>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unsupported ${context} field(s): ${unknown.sort().join(', ')}`);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a nonempty string`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a nonempty string array`);
  return value.map((entry, index) => requiredText(entry, `${field}[${index}]`));
}

function parseConfiguration(
  value: unknown,
  context = 'configuration',
  rejectUnknownTopLevel = true
): IdentityResolutionSupportedConfiguration {
  if (!object(value)) throw new Error(`${context} must be an object`);
  if (rejectUnknownTopLevel) exactKeys(value, configurationFields, context);
  if (!Array.isArray(value.filters) || !Array.isArray(value.matchRules) || !Array.isArray(value.reconciliationRules))
    throw new Error(`${context} filters, matchRules and reconciliationRules must be arrays`);

  return {
    label: requiredText(value.label, `${context}.label`),
    dataSpaceName: requiredText(value.dataSpaceName, `${context}.dataSpaceName`),
    objectApiName: requiredText(value.objectApiName, `${context}.objectApiName`),
    ...(value.secondaryDmo === undefined
      ? {}
      : { secondaryDmo: requiredText(value.secondaryDmo, `${context}.secondaryDmo`) }),
    filters: value.filters.map((entry, index) => {
      if (!object(entry)) throw new Error(`${context}.filters[${index}] must be an object`);
      exactKeys(entry, filterFields, `${context}.filters[${index}]`);
      return {
        field: requiredText(entry.field, `${context}.filters[${index}].field`),
        operator: requiredText(entry.operator, `${context}.filters[${index}].operator`),
        value: requiredText(entry.value, `${context}.filters[${index}].value`),
      };
    }),
    matchRules: value.matchRules.map((entry, index) => {
      if (!object(entry)) throw new Error(`${context}.matchRules[${index}] must be an object`);
      exactKeys(entry, matchRuleFields, `${context}.matchRules[${index}]`);
      if (!Array.isArray(entry.criteria)) throw new Error(`${context}.matchRules[${index}].criteria must be an array`);
      return {
        label: requiredText(entry.label, `${context}.matchRules[${index}].label`),
        criteria: entry.criteria.map((criterion, criterionIndex) => {
          if (!object(criterion))
            throw new Error(`${context}.matchRules[${index}].criteria[${criterionIndex}] must be an object`);
          exactKeys(criterion, criterionFields, `${context}.matchRules[${index}].criteria[${criterionIndex}]`);
          return {
            field: requiredText(criterion.field, `${context}.matchRules[${index}].criteria[${criterionIndex}].field`),
          };
        }),
      };
    }),
    reconciliationRules: value.reconciliationRules.map((entry, index) => {
      if (!object(entry)) throw new Error(`${context}.reconciliationRules[${index}] must be an object`);
      exactKeys(entry, reconciliationRuleFields, `${context}.reconciliationRules[${index}]`);
      if (typeof entry.shouldIgnoreEmptyValue !== 'boolean')
        throw new Error(`${context}.reconciliationRules[${index}].shouldIgnoreEmptyValue must be boolean`);
      return {
        entityName: requiredText(entry.entityName, `${context}.reconciliationRules[${index}].entityName`),
        fields: stringArray(entry.fields, `${context}.reconciliationRules[${index}].fields`),
        linkDmoName: requiredText(entry.linkDmoName, `${context}.reconciliationRules[${index}].linkDmoName`),
        ruleType: requiredText(entry.ruleType, `${context}.reconciliationRules[${index}].ruleType`),
        shouldIgnoreEmptyValue: entry.shouldIgnoreEmptyValue,
        sources: stringArray(entry.sources, `${context}.reconciliationRules[${index}].sources`),
        unifiedDmoName: requiredText(entry.unifiedDmoName, `${context}.reconciliationRules[${index}].unifiedDmoName`),
      };
    }),
  };
}

const scalarMappingFields = new Set(['dataSpaceName', 'objectApiName', 'secondaryDmo']);
const arrayMappingFields = [
  /^filters\[\d+\]\.field$/,
  /^matchRules\[\d+\]\.criteria\[\d+\]\.field$/,
  /^reconciliationRules\[\d+\]\.(entityName|linkDmoName|unifiedDmoName)$/,
  /^reconciliationRules\[\d+\]\.fields\[\d+\]$/,
  /^reconciliationRules\[\d+\]\.sources\[\d+\]$/,
];

function supportedMappingField(field: string): boolean {
  return scalarMappingFields.has(field) || arrayMappingFields.some((pattern) => pattern.test(field));
}

function parseMappings(value: unknown): IdentityResolutionMapping[] {
  if (!Array.isArray(value)) throw new Error('mappings must be an array');
  const fields = new Set<string>();
  return value.map((entry, index) => {
    if (!object(entry)) throw new Error(`mappings[${index}] must be an object`);
    exactKeys(entry, ['field', 'source', 'target'], `mappings[${index}]`);
    const mapping = {
      field: requiredText(entry.field, `mappings[${index}].field`),
      source: requiredText(entry.source, `mappings[${index}].source`),
      target: requiredText(entry.target, `mappings[${index}].target`),
    };
    if (!supportedMappingField(mapping.field))
      throw new Error(`Unsupported identity-resolution mapping field ${mapping.field}`);
    if (mapping.source === mapping.target) throw new Error(`Mapping ${mapping.field} must change the source value`);
    if (fields.has(mapping.field)) throw new Error(`Duplicate mapping field ${mapping.field}`);
    fields.add(mapping.field);
    return mapping;
  });
}

/** Parse the closed, family-local source and mapping contract. */
export function parseIdentityResolutionPlanInput(value: unknown): IdentityResolutionPlanInput {
  if (!object(value)) throw new Error('Identity-resolution plan input must be an object');
  exactKeys(value, ['configuration', 'mappings'], 'plan input');
  return { configuration: parseConfiguration(value.configuration), mappings: parseMappings(value.mappings) };
}

/** Read and parse one identity-resolution planning input file. */
export async function readIdentityResolutionPlanInput(file: string): Promise<IdentityResolutionPlanInput> {
  return parseIdentityResolutionPlanInput(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

function getAtPath(root: unknown, path: string): unknown {
  const parts = path.replaceAll('[', '.').replaceAll(']', '').split('.');
  let value = root;
  for (const part of parts) {
    if ((!object(value) && !Array.isArray(value)) || !(part in value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function setAtPath(root: unknown, path: string, expected: string, replacement: string): void {
  const parts = path.replaceAll('[', '.').replaceAll(']', '').split('.');
  let value = root as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = value[part];
    if (!object(next) && !Array.isArray(next)) throw new Error(`Mapping field ${path} is not declared by the source`);
    value = next as Record<string, unknown>;
  }
  const leaf = parts.at(-1)!;
  if (value[leaf] !== expected) throw new Error(`Mapping source mismatch at ${path}`);
  value[leaf] = replacement;
}

function applyMappings(
  configuration: IdentityResolutionSupportedConfiguration,
  mappings: IdentityResolutionMapping[]
): IdentityResolutionSupportedConfiguration {
  const projected = structuredClone(configuration);
  for (const mapping of mappings) setAtPath(projected, mapping.field, mapping.source, mapping.target);
  return projected;
}

function differences(source: unknown, target: unknown, field = ''): IdentityResolutionDifference[] {
  if (Object.is(source, target)) return [];
  if (Array.isArray(source) && Array.isArray(target)) {
    const result: IdentityResolutionDifference[] = [];
    for (let index = 0; index < Math.max(source.length, target.length); index++)
      result.push(...differences(source[index], target[index], `${field}[${index}]`));
    return result;
  }
  if (object(source) && object(target)) {
    const result: IdentityResolutionDifference[] = [];
    for (const key of [...new Set([...Object.keys(source), ...Object.keys(target)])].sort())
      result.push(...differences(source[key], target[key], field ? `${field}.${key}` : key));
    return result;
  }
  return [{ field, source, target }];
}

const blockedCheckpoints = {
  createWritableSchema: {
    state: 'blocked',
    reason: 'No authoritative repository evidence establishes the Identity Resolution CREATE writable schema.',
  },
  patchWritableSchema: {
    state: 'blocked',
    reason: 'No authoritative repository evidence establishes the Identity Resolution PATCH writable schema.',
  },
  lifecycle: {
    state: 'blocked',
    reason:
      'No authoritative repository evidence establishes mutation-free publication, scheduling, and run-now lifecycle behavior.',
  },
} as const;

/** Discover an exact target and compare mapped semantic projections using GET requests only. */
export async function buildIdentityResolutionPlan(
  client: IdentityResolutionReadClient,
  input: IdentityResolutionPlanInput,
  selection: IdentityResolutionPlanSelection
): Promise<IdentityResolutionPlan> {
  const sourceProjection = applyMappings(input.configuration, input.mappings);
  for (const mapping of input.mappings) {
    if (getAtPath(input.configuration, mapping.field) !== mapping.source)
      throw new Error(`Mapping source mismatch at ${mapping.field}`);
  }
  const expected =
    selection.intent === 'create'
      ? { label: sourceProjection.label, key: sourceProjection.objectApiName }
      : selection.expectedTarget;
  const matches = (await listIdentityResolutions(client as McnClient)).filter(
    (candidate) => candidate.label === expected.label && candidate.objectApiName === expected.key
  );
  if (matches.length > 1) throw new Error('Identity-resolution target identity is ambiguous');
  if (selection.intent === 'create') {
    if (matches.length > 0) throw new Error('Identity-resolution CREATE target already exists');
    return {
      family: 'identity-resolution',
      mutationFree: true,
      intent: selection.intent,
      target: expected,
      sourceProjection,
      mappings: input.mappings,
      differences: [],
      checkpoints: blockedCheckpoints,
      allowedMethods: ['GET'],
      forbiddenPaths: ['POST', 'PATCH', 'publication', 'scheduling', 'run-now'],
    };
  }
  if (matches.length === 0) throw new Error('Expected identity-resolution UPDATE target was not found');
  const updateTarget = selection.expectedTarget;
  const collectionId = requiredText(matches[0].rulesetId, 'discovered target rulesetId');
  if (collectionId !== updateTarget.rulesetId) throw new Error('Identity-resolution target ruleset ID mismatch');
  const targetResponse = await showIdentityResolution(client as McnClient, updateTarget.rulesetId);
  if (
    targetResponse.rulesetId !== updateTarget.rulesetId ||
    targetResponse.label !== updateTarget.label ||
    targetResponse.objectApiName !== updateTarget.key ||
    targetResponse.rulesetStatus !== updateTarget.status
  )
    throw new Error('Identity-resolution target identity or status mismatch');
  const targetProjection = parseConfiguration(targetResponse, 'target', false);
  return {
    family: 'identity-resolution',
    mutationFree: true,
    intent: selection.intent,
    target: expected,
    sourceProjection,
    targetProjection,
    mappings: input.mappings,
    differences: differences(sourceProjection, targetProjection),
    checkpoints: blockedCheckpoints,
    allowedMethods: ['GET'],
    forbiddenPaths: ['POST', 'PATCH', 'publication', 'scheduling', 'run-now'],
  };
}
