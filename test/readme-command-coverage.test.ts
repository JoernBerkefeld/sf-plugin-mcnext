import { readFile } from 'node:fs/promises';
import { expect } from 'chai';

type ManifestFlag = {
  char?: string;
  default?: boolean | number | string;
  helpGroup?: string;
  max?: number;
  min?: number;
  multiple?: boolean;
  name: string;
  options?: string[];
  required?: boolean;
  type: 'boolean' | 'option';
};

type ManifestCommand = {
  flags: Record<string, ManifestFlag>;
  id: string;
};

type Manifest = {
  commands: Record<string, ManifestCommand>;
};

type OptionRow = {
  expected: string;
  option: string;
  required: string;
};

type ConstraintExpectation = {
  expected: string[];
  required?: string;
};

const constraintExpectations: Record<string, Record<string, ConstraintExpectation>> = {
  'mcnext:campaign:config': {
    'expect-unchanged': { required: 'Update only', expected: ['default `false`', 'independent baseline'] },
    'expected-name': { required: 'Update', expected: ['Forbidden for export/create'] },
    'input-file': { required: 'Create/update', expected: ['JSON artifact', 'Forbidden for export'] },
    'journal-file': {
      required: 'Create',
      expected: ['Required new private identity journal', 'no absolute', 'existing-file overwrite', 'Forbidden for export/update'],
    },
    'output-file': { required: 'Export', expected: ['New JSON artifact', 'no overwrite', 'Forbidden for create/update'] },
    'record-id': { required: 'Export/update', expected: ['Forbidden for create'] },
    'target-name': { required: 'Create', expected: ['distinct from source name', 'Forbidden for export/update'] },
  },
  'mcnext:flow:source': {
    'expect-unchanged': { required: 'Update only', expected: ['default `false`', 'exact unchanged repeat'] },
    'expected-definition-id': { required: 'Update', expected: ['Update-only'] },
    'expected-latest-version-id': { required: 'Update', expected: ['Update-only'] },
    'expected-org-id': { required: 'Create/update', expected: ['Mutation-only'] },
    member: { required: 'Yes', expected: ['Repeatable for retrieve/validate', 'exactly one for create/update'] },
    'reuse-same-org-references': {
      required: 'Create/update',
      expected: ['Required by the mutation workflow', 'default `false`'],
    },
    'source-file': { required: 'Create/update', expected: ['Mutation-only'] },
    'source-org-id': { required: 'Create/update', expected: ['must equal `--expected-org-id`', 'Mutation-only'] },
    wait: { expected: ['Integer `1`–`30`'] },
  },
  'mcnext:identity-resolution:export': {
    'output-file': { expected: ['Parent directories are created', 'an existing file is overwritten'] },
  },
  'mcnext:identity-resolution:plan': {
    'expected-target-key': { required: 'For `update-shell`', expected: ['Forbidden for `create`'] },
    'expected-target-label': { required: 'For `update-shell`', expected: ['Forbidden for `create`'] },
    'expected-target-status': { required: 'For `update-shell`', expected: ['Forbidden for `create`'] },
    'target-ruleset-id': { required: 'For `update-shell`', expected: ['Forbidden for `create`'] },
  },
  'mcnext:migration:cms': {
    'allow-experimental-cms': {
      required: 'Effectively yes',
      expected: ['required for dry-run and apply', 'default `false`', 'omission fails'],
    },
    apply: { required: 'No', expected: ['default `false`', 'Requires `--allow-experimental-cms`'] },
    'result-file': { expected: ['New durable execution-result JSON', 'no overwrite', 'plan is never modified'] },
  },
  'mcnext:migration:plan': {
    'cms-export-dir': {
      required: 'With `--cms-plan`',
      expected: ['New, unused run-owned export directory', 'Rejected without `--cms-plan`'],
    },
    'cms-plan': { required: 'No', expected: ['default `false`', 'Requires both companion flags'] },
    'cms-workspace-map': {
      required: 'With `--cms-plan`',
      expected: ['Rejected without `--cms-plan`'],
    },
    'output-file': { expected: ['Deterministic JSON migration plan', 'overwritten'] },
  },
  'mcnext:segment:definition:create': {
    'dry-run': { required: 'No', expected: ['default `false`', 'stops before apply'] },
    'mapping-file': { expected: ['JSON', 'resolved from project directory'] },
    'visibility-polls': { expected: ['Integer `1`–`10`'] },
    wait: { expected: ['Integer `1`–`30`'] },
  },
  'mcnext:segment:members:export': {
    limit: { expected: ['integer `>= 1`'] },
    'max-duration-ms': { expected: ['integer `>= 1`'] },
    'max-items': { expected: ['integer `>= 1`'] },
    'max-pages': { expected: ['integer `>= 1`'] },
    offset: { expected: ['integer `>= 0`'] },
    'output-file': { expected: ['Parent directories are created', 'overwritten', 'written incrementally'] },
    segment: { expected: ['API/developer name', 'exact display name', '15/18-character `MarketSegment` record ID'] },
  },
  'mcnext:segment:records:export': {
    'all-rows': { required: 'No', expected: ['default `false`'] },
    'output-file': { expected: ['core bulk export creates or overwrites'] },
    wait: { expected: ['Integer `>= 0`'] },
  },
};

const readProjectFile = async (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const commandHeading = (id: string): string => `## \`sf ${id.replaceAll(':', ' ')}\``;

const commandSection = (readme: string, id: string): string => {
  const heading = commandHeading(id);
  const start = readme.indexOf(heading);
  expect(start, `README section for ${id}`).to.be.at.least(0);
  const next = readme.indexOf('\n## `sf ', start + heading.length);
  return readme.slice(start, next === -1 ? undefined : next);
};

const bashBlocks = (section: string): string[] =>
  [...section.matchAll(/```bash\n([\s\S]*?)\n```/gu)].map((match) => match[1]);

const optionRows = (section: string): OptionRow[] => {
  const tableStart = section.indexOf('| Option | Required | Expected/allowed values |');
  expect(tableStart, 'options table header').to.be.at.least(0);
  const lines = section.slice(tableStart).split('\n').slice(2);
  const rows: OptionRow[] = [];
  for (const line of lines) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 3) rows.push({ option: cells[0], required: cells[1], expected: cells[2] });
  }
  return rows;
};

const flagRow = (rows: OptionRow[], commandId: string, flag: ManifestFlag): OptionRow => {
  const matching = rows.filter((row) => {
    const codeSpans = [...row.option.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    return codeSpans.some((value) => value === `--${flag.name}` || value.startsWith(`--${flag.name} `));
  });
  expect(matching, `${commandId} exact option row for --${flag.name}`).to.have.length(1);
  return matching[0];
};

describe('README public command coverage', () => {
  it('documents every manifest command with shell-safe examples and exact option rows', async () => {
    const [readme, manifestText] = await Promise.all([
      readProjectFile('README.md'),
      readProjectFile('oclif.manifest.json'),
    ]);
    const manifest = JSON.parse(manifestText) as Manifest;
    const commands = Object.values(manifest.commands);

    expect(commands).to.have.length(15);
    expect(readme).to.include('## Common inherited options');
    expect(readme).to.include('--json');
    expect(readme).to.include('--flags-dir <directory>');

    for (const command of commands) {
      const section = commandSection(readme, command.id);
      const examples = bashBlocks(section);
      expect(examples, `${command.id} example block`).not.to.be.empty;
      expect(examples.join('\n'), `${command.id} unquoted angle-bracket placeholder`).not.to.match(
        /(?:^|[\s=])<[^>\n]+>/u
      );
      expect(section, `${command.id} options heading`).to.include('### Options');
      expect(section, `${command.id} common options link`).to.include('[Common inherited options](#common-inherited-options)');
      const rows = optionRows(section);

      for (const flag of Object.values(command.flags)) {
        if (flag.helpGroup === 'GLOBAL') continue;
        const row = flagRow(rows, command.id, flag);
        const codeSpans = [...row.option.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);

        if (flag.char) {
          expect(codeSpans, `${command.id} exact alias -${flag.char}`).to.include(`-${flag.char}`);
        } else {
          expect(codeSpans.filter((value) => /^-[^-]/u.test(value)), `${command.id} unexpected short alias`).to.be.empty;
        }
        expect(row.required === 'Yes', `${command.id} --${flag.name} requiredness`).to.equal(flag.required === true);
        for (const choice of flag.options ?? []) {
          expect(row.expected, `${command.id} --${flag.name} choice ${choice}`).to.include(`\`${choice}\``);
        }
        if (flag.default !== undefined) {
          expect(row.expected.toLowerCase(), `${command.id} --${flag.name} default`).to.include(
            `default \`${String(flag.default).toLowerCase()}\``
          );
        }
        if (flag.min !== undefined) expect(row.expected, `${command.id} --${flag.name} minimum`).to.include(String(flag.min));
        if (flag.max !== undefined) expect(row.expected, `${command.id} --${flag.name} maximum`).to.include(String(flag.max));
        if (flag.multiple === true) expect(row.expected, `${command.id} --${flag.name} repeatability`).to.include('Repeatable');
        if (flag.type === 'boolean') expect(row.expected, `${command.id} --${flag.name} boolean type`).to.include('Boolean');

        const constraint = constraintExpectations[command.id]?.[flag.name];
        if (constraint?.required) {
          expect(row.required, `${command.id} --${flag.name} conditional requiredness`).to.equal(constraint.required);
        }
        for (const text of constraint?.expected ?? []) {
          expect(row.expected, `${command.id} --${flag.name} runtime documentation`).to.include(text);
        }
      }
    }
  });

  it('documents the exact segment identifier contract in its option row', async () => {
    const readme = await readProjectFile('README.md');
    const rows = optionRows(commandSection(readme, 'mcnext:segment:members:export'));
    const segment = flagRow(rows, 'mcnext:segment:members:export', {
      name: 'segment',
      type: 'option',
    });

    expect(segment.option).to.include('`-s`');
    expect(segment.required).to.equal('Yes');
    expect(segment.expected).to.include('API/developer name');
    expect(segment.expected).to.include('exact display name');
    expect(segment.expected).to.include('15/18-character `MarketSegment` record ID');
  });
});
