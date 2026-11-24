import type { Connection } from '@salesforce/core';

export type Row = Record<string, unknown>;
export type FieldSpec = { name: string; createable?: boolean; updateable?: boolean; relationshipName?: string };

export type FakeOrg = {
  connection: Connection;
  campaigns: Row[];
  queries: string[];
  creates: Row[];
  updates: Row[];
  destroys: string[];
  /** Replace the answer of the next writes: return a save result or throw. */
  onWrite?: (kind: 'create' | 'update' | 'destroy') => unknown;
  /** Throw on every query containing this text. */
  failQuery?: string;
  failDescribe?: boolean;
};

const writable = (name: string, relationshipName?: string): FieldSpec => ({
  name,
  createable: true,
  updateable: true,
  relationshipName,
});

const COMMON: FieldSpec[] = [
  { name: 'Id' },
  writable('Name'),
  writable('Description'),
  writable('Status'),
  writable('StartDate'),
  writable('IsActive'),
  writable('BudgetedCost'),
  writable('OwnerId', 'Owner'),
  writable('RecordTypeId', 'RecordType'),
  writable('ParentId', 'Parent'),
  { name: 'NumberOfLeads' },
  { name: 'CreatedDate' },
];

/** Campaign fields of an org with Marketing Cloud Next business units. */
export const ENABLED_FIELDS: FieldSpec[] = [
  ...COMMON,
  writable('Stage'),
  writable('BriefId', 'Brief'),
  { name: 'BusinessUnitId', createable: true, updateable: false, relationshipName: 'BusinessUnit' },
];

/** Campaign fields of an org without the business-unit feature. */
export const DISABLED_FIELDS: FieldSpec[] = [...COMMON, writable('Stage'), writable('BriefId', 'Brief')];

export const BUSINESS_UNITS: Row[] = [
  { Id: '1QO000000000001AAA', DeveloperName: 'defaultBusinessUnit' },
  { Id: '1QO000000000002AAA', DeveloperName: 'otherBusinessUnit' },
];

const LITERAL = "'(?:[^'\\\\]|\\\\.)*'";
const CONDITION = new RegExp(`(\\w+) (=|IN) (\\(${LITERAL}(?:, ${LITERAL})*\\)|${LITERAL}|null)(?: AND |$)`, 'uy');

/** `values: null` is `field = null`. */
type Condition = { field: string; values: string[] | null };

function conditionsOf(where: string): Condition[] {
  const conditions: Condition[] = [];
  CONDITION.lastIndex = 0;
  while (CONDITION.lastIndex < where.length) {
    const match = CONDITION.exec(where);
    if (!match) throw new Error(`MALFORMED_QUERY: ${where}`);
    const values = [...match[3].matchAll(new RegExp(LITERAL, 'gu'))].map((literal) =>
      literal[0].slice(1, -1).replace(/\\(.)/gu, '$1')
    );
    conditions.push({ field: match[1], values: match[3] === 'null' ? null : values });
  }
  return conditions;
}

function salesforceError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode, name: errorCode });
}

export function fakeOrg(input: {
  fields?: FieldSpec[];
  campaigns?: Row[];
  businessUnits?: Row[];
  briefs?: Row[];
}): FakeOrg {
  const fields = input.fields ?? ENABLED_FIELDS;
  const tables: Record<string, Row[]> = {
    Campaign: (input.campaigns ?? []).map((row) => ({ ...row })),
    BusinessUnit: input.businessUnits ?? BUSINESS_UNITS,
    Brief: input.briefs ?? [],
  };
  const related: Record<string, string> = { Parent: 'Campaign', BusinessUnit: 'BusinessUnit', Brief: 'Brief' };
  let nextId = 1;
  const org: FakeOrg = {
    connection: undefined as unknown as Connection,
    campaigns: tables.Campaign,
    queries: [],
    creates: [],
    updates: [],
    destroys: [],
  };

  const checkCampaignField = (field: string): void => {
    const base = field.includes('.') ? `${field.split('.')[0]}Id` : field;
    if (!fields.some((spec) => spec.name === base))
      throw salesforceError('INVALID_FIELD', `No such column '${field}' on entity 'Campaign'.`);
  };

  const project = (row: Row, select: string[], type: string): Row => {
    const out: Row = { attributes: { type } };
    for (const field of select) {
      if (field.includes('.')) {
        const [relationship, column] = field.split('.');
        const target = tables[related[relationship]].find((candidate) => candidate.Id === row[`${relationship}Id`]);
        out[relationship] = target ? { attributes: { type: related[relationship] }, [column]: target[column] } : null;
      } else out[field] = row[field] ?? null;
    }
    return out;
  };

  const query = async (soql: string) => {
    org.queries.push(soql);
    if (org.failQuery && soql.includes(org.failQuery)) throw new Error('getaddrinfo ENOTFOUND org.example');
    const match = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+))?$/u.exec(soql);
    if (!match) throw salesforceError('MALFORMED_QUERY', soql);
    const select = match[1].split(', ');
    const type = match[2];
    const conditions = match[3] ? conditionsOf(match[3]) : [];
    if (type === 'Campaign')
      for (const field of [...select, ...conditions.map((c) => c.field)]) checkCampaignField(field);
    // SOQL compares text without regard to case.
    const records = tables[type]
      .filter((row) =>
        conditions.every(({ field, values }) =>
          values === null
            ? row[field] === null || row[field] === undefined
            : values.some((value) => String(row[field] ?? '').toLowerCase() === value.toLowerCase())
        )
      )
      .map((row) => project(row, select, type));
    return { done: true, totalSize: records.length, records };
  };

  const answer = (kind: 'create' | 'update' | 'destroy'): unknown => org.onWrite?.(kind);

  const campaign = {
    describe: async () => describe(),
    create: async (record: Row) => {
      org.creates.push(record);
      const custom = answer('create');
      if (custom !== undefined) return custom;
      const id = `701${String(nextId++).padStart(12, '0')}AAA`;
      tables.Campaign.push({ ...record, Id: id });
      return { success: true, id, errors: [] };
    },
    update: async (record: Row) => {
      org.updates.push(record);
      const custom = answer('update');
      if (custom !== undefined) return custom;
      if ('BusinessUnitId' in record)
        throw salesforceError('FIELD_INTEGRITY_EXCEPTION', 'Business Unit for Campaign is non editable');
      Object.assign(tables.Campaign.find((row) => row.Id === record.Id) ?? {}, record);
      return { success: true, id: record.Id, errors: [] };
    },
    destroy: async (id: string) => {
      org.destroys.push(id);
      const custom = answer('destroy');
      if (custom !== undefined) return custom;
      const index = tables.Campaign.findIndex((row) => row.Id === id);
      if (index !== -1) tables.Campaign.splice(index, 1);
      return { success: true, id, errors: [] };
    },
  };

  function describe() {
    if (org.failDescribe) throw new Error('getaddrinfo ENOTFOUND org.example');
    return {
      fields: fields.map((spec) => ({
        name: spec.name,
        createable: spec.createable ?? false,
        updateable: spec.updateable ?? false,
        relationshipName: spec.relationshipName ?? null,
      })),
    };
  }

  org.connection = {
    getApiVersion: () => '68.0',
    describe: async () => describe(),
    query,
    sobject: () => campaign,
  } as unknown as Connection;
  return org;
}
