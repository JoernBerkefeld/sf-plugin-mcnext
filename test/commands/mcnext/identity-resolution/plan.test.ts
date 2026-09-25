import { readFile } from 'node:fs/promises';
import { expect } from 'chai';
import { McnClient, type RequestOptions } from '../../../../src/client/mcnClient.js';
import {
  buildIdentityResolutionPlan,
  parseIdentityResolutionPlanInput,
} from '../../../../src/identityResolution/identityResolutionPlan.js';

const source = {
  configuration: {
    label: 'Marketing',
    dataSpaceName: 'source-space',
    objectApiName: 'SourceIndividual__dlm',
    secondaryDmo: 'SourceEmail__dlm',
    filters: [{ field: 'SourceIndividual__dlm.Status__c', operator: 'EQUALS', value: 'Active' }],
    matchRules: [{ label: 'Email', criteria: [{ field: 'SourceEmail__dlm.Email__c' }] }],
    reconciliationRules: [
      {
        entityName: 'SourceIndividual__dlm',
        fields: ['SourceIndividual__dlm.FirstName__c'],
        linkDmoName: 'SourceIndividualLink__dlm',
        ruleType: 'SOURCE_PRIORITY',
        shouldIgnoreEmptyValue: true,
        sources: ['SourceIndividual__dlm'],
        unifiedDmoName: 'UnifiedIndividual__dlm',
      },
    ],
  },
  mappings: [
    { field: 'dataSpaceName', source: 'source-space', target: 'target-space' },
    { field: 'objectApiName', source: 'SourceIndividual__dlm', target: 'TargetIndividual__dlm' },
    {
      field: 'matchRules[0].criteria[0].field',
      source: 'SourceEmail__dlm.Email__c',
      target: 'TargetEmail__dlm.Email__c',
    },
    {
      field: 'reconciliationRules[0].sources[0]',
      source: 'SourceIndividual__dlm',
      target: 'TargetIndividual__dlm',
    },
  ],
};

function clientWith(handler: (request: RequestOptions) => unknown): McnClient {
  return { request: async (request: RequestOptions) => handler(request) } as McnClient;
}

describe('identity-resolution mutation-free planner', () => {
  it('parses the synthetic source fixture', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/source-plan.json', import.meta.url), 'utf8')
    ) as unknown;
    expect(parseIdentityResolutionPlanInput(fixture)).to.deep.equal(parseIdentityResolutionPlanInput(source));
  });

  it('rejects unknown top-level and nested fields', () => {
    expect(() => parseIdentityResolutionPlanInput({ ...source, extra: true })).to.throw(
      'Unsupported plan input field(s): extra'
    );
    expect(() =>
      parseIdentityResolutionPlanInput({
        ...source,
        configuration: {
          ...source.configuration,
          matchRules: [{ label: 'Email', criteria: [{ field: 'x', typo: 1 }] }],
        },
      })
    ).to.throw('Unsupported configuration.matchRules[0].criteria[0] field(s): typo');
  });

  it('rejects undeclared, duplicate and mismatched family-local mappings', async () => {
    expect(() =>
      parseIdentityResolutionPlanInput({
        ...source,
        mappings: [{ field: 'matchRules[0].label', source: 'Email', target: 'Other' }],
      })
    ).to.throw('Unsupported identity-resolution mapping field matchRules[0].label');
    expect(() =>
      parseIdentityResolutionPlanInput({
        ...source,
        mappings: [source.mappings[0], source.mappings[0]],
      })
    ).to.throw('Duplicate mapping field dataSpaceName');

    const parsed = parseIdentityResolutionPlanInput({
      ...source,
      mappings: [{ field: 'objectApiName', source: 'Wrong__dlm', target: 'Target__dlm' }],
    });
    let error: unknown;
    try {
      await buildIdentityResolutionPlan(
        clientWith(() => ({ identityResolutions: [] })),
        parsed,
        { intent: 'create' }
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.include('Mapping source mismatch at objectApiName');
  });

  it('returns the explicitly selected blocked create intent when the exact target is absent', async () => {
    const requests: RequestOptions[] = [];
    const plan = await buildIdentityResolutionPlan(
      clientWith((request) => {
        requests.push(request);
        return { identityResolutions: [] };
      }),
      parseIdentityResolutionPlanInput(source),
      { intent: 'create' }
    );

    expect(requests).to.deep.equal([{ path: '/ssot/identity-resolutions' }]);
    expect(plan.intent).to.equal('create');
    expect(plan.target).to.deep.equal({ label: 'Marketing', key: 'TargetIndividual__dlm' });
    expect(plan.sourceProjection.dataSpaceName).to.equal('target-space');
    expect(plan.sourceProjection.objectApiName).to.equal('TargetIndividual__dlm');
    expect(plan.sourceProjection.matchRules[0].criteria[0].field).to.equal('TargetEmail__dlm.Email__c');
    expect(plan.checkpoints.createWritableSchema.state).to.equal('blocked');
    expect(plan.checkpoints.patchWritableSchema.state).to.equal('blocked');
    expect(plan.checkpoints.lifecycle.state).to.equal('blocked');
    expect(plan).not.to.have.property('prospectiveRequestBody');
    expect(plan.allowedMethods).to.deep.equal(['GET']);
    expect(plan.forbiddenPaths).to.deep.equal(['POST', 'PATCH', 'publication', 'scheduling', 'run-now']);
    expect(source.configuration.dataSpaceName).to.equal('source-space');
  });

  it('rejects an exact CREATE conflict without switching intent', async () => {
    let error: unknown;
    try {
      await buildIdentityResolutionPlan(
        clientWith(() => ({
          identityResolutions: [
            { rulesetId: '1iraj000000VkBeAAK', label: 'Marketing', objectApiName: 'TargetIndividual__dlm' },
          ],
        })),
        parseIdentityResolutionPlanInput(source),
        { intent: 'create' }
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.include('CREATE target already exists');
  });

  it('returns explicit update-shell intent and semantic differences from an exact target', async () => {
    const requests: RequestOptions[] = [];
    const target = structuredClone(source.configuration);
    target.dataSpaceName = 'target-space';
    target.objectApiName = 'TargetIndividual__dlm';
    target.matchRules[0].criteria[0].field = 'TargetEmail__dlm.Email__c';
    target.reconciliationRules[0].sources[0] = 'TargetIndividual__dlm';
    target.filters[0].value = 'Inactive';
    const targetResponse = JSON.parse(
      await readFile(new URL('./fixtures/target-read.json', import.meta.url), 'utf8')
    ) as typeof target & { rulesetId: string; rulesetStatus: string; lastJobStatus: string };

    const plan = await buildIdentityResolutionPlan(
      clientWith((request) => {
        requests.push(request);
        return requests.length === 1
          ? {
              identityResolutions: [
                { rulesetId: '1iraj000000VkBeAAK', label: 'Marketing', objectApiName: 'TargetIndividual__dlm' },
              ],
            }
          : targetResponse;
      }),
      parseIdentityResolutionPlanInput(source),
      {
        intent: 'update-shell',
        expectedTarget: {
          rulesetId: '1iraj000000VkBeAAK',
          label: 'Marketing',
          key: 'TargetIndividual__dlm',
          status: 'DRAFT',
        },
      }
    );

    expect(requests).to.deep.equal([
      { path: '/ssot/identity-resolutions' },
      { path: '/ssot/identity-resolutions/1iraj000000VkBeAAK' },
    ]);
    expect(plan.intent).to.equal('update-shell');
    expect(plan.target.rulesetId).to.equal('1iraj000000VkBeAAK');
    expect(plan.differences).to.deep.equal(
      [
        { field: 'filters[0].field', source: 'SourceIndividual__dlm.Status__c', target: target.filters[0].field },
        { field: 'filters[0].value', source: 'Active', target: 'Inactive' },
        {
          field: 'reconciliationRules[0].entityName',
          source: 'SourceIndividual__dlm',
          target: target.reconciliationRules[0].entityName,
        },
        {
          field: 'reconciliationRules[0].fields[0]',
          source: 'SourceIndividual__dlm.FirstName__c',
          target: target.reconciliationRules[0].fields[0],
        },
        { field: 'secondaryDmo', source: 'SourceEmail__dlm', target: 'SourceEmail__dlm' },
      ].filter((difference) => difference.source !== difference.target)
    );
    expect(plan).not.to.have.property('prospectiveRequestBody');
  });

  it('rejects absent, ambiguous, ID-mismatched and detail-mismatched update targets without becoming create', async () => {
    const expectedTarget = {
      rulesetId: '1iraj000000VkBeAAK',
      label: 'Marketing',
      key: 'TargetIndividual__dlm',
      status: 'DRAFT',
    };
    const cases = [
      {
        responses: [{ identityResolutions: [] }],
        message: 'UPDATE target was not found',
      },
      {
        responses: [
          {
            identityResolutions: [
              { ...expectedTarget, objectApiName: expectedTarget.key },
              { ...expectedTarget, rulesetId: '1iraj000000VkBfAAK', objectApiName: expectedTarget.key },
            ],
          },
        ],
        message: 'target identity is ambiguous',
      },
      {
        responses: [
          {
            identityResolutions: [
              { rulesetId: '1iraj000000VkBfAAK', label: expectedTarget.label, objectApiName: expectedTarget.key },
            ],
          },
        ],
        message: 'ruleset ID mismatch',
      },
      {
        responses: [
          {
            identityResolutions: [
              { rulesetId: expectedTarget.rulesetId, label: expectedTarget.label, objectApiName: expectedTarget.key },
            ],
          },
          {
            ...source.configuration,
            objectApiName: expectedTarget.key,
            rulesetId: expectedTarget.rulesetId,
            rulesetStatus: 'PUBLISHED',
          },
        ],
        message: 'identity or status mismatch',
      },
    ];
    const results = await Promise.all(
      cases.map(async (testCase) => {
        let call = 0;
        let error: unknown;
        try {
          await buildIdentityResolutionPlan(
            clientWith(() => testCase.responses[call++]),
            parseIdentityResolutionPlanInput(source),
            { intent: 'update-shell', expectedTarget }
          );
        } catch (caught) {
          error = caught;
        }
        return { error, message: testCase.message };
      })
    );
    for (const result of results) expect(String(result.error)).to.include(result.message);
  });
});
