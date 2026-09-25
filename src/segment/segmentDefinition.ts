import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Builder, parseStringPromise } from 'xml2js';

const metadataNamespace = 'http://soap.sforce.com/2006/04/metadata';
const memberSuffix = '.marketSegmentDefinition-meta.xml';
const apiNamePattern = /^[A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9]+)?$/;

export type SegmentReferenceKind = 'dmo' | 'unifiedDmo' | 'linkDmo' | 'field' | 'relationship';

export type SegmentReference = {
  kind: SegmentReferenceKind;
  value: string;
  path: string;
};

export type SegmentReferenceMapping = {
  kind: SegmentReferenceKind;
  source: string;
  target: string;
};

export type SegmentDefinitionMappingFile = {
  schemaVersion: 1;
  segmentReferences: SegmentReferenceMapping[];
};

type CriteriaNode = null | boolean | number | string | CriteriaNode[] | { [key: string]: CriteriaNode };

type UiCriteria = {
  format: 'UI';
  value: CriteriaNode;
};

type DbtModel = {
  name: string;
  selectObject: string;
  selectField: string;
};

type DbtCriteria = {
  format: 'DBT';
  models: DbtModel[];
};

export type SegmentDefinitionCriteria = UiCriteria | DbtCriteria;

export type SegmentDefinition = {
  member: string;
  masterLabel: string;
  segmentType: 'UI' | 'DBT';
  segmentOn?: string;
  includeCriteria: SegmentDefinitionCriteria;
};

export type SegmentDefinitionProjection = {
  member: string;
  masterLabel: string;
  segmentType: 'UI' | 'DBT';
  segmentOn?: string;
  includeCriteria: CriteriaNode;
};

export type SegmentDefinitionComparison = {
  equal: boolean;
  differences: string[];
  expected: SegmentDefinitionProjection;
  actual: SegmentDefinitionProjection;
};

type XmlElement = Record<string, unknown> & { $?: Record<string, unknown> };

/** Parse one bounded MarketSegmentDefinition metadata file without executing embedded criteria. */
export async function parseSegmentDefinitionXml(
  xml: string,
  member: string,
  filePath: string
): Promise<SegmentDefinition> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported Segment Definition XML declarations');
  if (!member.trim()) throw new Error('Segment Definition member is required');
  const fileName = basename(filePath);
  if (fileName !== `${member}${memberSuffix}`) throw new Error('Segment Definition member and file name must match');

  let document: Record<string, unknown>;
  try {
    document = (await parseStringPromise(xml, {
      explicitArray: true,
      explicitRoot: true,
      strict: true,
      trim: false,
    })) as Record<string, unknown>;
  } catch {
    throw new Error('Malformed Segment Definition XML');
  }

  if (Object.keys(document).length !== 1 || !isRecord(document.MarketSegmentDefinition))
    throw new Error('Require exactly one MarketSegmentDefinition root element');
  const root = document.MarketSegmentDefinition as XmlElement;
  if (root.$?.xmlns !== metadataNamespace) throw new Error('Unsupported Segment Definition metadata namespace');
  const supportedFields = new Set(['$', 'includeCriteria', 'masterLabel', 'segmentOn', 'segmentType']);
  if (Object.keys(root).some((key) => !supportedFields.has(key)))
    throw new Error('Unsupported Segment Definition metadata field');

  const masterLabel = requiredText(root, 'masterLabel');
  const segmentType = requiredText(root, 'segmentType');
  const includeCriteria = requiredText(root, 'includeCriteria');
  if (segmentType !== 'UI' && segmentType !== 'DBT') throw new Error('Unsupported Segment Definition criteria type');
  const segmentOn = optionalText(root, 'segmentOn');
  if (segmentType === 'UI' && !segmentOn) throw new Error('UI Segment Definition requires segmentOn');
  if (segmentType === 'DBT' && segmentOn) throw new Error('DBT Segment Definition does not support segmentOn');

  return {
    member,
    masterLabel,
    segmentType,
    ...(segmentOn ? { segmentOn } : {}),
    includeCriteria:
      segmentType === 'UI'
        ? { format: 'UI', value: parseUiCriteria(includeCriteria) }
        : await parseDbtCriteria(includeCriteria),
  };
}

/** Inventory every dependency at a supported criteria path, including ordered relationship edges. */
export function inventorySegmentDefinitionReferences(definition: SegmentDefinition): SegmentReference[] {
  const references: SegmentReference[] = [];
  if (definition.segmentOn)
    references.push({
      kind: classifyObjectReference(definition.segmentOn),
      value: definition.segmentOn,
      path: 'segmentOn',
    });
  if (definition.includeCriteria.format === 'UI') {
    walkUiCriteria(definition.includeCriteria.value, 'includeCriteria', references);
  } else {
    definition.includeCriteria.models.forEach((model, index) => {
      references.push({
        kind: classifyObjectReference(model.selectObject),
        value: model.selectObject,
        path: `includeCriteria.models[${index}].sql.from`,
      });
      references.push({
        kind: 'field',
        value: model.selectField,
        path: `includeCriteria.models[${index}].sql.select`,
      });
    });
  }
  return references;
}

/** Apply an exact family-local mapping file and revalidate the complete transformed model. */
export function applySegmentDefinitionMappings(
  definition: SegmentDefinition,
  mappingFile: SegmentDefinitionMappingFile
): SegmentDefinition {
  const mappings = validateMappings(mappingFile);
  const inventory = inventorySegmentDefinitionReferences(definition);
  const requiredReferences = new Set(inventory.map((reference) => `${reference.kind}:${reference.value}`));
  for (const reference of requiredReferences) {
    if (!mappings.some((mapping) => mappingKey(mapping) === reference))
      throw new Error(`Missing Segment Definition mapping: ${reference}`);
  }
  const useCounts = new Map(mappings.map((mapping) => [mappingKey(mapping), 0]));
  const mapped = structuredClone(definition);

  if (mapped.segmentOn)
    mapped.segmentOn = mapReference(mapped.segmentOn, classifyObjectReference(mapped.segmentOn), mappings, useCounts);
  if (mapped.includeCriteria.format === 'UI') {
    mapped.includeCriteria.value = mapUiCriteria(mapped.includeCriteria.value, 'includeCriteria', mappings, useCounts);
  } else {
    mapped.includeCriteria.models = mapped.includeCriteria.models.map((model) => ({
      ...model,
      selectObject: mapReference(model.selectObject, classifyObjectReference(model.selectObject), mappings, useCounts),
      selectField: mapReference(model.selectField, 'field', mappings, useCounts),
    }));
  }

  for (const mapping of mappings) {
    if (useCounts.get(mappingKey(mapping)) === 0)
      throw new Error(`Unused Segment Definition mapping: ${mapping.kind}:${mapping.source}`);
  }
  const transformedInventory = inventorySegmentDefinitionReferences(mapped);
  validateMappedDefinition(mapped);
  if (inventory.length !== transformedInventory.length)
    throw new Error('Segment Definition mapping changed dependency structure');
  return mapped;
}

/** Produce a complete comparison projection with canonical criteria and preserved array order. */
export function projectSegmentDefinition(definition: SegmentDefinition): SegmentDefinitionProjection {
  return {
    member: definition.member,
    masterLabel: definition.masterLabel,
    segmentType: definition.segmentType,
    ...(definition.segmentOn ? { segmentOn: definition.segmentOn } : {}),
    includeCriteria:
      definition.includeCriteria.format === 'UI'
        ? canonicalizeCriteria(definition.includeCriteria.value)
        : {
            format: 'DBT',
            models: definition.includeCriteria.models.map((model) => ({
              name: model.name,
              selectObject: model.selectObject,
              selectField: model.selectField,
            })),
          },
  };
}

/** Compare every supported semantic field and report stable field-level differences. */
export function compareSegmentDefinitions(
  expectedDefinition: SegmentDefinition,
  actualDefinition: SegmentDefinition
): SegmentDefinitionComparison {
  const expected = projectSegmentDefinition(expectedDefinition);
  const actual = projectSegmentDefinition(actualDefinition);
  const differences = (['member', 'masterLabel', 'segmentType', 'segmentOn', 'includeCriteria'] as const).filter(
    (field) => !isDeepStrictEqual(expected[field], actual[field])
  );
  return { equal: differences.length === 0, differences, expected, actual };
}

/** Serialize supported criteria so tests and future transport can reparse transformed content. */
export function serializeSegmentDefinitionCriteria(criteria: SegmentDefinitionCriteria): string {
  if (criteria.format === 'UI') return JSON.stringify(criteria.value);
  const builder = new Builder({ headless: true, renderOpts: { pretty: false } });
  return builder.buildObject({
    DbtPipeline: {
      $: { xmlns: '' },
      models: [
        {
          model: criteria.models.map((model) => ({
            name: [model.name],
            sql: [`SELECT ${model.selectObject}.${model.selectField} FROM ${model.selectObject} WHERE 1 = 0`],
          })),
        },
      ],
    },
  });
}

function requiredText(root: XmlElement, key: string): string {
  const value = optionalText(root, key);
  if (!value) throw new Error(`Segment Definition ${key} must be nonempty`);
  return value;
}

function optionalText(root: XmlElement, key: string): string | undefined {
  const value = root[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string')
    throw new Error(`Segment Definition ${key} must occur exactly once`);
  const text = value[0].trim();
  return text || undefined;
}

function parseUiCriteria(text: string): CriteriaNode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Malformed UI Segment Definition criteria');
  }
  validateUiNode(parsed, '$');
  const root = parsed as Record<string, unknown>;
  if (
    root.type !== 'LogicalComparison' ||
    !['and', 'or'].includes(String(root.operator)) ||
    !Array.isArray(root.filters) ||
    root.filters.length === 0
  )
    throw new Error('Unsupported UI Segment Definition criteria root');
  return parsed as CriteriaNode;
}

function validateUiNode(value: unknown, path: string): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateUiNode(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) throw new Error(`Unsupported UI Segment Definition value at ${path}`);
  const allowedKeys = new Set([
    'type',
    'operator',
    'filters',
    'filter',
    'path',
    'joinPath',
    'subject',
    'objectApiName',
    'fieldApiName',
    'selfReference',
    'subjectFieldDataType',
    'subjectFieldBusinessType',
    'containerObjectApiName',
    'aggregateFunction',
    'comparison',
    'value',
    'hierarchySelected',
    'hierarchicalPathList',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    throw new Error(`Unsupported UI Segment Definition field at ${path}`);
  for (const [key, child] of Object.entries(value)) validateUiNode(child, `${path}.${key}`);
}

async function parseDbtCriteria(text: string): Promise<DbtCriteria> {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsupported DBT Segment Definition declarations');
  let document: Record<string, unknown>;
  try {
    document = (await parseStringPromise(text, { explicitArray: true, explicitRoot: true, strict: true })) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error('Malformed DBT Segment Definition criteria');
  }
  if (Object.keys(document).length !== 1 || !isRecord(document.DbtPipeline))
    throw new Error('Unsupported DBT Segment Definition root');
  const pipeline = document.DbtPipeline as XmlElement;
  if (pipeline.$ && Object.keys(pipeline.$).some((key) => key !== 'xmlns'))
    throw new Error('Unsupported DBT attributes');
  if (pipeline.$?.xmlns !== '' && pipeline.$?.xmlns !== undefined) throw new Error('Unsupported DBT namespace');
  if (Object.keys(pipeline).some((key) => !['$', 'models'].includes(key)))
    throw new Error('Unsupported DBT criteria field');
  if (!Array.isArray(pipeline.models) || pipeline.models.length !== 1 || !isRecord(pipeline.models[0]))
    throw new Error('DBT criteria requires one models collection');
  const modelsNode = pipeline.models[0];
  if (
    Object.keys(modelsNode).some((key) => key !== 'model') ||
    !Array.isArray(modelsNode.model) ||
    modelsNode.model.length === 0
  )
    throw new Error('DBT criteria requires at least one model');
  const models = modelsNode.model.map((value, index) => parseDbtModel(value, index));
  return { format: 'DBT', models };
}

function parseDbtModel(value: unknown, index: number): DbtModel {
  if (!isRecord(value) || Object.keys(value).some((key) => !['name', 'sql'].includes(key)))
    throw new Error(`Unsupported DBT model at index ${index}`);
  const name = singleNonemptyString(value.name, `DBT model ${index} name`);
  const sql = singleNonemptyString(value.sql, `DBT model ${index} sql`);
  const match =
    /^SELECT\s+([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9]+)?)\.([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9]+)?)\s+FROM\s+([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9]+)?)\s+WHERE\s+1\s*=\s*0$/i.exec(
      sql.trim()
    );
  if (!match || match[1] !== match[3]) throw new Error(`Unsupported DBT SQL at model ${index}`);
  return { name, selectObject: match[3], selectField: match[2] };
}

function singleNonemptyString(value: unknown, label: string): string {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string' || !value[0].trim())
    throw new Error(`${label} must occur exactly once and be nonempty`);
  return value[0].trim();
}

function walkUiCriteria(value: CriteriaNode, path: string, references: SegmentReference[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkUiCriteria(item, `${path}[${index}]`, references));
    if (isRelationshipPath(path, value)) {
      value.forEach((edge, index) => {
        const pair = edge as CriteriaNode[];
        references.push({
          kind: 'relationship',
          value: `${endpointValue(pair[0])}->${endpointValue(pair[1])}`,
          path: `${path}[${index}]`,
        });
      });
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (typeof child === 'string' && key === 'objectApiName')
      references.push({ kind: classifyObjectReference(child), value: child, path: childPath });
    else if (typeof child === 'string' && key === 'containerObjectApiName')
      references.push({ kind: classifyObjectReference(child), value: child, path: childPath });
    else if (typeof child === 'string' && key === 'fieldApiName')
      references.push({ kind: 'field', value: child, path: childPath });
    walkUiCriteria(child as CriteriaNode, childPath, references);
  }
}

function mapUiCriteria(
  value: CriteriaNode,
  path: string,
  mappings: SegmentReferenceMapping[],
  useCounts: Map<string, number>
): CriteriaNode {
  if (Array.isArray(value)) {
    const relationships = isRelationshipPath(path, value)
      ? value.map((edge) => {
          const pair = edge as CriteriaNode[];
          return `${endpointValue(pair[0])}->${endpointValue(pair[1])}`;
        })
      : undefined;
    const mapped = value.map((item, index) => mapUiCriteria(item, `${path}[${index}]`, mappings, useCounts));
    if (relationships) {
      for (let index = 0; index < mapped.length; index++) {
        const relationshipMapping = mappings.find(
          (mapping) => mapping.kind === 'relationship' && mapping.source === relationships[index]
        );
        if (relationshipMapping) {
          mapped[index] = parseRelationshipTarget(relationshipMapping.target);
          incrementMappingUse(relationshipMapping, useCounts);
        }
      }
    }
    return mapped;
  }
  if (!isRecord(value)) return value;
  const mapped: Record<string, CriteriaNode> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && (key === 'objectApiName' || key === 'containerObjectApiName'))
      mapped[key] = mapReference(child, classifyObjectReference(child), mappings, useCounts);
    else if (typeof child === 'string' && key === 'fieldApiName')
      mapped[key] = mapReference(child, 'field', mappings, useCounts);
    else mapped[key] = mapUiCriteria(child as CriteriaNode, `${path}.${key}`, mappings, useCounts);
  }
  return mapped;
}

function validateMappings(mappingFile: SegmentDefinitionMappingFile): SegmentReferenceMapping[] {
  if (!isRecord(mappingFile) || mappingFile.schemaVersion !== 1 || !Array.isArray(mappingFile.segmentReferences))
    throw new Error('Unsupported Segment Definition mapping file');
  const allowedKinds = new Set<SegmentReferenceKind>(['dmo', 'unifiedDmo', 'linkDmo', 'field', 'relationship']);
  const sourceKeys = new Set<string>();
  const targetKeys = new Set<string>();
  return mappingFile.segmentReferences.map((value, index) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !['kind', 'source', 'target'].includes(key)))
      throw new Error(`Invalid Segment Definition mapping at index ${index}`);
    const { kind, source, target } = value;
    if (
      !allowedKinds.has(kind as SegmentReferenceKind) ||
      typeof source !== 'string' ||
      typeof target !== 'string' ||
      !source ||
      !target
    )
      throw new Error(`Invalid Segment Definition mapping at index ${index}`);
    const mapping = { kind: kind as SegmentReferenceKind, source, target };
    validateMappingValue(mapping);
    const sourceKey = mappingKey(mapping);
    const targetKey = `${mapping.kind}:${mapping.target}`;
    if (sourceKeys.has(sourceKey)) throw new Error(`Duplicate Segment Definition mapping: ${sourceKey}`);
    if (targetKeys.has(targetKey)) throw new Error(`Ambiguous Segment Definition mapping target: ${targetKey}`);
    sourceKeys.add(sourceKey);
    targetKeys.add(targetKey);
    return mapping;
  });
}

function validateMappingValue(mapping: SegmentReferenceMapping): void {
  if (mapping.kind === 'relationship') {
    parseRelationshipTarget(mapping.source);
    parseRelationshipTarget(mapping.target);
  } else if (!apiNamePattern.test(mapping.source) || !apiNamePattern.test(mapping.target)) {
    throw new Error(`Invalid Segment Definition ${mapping.kind} mapping value`);
  }
}

function mapReference(
  value: string,
  kind: SegmentReferenceKind,
  mappings: SegmentReferenceMapping[],
  useCounts: Map<string, number>
): string {
  const mapping = mappings.find((candidate) => candidate.kind === kind && candidate.source === value);
  if (!mapping) return value;
  incrementMappingUse(mapping, useCounts);
  return mapping.target;
}

function incrementMappingUse(mapping: SegmentReferenceMapping, useCounts: Map<string, number>): void {
  const key = mappingKey(mapping);
  useCounts.set(key, (useCounts.get(key) ?? 0) + 1);
}

function mappingKey(mapping: SegmentReferenceMapping): string {
  return `${mapping.kind}:${mapping.source}`;
}

function classifyObjectReference(value: string): Exclude<SegmentReferenceKind, 'field' | 'relationship'> {
  if (value.startsWith('UnifiedLink')) return 'linkDmo';
  if (value.startsWith('Unified')) return 'unifiedDmo';
  return 'dmo';
}

function endpointValue(value: CriteriaNode): string {
  if (!isRecord(value) || typeof value.objectApiName !== 'string' || typeof value.fieldApiName !== 'string')
    throw new Error('Unsupported Segment Definition relationship endpoint');
  return `${value.objectApiName}.${value.fieldApiName}`;
}

function parseRelationshipTarget(value: string): CriteriaNode[] {
  const match =
    /^([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9]+)?)\.([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9]+)?)->([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9]+)?)\.([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9]+)?)$/.exec(
      value
    );
  if (!match) throw new Error('Invalid Segment Definition relationship mapping');
  return [
    { objectApiName: match[1], fieldApiName: match[2] },
    { objectApiName: match[3], fieldApiName: match[4] },
  ];
}

function isRelationshipPath(path: string, value: CriteriaNode[]): boolean {
  return (
    (path.endsWith('.path') || path.endsWith('.joinPath')) &&
    value.every((item) => Array.isArray(item) && item.length === 2)
  );
}

function validateMappedDefinition(definition: SegmentDefinition): void {
  if (definition.includeCriteria.format === 'UI') {
    const serialized = JSON.stringify(definition.includeCriteria.value);
    parseUiCriteria(serialized);
  } else {
    for (const model of definition.includeCriteria.models) {
      if (!apiNamePattern.test(model.selectObject) || !apiNamePattern.test(model.selectField) || !model.name.trim())
        throw new Error('Invalid transformed DBT Segment Definition criteria');
    }
  }
}

function canonicalizeCriteria(value: CriteriaNode): CriteriaNode {
  if (Array.isArray(value)) return value.map(canonicalizeCriteria);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeCriteria(value[key] as CriteriaNode)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
