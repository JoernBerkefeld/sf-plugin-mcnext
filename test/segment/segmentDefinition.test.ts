import { readFile } from 'node:fs/promises';
import { expect } from 'chai';
import {
  applySegmentDefinitionMappings,
  compareSegmentDefinitions,
  inventorySegmentDefinitionReferences,
  parseSegmentDefinitionXml,
  projectSegmentDefinition,
  serializeSegmentDefinitionCriteria,
  type SegmentDefinitionMappingFile,
} from '../../src/segment/segmentDefinition.js';

const uiMember = 'ui-synthetic';
const dbtMember = 'dbt-synthetic';
const uiPath = 'test/segment/fixtures/ui-synthetic.marketSegmentDefinition-meta.xml';
const dbtPath = 'test/segment/fixtures/dbt-synthetic.marketSegmentDefinition-meta.xml';

const uiMappings: SegmentDefinitionMappingFile = {
  schemaVersion: 1,
  segmentReferences: [
    { kind: 'unifiedDmo', source: 'UnifiedSyntheticSource__dlm', target: 'UnifiedSyntheticTarget__dlm' },
    { kind: 'linkDmo', source: 'UnifiedLinkSyntheticSource__dlm', target: 'UnifiedLinkSyntheticTarget__dlm' },
    { kind: 'dmo', source: 'SyntheticSourceDmo__dlm', target: 'SyntheticTargetDmo__dlm' },
    { kind: 'field', source: 'SyntheticSourceField__c', target: 'SyntheticTargetField__c' },
    { kind: 'field', source: 'SyntheticUnifiedId__c', target: 'SyntheticTargetUnifiedId__c' },
    { kind: 'field', source: 'SyntheticUnifiedRecordId__c', target: 'SyntheticTargetUnifiedRecordId__c' },
    { kind: 'field', source: 'SyntheticSourceRecordId__c', target: 'SyntheticTargetSourceRecordId__c' },
    { kind: 'field', source: 'SyntheticSourceId__c', target: 'SyntheticTargetSourceId__c' },
    {
      kind: 'relationship',
      source:
        'UnifiedSyntheticSource__dlm.SyntheticUnifiedId__c->UnifiedLinkSyntheticSource__dlm.SyntheticUnifiedRecordId__c',
      target:
        'UnifiedSyntheticTarget__dlm.SyntheticTargetUnifiedId__c->UnifiedLinkSyntheticTarget__dlm.SyntheticTargetUnifiedRecordId__c',
    },
    {
      kind: 'relationship',
      source:
        'UnifiedLinkSyntheticSource__dlm.SyntheticSourceRecordId__c->SyntheticSourceDmo__dlm.SyntheticSourceId__c',
      target:
        'UnifiedLinkSyntheticTarget__dlm.SyntheticTargetSourceRecordId__c->SyntheticTargetDmo__dlm.SyntheticTargetSourceId__c',
    },
  ],
};

async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected rejection');
}

async function uiFixture(): Promise<string> {
  return readFile(uiPath, 'utf8');
}

async function dbtFixture(): Promise<string> {
  return readFile(dbtPath, 'utf8');
}

describe('Segment Definition local model', () => {
  it('parses exactly one supported UI definition and inventories declared dependency paths', async () => {
    const definition = await parseSegmentDefinitionXml(await uiFixture(), uiMember, uiPath);
    const references = inventorySegmentDefinitionReferences(definition);

    expect(definition.segmentType).to.equal('UI');
    expect(definition.segmentOn).to.equal('UnifiedSyntheticSource__dlm');
    expect(references).to.deep.include.members([
      { kind: 'unifiedDmo', value: 'UnifiedSyntheticSource__dlm', path: 'segmentOn' },
      {
        kind: 'dmo',
        value: 'SyntheticSourceDmo__dlm',
        path: 'includeCriteria.filters[0].filter.subject.objectApiName',
      },
      {
        kind: 'field',
        value: 'SyntheticSourceField__c',
        path: 'includeCriteria.filters[0].filter.subject.fieldApiName',
      },
      {
        kind: 'relationship',
        value:
          'UnifiedSyntheticSource__dlm.SyntheticUnifiedId__c->UnifiedLinkSyntheticSource__dlm.SyntheticUnifiedRecordId__c',
        path: 'includeCriteria.filters[0].path[0]',
      },
    ]);
  });

  it('parses supported bounded DBT criteria and roundtrips transformed criteria', async () => {
    const definition = await parseSegmentDefinitionXml(await dbtFixture(), dbtMember, dbtPath);
    expect(definition.includeCriteria).to.deep.equal({
      format: 'DBT',
      models: [
        {
          name: 'SyntheticModel',
          selectObject: 'UnifiedSyntheticSource__dlm',
          selectField: 'SyntheticUnifiedId__c',
        },
      ],
    });

    const criteriaXml = serializeSegmentDefinitionCriteria(definition.includeCriteria);
    const reparsed = await parseSegmentDefinitionXml(
      (
        await dbtFixture()
      ).replace(
        /<includeCriteria>[\s\S]*?<\/includeCriteria>/,
        `<includeCriteria>${escapeXml(criteriaXml)}</includeCriteria>`
      ),
      dbtMember,
      dbtPath
    );
    expect(projectSegmentDefinition(reparsed)).to.deep.equal(projectSegmentDefinition(definition));
  });

  it('rejects wrong roots, namespace, declarations, mismatch, empty fields and duplicate fields', async () => {
    const xml = await uiFixture();
    const cases = [
      {
        value: xml.replaceAll('MarketSegmentDefinition', 'OtherDefinition'),
        message: 'root',
      },
      { value: xml.replace('http://soap.sforce.com/2006/04/metadata', 'urn:wrong'), message: 'namespace' },
      {
        value: xml.replace('<MarketSegmentDefinition', '<!DOCTYPE x><MarketSegmentDefinition'),
        message: 'declarations',
      },
      {
        value: xml.replace('<masterLabel>Synthetic UI Segment</masterLabel>', '<masterLabel> </masterLabel>'),
        message: 'masterLabel',
      },
      {
        value: xml.replace(
          '</MarketSegmentDefinition>',
          '<masterLabel>Duplicate</masterLabel></MarketSegmentDefinition>'
        ),
        message: 'masterLabel',
      },
      { value: xml.replace('</MarketSegmentDefinition>', ''), message: 'Malformed' },
    ];
    const errors = await Promise.all(
      cases.map(async (item) => ({
        error: await errorFrom(parseSegmentDefinitionXml(item.value, uiMember, uiPath)),
        message: item.message,
      }))
    );
    for (const item of errors) expect(item.error.message).to.contain(item.message);
    const mismatch = await errorFrom(parseSegmentDefinitionXml(xml, 'different-member', uiPath));
    expect(mismatch.message).to.contain('member and file name');
  });

  it('rejects malformed or unsupported UI criteria without flattening nested order', async () => {
    const xml = await uiFixture();
    const malformed = await errorFrom(
      parseSegmentDefinitionXml(xml.replace('{"type":"LogicalComparison"', '{broken'), uiMember, uiPath)
    );
    expect(malformed.message).to.contain('Malformed UI');

    const unsupported = await errorFrom(
      parseSegmentDefinitionXml(xml.replace('"hierarchicalPathList":null', '"unexpected":null'), uiMember, uiPath)
    );
    expect(unsupported.message).to.contain('Unsupported UI');

    const emptyFilters = await errorFrom(
      parseSegmentDefinitionXml(xml.replace(/"filters":\[\{[\s\S]*\}\]\}/, '"filters":[]}'), uiMember, uiPath)
    );
    expect(emptyFilters.message).to.contain('criteria root');
  });

  it('rejects malformed or unsupported DBT criteria', async () => {
    const xml = await dbtFixture();
    const malformed = await errorFrom(
      parseSegmentDefinitionXml(xml.replace('&lt;/DbtPipeline&gt;', ''), dbtMember, dbtPath)
    );
    expect(malformed.message).to.contain('Malformed DBT');

    const unsupportedSql = await errorFrom(
      parseSegmentDefinitionXml(
        xml.replace('WHERE 1 = 0', 'WHERE SyntheticUnifiedId__c IS NOT NULL'),
        dbtMember,
        dbtPath
      )
    );
    expect(unsupportedSql.message).to.contain('Unsupported DBT SQL');

    const unsupportedType = await errorFrom(
      parseSegmentDefinitionXml(
        xml.replace('<segmentType>DBT</segmentType>', '<segmentType>SQL</segmentType>'),
        dbtMember,
        dbtPath
      )
    );
    expect(unsupportedType.message).to.contain('criteria type');
  });

  it('applies exact synthetic mappings only at declared paths and leaves the source unchanged', async () => {
    const source = await parseSegmentDefinitionXml(await uiFixture(), uiMember, uiPath);
    const sourceProjection = projectSegmentDefinition(source);
    const mapped = applySegmentDefinitionMappings(source, uiMappings);
    const mappedReferences = inventorySegmentDefinitionReferences(mapped);

    expect(projectSegmentDefinition(source)).to.deep.equal(sourceProjection);
    expect(mapped.segmentOn).to.equal('UnifiedSyntheticTarget__dlm');
    expect(mappedReferences.some((reference) => reference.value.includes('SyntheticSource'))).to.equal(false);
    expect(serializeSegmentDefinitionCriteria(mapped.includeCriteria))
      .to.be.a('string')
      .and.not.to.contain('SyntheticSource');
  });

  it('rejects missing, duplicate, ambiguous, unknown and unused mappings', async () => {
    const source = await parseSegmentDefinitionXml(await uiFixture(), uiMember, uiPath);
    const scenarios: Array<{ mappings: SegmentDefinitionMappingFile; message: string }> = [
      {
        mappings: {
          schemaVersion: 1,
          segmentReferences: uiMappings.segmentReferences.slice(0, -1),
        },
        message: 'Missing',
      },
      {
        mappings: {
          schemaVersion: 1,
          segmentReferences: [uiMappings.segmentReferences[0], uiMappings.segmentReferences[0]],
        },
        message: 'Duplicate',
      },
      {
        mappings: {
          schemaVersion: 1,
          segmentReferences: [
            ...uiMappings.segmentReferences,
            { kind: 'unifiedDmo', source: 'UnifiedOtherSource__dlm', target: 'UnifiedSyntheticTarget__dlm' },
          ],
        },
        message: 'Ambiguous',
      },
      {
        mappings: {
          schemaVersion: 1,
          segmentReferences: [
            ...uiMappings.segmentReferences,
            { kind: 'not-supported' as 'dmo', source: 'OtherSource__dlm', target: 'OtherTarget__dlm' },
          ],
        },
        message: 'Invalid',
      },
      {
        mappings: {
          schemaVersion: 1,
          segmentReferences: [
            ...uiMappings.segmentReferences,
            { kind: 'dmo', source: 'UnusedSource__dlm', target: 'UnusedTarget__dlm' },
          ],
        },
        message: 'Unused',
      },
    ];
    for (const scenario of scenarios) {
      let error: unknown;
      try {
        applySegmentDefinitionMappings(source, scenario.mappings);
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.contain(scenario.message);
    }
  });

  it('rejects omitted, malformed and duplicate relationship mappings', async () => {
    const source = await parseSegmentDefinitionXml(await uiFixture(), uiMember, uiPath);
    const relationshipMappings = uiMappings.segmentReferences.filter((entry) => entry.kind === 'relationship');
    const scenarios: Array<{ mappings: SegmentDefinitionMappingFile; message: string }> = [
      {
        mappings: {
          schemaVersion: 1,
          segmentReferences: uiMappings.segmentReferences.filter((entry) => entry !== relationshipMappings[0]),
        },
        message: `Missing Segment Definition mapping: relationship:${relationshipMappings[0].source}`,
      },
      {
        mappings: {
          schemaVersion: 1,
          segmentReferences: uiMappings.segmentReferences.map((entry) =>
            entry === relationshipMappings[0] ? { ...entry, target: 'malformed' } : entry
          ),
        },
        message: 'Invalid Segment Definition relationship mapping',
      },
      {
        mappings: {
          schemaVersion: 1,
          segmentReferences: [...uiMappings.segmentReferences, relationshipMappings[0]],
        },
        message: `Duplicate Segment Definition mapping: relationship:${relationshipMappings[0].source}`,
      },
    ];

    for (const scenario of scenarios) {
      expect(() => applySegmentDefinitionMappings(source, scenario.mappings)).to.throw(scenario.message);
    }
  });

  it('counts an explicitly traversed scalar identity mapping as resolved', async () => {
    const source = await parseSegmentDefinitionXml(await uiFixture(), uiMember, uiPath);
    const mapping: SegmentDefinitionMappingFile = {
      schemaVersion: 1,
      segmentReferences: uiMappings.segmentReferences.map((entry) =>
        entry.kind === 'unifiedDmo' && entry.source === 'UnifiedSyntheticSource__dlm'
          ? { ...entry, target: entry.source }
          : entry
      ),
    };

    const mapped = applySegmentDefinitionMappings(source, mapping);

    expect(mapped.segmentOn).to.equal('UnifiedSyntheticSource__dlm');
  });

  it('counts an explicitly traversed relationship identity mapping as resolved', async () => {
    const source = await parseSegmentDefinitionXml(await uiFixture(), uiMember, uiPath);
    const relationship =
      'UnifiedSyntheticSource__dlm.SyntheticUnifiedId__c->UnifiedLinkSyntheticSource__dlm.SyntheticUnifiedRecordId__c';
    const mapping: SegmentDefinitionMappingFile = {
      schemaVersion: 1,
      segmentReferences: uiMappings.segmentReferences.map((entry) => ({ ...entry, target: entry.source })),
    };

    const mapped = applySegmentDefinitionMappings(source, mapping);

    expect(inventorySegmentDefinitionReferences(mapped)).to.deep.include({
      kind: 'relationship',
      value: relationship,
      path: 'includeCriteria.filters[0].path[0]',
    });
  });

  it('still rejects a genuinely absent required mapping', async () => {
    const source = await parseSegmentDefinitionXml(await uiFixture(), uiMember, uiPath);
    const mapping: SegmentDefinitionMappingFile = {
      schemaVersion: 1,
      segmentReferences: uiMappings.segmentReferences.filter(
        (entry) => !(entry.kind === 'field' && entry.source === 'SyntheticSourceField__c')
      ),
    };

    expect(() => applySegmentDefinitionMappings(source, mapping)).to.throw(
      'Missing Segment Definition mapping: field:SyntheticSourceField__c'
    );
  });

  it('compares the full projection, canonicalizes object keys and preserves meaningful array order', async () => {
    const sourceXml = await uiFixture();
    const source = await parseSegmentDefinitionXml(sourceXml, uiMember, uiPath);
    const reorderedKeys = await parseSegmentDefinitionXml(
      sourceXml.replace(
        '"type":"LogicalComparison","operator":"and","filters"',
        '"operator":"and","type":"LogicalComparison","filters"'
      ),
      uiMember,
      uiPath
    );
    expect(compareSegmentDefinitions(source, reorderedKeys)).to.include({ equal: true });

    const reorderedPath = await parseSegmentDefinitionXml(
      sourceXml.replace(
        '"path":[[{"objectApiName":"UnifiedSyntheticSource__dlm","fieldApiName":"SyntheticUnifiedId__c"},{"objectApiName":"UnifiedLinkSyntheticSource__dlm","fieldApiName":"SyntheticUnifiedRecordId__c"}]]',
        '"path":[[{"objectApiName":"UnifiedLinkSyntheticSource__dlm","fieldApiName":"SyntheticUnifiedRecordId__c"},{"objectApiName":"UnifiedSyntheticSource__dlm","fieldApiName":"SyntheticUnifiedId__c"}]]'
      ),
      uiMember,
      uiPath
    );
    const comparison = compareSegmentDefinitions(source, reorderedPath);
    expect(comparison.equal).to.equal(false);
    expect(comparison.differences).to.deep.equal(['includeCriteria']);
  });
});

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
