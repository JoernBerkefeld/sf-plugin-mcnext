import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect } from 'chai';
import { parseStringPromise } from 'xml2js';
const root = resolve('test/demo-project');
const expected = [
  ['sfdx-project.json', 'project', 'core-sf', 'existing-shape', 'existing-layout'],
  ['force-app/main/default/flows/Autumn_Welcome.flow-meta.xml', 'flow', 'core-sf', 'existing-shape', 'existing-layout'],
  ['mcnext/campaigns/Autumn_Promo.mcn-campaign.json', 'campaign', 'core-sf', 'proposed-shape', 'proposed-layout'],
  [
    'mcnext/segment-data/Autumn_Audience.mcn-segment-members.csv',
    'segment-members',
    'mcnext',
    'existing-shape',
    'proposed-layout',
  ],
  [
    'mcnext/segment-data/MarketSegment.mcn-segment-records.csv',
    'segment-records',
    'core-sf',
    'existing-shape',
    'proposed-layout',
  ],
  [
    'cms/Demo_Workspace/email/Autumn_Welcome.cms-email.json',
    'cms-email',
    'sf-plugin-cms',
    'local-candidate-shape',
    'local-candidate-layout',
  ],
  [
    'cms/Demo_Workspace/image/Autumn_Banner.cms-image.json',
    'proposed-cms-image',
    'sf-plugin-cms',
    'proposed-shape',
    'proposed-layout',
  ],
];
type Entry = {
  path: string;
  kind: string;
  workflowOwner: string;
  transportOwner: string;
  formatStatus: string;
  layoutStatus: string;
  evidence: string;
  companions: string[];
  references: string[];
};
type Inventory = {
  scenario: string;
  provenance: string;
  importReady: boolean;
  scope: string;
  gaps: string[];
  unresolvedProviders: Array<{ provider: string; command: null; outputSchema: null; intendedComponents: string[] }>;
  artifacts: Entry[];
};
const metadataRoot = resolve('test/fixtures/demo-project');
const metadata = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(join(metadataRoot, path), 'utf8')) as T;
const text = async (path: string): Promise<string> => readFile(join(root, path), 'utf8');
const json = async <T>(path: string): Promise<T> => JSON.parse(await text(path)) as T;

// These intentionally simple fixture CSVs have no quoted or multiline cells.
async function csv(path: string): Promise<string[][]> {
  const source = await text(path);
  expect(source).not.to.contain('"');
  const rows = source
    .trimEnd()
    .split('\n')
    .map((line) => line.split(','));
  for (const row of rows) expect(row.length).to.equal(rows[0].length);
  return rows;
}

describe('imaginary retrieve-all demo project', () => {
  it('inventories every artifact and companion, with explicit ownership and safe integration references', async () => {
    const inventory = await metadata<Inventory>('inventory.json');
    expect(inventory).to.have.all.keys(
      'scenario',
      'provenance',
      'importReady',
      'scope',
      'gaps',
      'unresolvedProviders',
      'artifacts'
    );
    expect(inventory.scenario).to.equal('imaginary-retrieve-all-result');
    expect(inventory.provenance).to.equal('synthetic-authored-not-retrieved');
    expect(inventory.importReady).to.equal(false);
    expect(inventory.gaps).to.have.length(6);
    expect(inventory.gaps.join(' ')).to.contain('^0.6.1').and.to.contain('0.9.0').and.to.contain('not implemented');
    expect(
      inventory.artifacts.map((entry) => [
        entry.path,
        entry.kind,
        entry.transportOwner,
        entry.formatStatus,
        entry.layoutStatus,
      ])
    ).to.deep.equal(expected);
    const paths = inventory.artifacts.flatMap((entry) => [entry.path, ...entry.companions]);
    expect(new Set(paths).size).to.equal(paths.length);
    for (const entry of inventory.artifacts) {
      expect(entry).to.have.all.keys(
        'path',
        'kind',
        'workflowOwner',
        'transportOwner',
        'formatStatus',
        'layoutStatus',
        'evidence',
        'companions',
        'references'
      );
      expect(entry.workflowOwner).to.equal('mcnext');
      expect(entry.evidence.length).to.be.greaterThan(20);
      for (const reference of entry.references) expect(paths).to.include(reference);
      for (const companion of entry.companions) expect(dirname(companion)).to.equal(dirname(entry.path));
    }
    for (const path of paths) {
      expect(path).to.match(/^[A-Za-z0-9_./-]+$/u);
      expect(path.split('/')).not.to.include('..');
    }
    const files = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(root.length + 1)
          .replaceAll('\\', '/')
      );
    expect(files.sort()).to.deep.equal(paths.sort());
    expect(files.some((path) => path.startsWith('vendor/') || path.includes('inventory'))).to.equal(false);
    const fileContents = await Promise.all(files.map(async (path) => ({ path, contents: await text(path) })));
    for (const { path, contents } of fileContents) {
      expect(contents.charCodeAt(0), path).not.to.equal(0xfe_ff);
      expect(contents, path).not.to.contain('\r');
      if (path.endsWith('.json')) expect(() => JSON.parse(contents) as unknown, path).not.to.throw();
    }
  });

  it('preserves native inactive Flow source and illustrates proposed flat Campaign JSON only', async () => {
    const project = await json<{
      packageDirectories: Array<{ path: string; default: boolean }>;
      sourceApiVersion: string;
    }>('sfdx-project.json');
    expect(project.packageDirectories).to.deep.equal([{ path: 'force-app', default: true }]);
    expect(project.sourceApiVersion).to.equal('67.0');
    const parsed = (await parseStringPromise(await text(expected[1][0]))) as {
      Flow: { $: { xmlns: string }; status: string[]; processType: string[]; apiVersion: string[] };
    };
    expect(parsed.Flow.$.xmlns).to.equal('http://soap.sforce.com/2006/04/metadata');
    expect(parsed.Flow.status).to.deep.equal(['Draft']);
    expect(parsed.Flow.processType).to.deep.equal(['AutoLaunchedFlow']);
    expect(parsed.Flow.apiVersion).to.deep.equal(['67.0']);
    const campaign = await json<Record<string, unknown>>(expected[2][0]);
    expect(campaign).to.have.all.keys(
      'Id',
      'Name',
      'Type',
      'Status',
      'IsActive',
      'Description',
      'ParentId',
      'StartDate',
      'EndDate'
    );
    expect(campaign.Id).to.match(/^701[A-Za-z0-9]{15}$/u);
    expect(campaign.Name).to.equal('Autumn Promo');
    expect(campaign.IsActive).to.equal(false);
    expect(campaign.ParentId).to.equal(null);
    expect(campaign.StartDate).to.equal(null);
    expect(campaign.EndDate).to.equal(null);
    expect(campaign).not.to.have.any.keys('sourceId', 'fields');
    const inventory = await metadata<Inventory>('inventory.json');
    expect(inventory.gaps.join(' '))
      .to.contain('readable-schema completeness')
      .and.to.contain('relationships')
      .and.to.contain('unverified');
  });

  it('distinguishes endpoint membership from core record-export CSV', async () => {
    expect(await csv(expected[3][0])).to.deep.equal([['id'], ['synthetic-member-001'], ['synthetic-member-002']]);
    expect(await csv(expected[4][0])).to.deep.equal([
      ['Id', 'Name', 'MarketSegmentType', 'SegmentStatus', 'PublishStatus'],
      ['1sg000000000001AAA', 'Autumn_Audience', 'Standard', 'Draft', 'NotPublished'],
    ]);
  });

  it('checks the public local-candidate flat Email shape, not installed-provider qualification', async () => {
    const email = await json<{
      contract: string;
      contractVersion: string;
      identity: unknown;
      contentType: string;
      contentBody: Record<string, unknown>;
      language: string;
      title: string;
      folderPath: string[];
      companions: { rawHtml: string };
    }>(expected[5][0]);
    expect(email).to.have.all.keys(
      'contract',
      'contractVersion',
      'identity',
      'contentType',
      'contentBody',
      'language',
      'title',
      'folderPath',
      'companions'
    );
    expect(email.contract).to.equal('sf-cms-source-definition');
    expect(email.contractVersion).to.equal('1.0.0');
    expect(email.identity).to.deep.equal({
      family: 'cms',
      type: 'Email',
      apiName: 'Autumn_Welcome',
      context: { workspaceApiName: 'Demo_Workspace' },
    });
    expect(email.contentType).to.equal('sfdc_cms__email');
    expect(email.language).to.equal('en_US');
    expect(email.folderPath).to.deep.equal([]);
    expect(email.contentBody).to.deep.equal({
      'sfdc_cms:title': 'Autumn Welcome',
      subjectLine: 'A synthetic autumn greeting',
      messagePurpose: 'Transactional',
      'lightning:expressions': [],
      'sfdc_cms:variants': [],
    });
    expect(email.title).to.equal('Autumn Welcome');
    expect(email.companions).to.deep.equal({ rawHtml: 'Autumn_Welcome.cms-email.html' });
    const html = await text(`cms/Demo_Workspace/email/${email.companions.rawHtml}`);
    expect(html).to.contain('<h1>Autumn Welcome</h1>');
    expect(html).not.to.contain('rawHtml');
  });

  it('keeps proposed Image source clean and unresolved vendor bookkeeping external', async () => {
    const image = await json<{ identity: { type: string; apiName: string }; companions: { media: string } }>(
      expected[6][0]
    );
    expect(image).to.have.all.keys('identity', 'contentType', 'title', 'language', 'folderPath', 'companions');
    expect(image.identity.type).to.equal('Image');
    expect(image.identity.apiName).to.equal('Autumn_Banner');
    expect(image.companions).to.deep.equal({ media: 'Autumn_Banner.cms-image.svg' });
    const svg = (await parseStringPromise(await text(`cms/Demo_Workspace/image/${image.companions.media}`))) as {
      svg: unknown;
    };
    expect(svg.svg).to.exist;
    const inventory = await metadata<Inventory>('inventory.json');
    expect(inventory.artifacts[6].formatStatus).to.equal('proposed-shape');
    expect(inventory.unresolvedProviders).to.deep.equal([
      {
        provider: 'data360-vendor-unresolved',
        command: null,
        outputSchema: null,
        intendedComponents: [
          'Autumn_Audience segment definition',
          'Unified Individual data model prerequisite',
          'Autumn_Profile data graph prerequisite',
        ],
      },
    ]);
  });

  it('accounts for all supplied UI labels without manufacturing unsupported source files', async () => {
    const coverage = await metadata<{
      types: Array<{ label: string; apiFamily: string | null; fileToken: string | null; support: string }>;
    }>('marketing-type-coverage.json');
    expect(coverage.types.map((entry) => entry.label)).to.deep.equal([
      'Audio',
      'Brand',
      'Consent Banner',
      'Contact Card (VCF)',
      'Content Block: Email',
      'Content Block: Landing Page',
      'Custom Font',
      'Document',
      'Email',
      'Email Template',
      'Expression',
      'Form',
      'Form Handler',
      'Image',
      'In-App Message',
      'Landing Page',
      'Landing Page Template',
      'Preference Page',
      'Push Notification Message',
      'RCS Message',
      'SMS and MMS',
      'Tracked Link',
      'Video',
      'WhatsApp Session Message',
      'WhatsApp Template Message',
    ]);
    for (const entry of coverage.types) {
      expect(entry.support).to.be.oneOf(['unresolved', 'local-candidate-source-only']);
      if (entry.apiFamily === null) {
        expect(entry.fileToken).to.equal(null);
        expect(entry.support).to.equal('unresolved');
      }
    }
    expect(coverage.types.find((entry) => entry.label === 'Content Block: Email')).to.include({
      apiFamily: 'emailFragment',
      fileToken: 'email-fragment',
    });
    expect(coverage.types.find((entry) => entry.label === 'Content Block: Landing Page')).to.include({
      apiFamily: 'webFragment',
      fileToken: 'web-fragment',
    });
  });

  it('keeps the README link and wireit fixture inputs synchronized', async () => {
    const readme = await readFile('README.md', 'utf8');
    expect(readme)
      .to.contain('(test/demo-project)')
      .and.to.contain('imaginary result of retrieve-all')
      .and.to.contain('not import-ready');
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { wireit: Record<string, { files: string[] }> };
    expect(readme)
      .to.contain('(test/fixtures/demo-project/inventory.json)')
      .and.to.contain('(test/fixtures/demo-project/marketing-type-coverage.json)');
    expect(pkg.wireit['test:only'].files).to.include('test/demo-project/**');
    expect(pkg.wireit['test:only'].files).to.include('test/fixtures/demo-project/**/*.json');
    expect(pkg.wireit['test:only'].files).to.include('README.md');
  });
});
