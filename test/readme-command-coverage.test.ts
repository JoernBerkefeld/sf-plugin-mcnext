import { readFile } from 'node:fs/promises';
import { expect } from 'chai';

type ManifestCommand = {
  flags: Record<string, unknown>;
  id: string;
};

type Manifest = {
  commands: Record<string, ManifestCommand>;
};

const readProjectFile = async (path: string): Promise<string> =>
  readFile(new URL(`../${path}`, import.meta.url), 'utf8');

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

const tableCommandCell = (id: string): string => `\`sf ${id.replaceAll(':', ' ')}\``;

describe('README public command coverage', () => {
  it('registers CMS as both a runtime dependency and an oclif plugin', async () => {
    const packageJson = JSON.parse(await readProjectFile('package.json')) as {
      dependencies?: Record<string, string>;
      oclif?: { plugins?: string[] };
    };

    expect(packageJson.dependencies?.['sf-plugin-cms']).to.be.a('string').and.not.be.empty;
    expect(packageJson.oclif?.plugins).to.deep.equal(['sf-plugin-cms']);
  });

  it('documents every manifest command in the reference table, a section, and a shell-safe bash example', async () => {
    const [readme, manifestText] = await Promise.all([
      readProjectFile('README.md'),
      readProjectFile('oclif.manifest.json'),
    ]);
    const manifest = JSON.parse(manifestText) as Manifest;
    const commands = Object.values(manifest.commands);

    expect(commands).to.have.length(17);
    expect(readme).to.include('## Command reference');
    expect(readme).to.include('sf mcnext <command> --help');

    const reference = readme.split('## Command reference\n')[1].split('\n## ')[0];
    const tableCommands = [...reference.matchAll(/^\|\s*(`sf [^`\n]+`)\s*\|/gmu)].map((match) => match[1]);

    for (const command of commands) {
      expect(tableCommands, `${command.id} command reference table row`).to.include(tableCommandCell(command.id));

      const section = commandSection(readme, command.id);
      const examples = bashBlocks(section);
      expect(examples, `${command.id} example block`).not.to.be.empty;
      expect(examples.join('\n'), `${command.id} unquoted angle-bracket placeholder`).not.to.match(
        /(?:^|[\s=])<[^>\n]+>/u
      );
    }
  });

  it('documents that CMS installs with the plugin', async () => {
    const readme = await readProjectFile('README.md');

    expect(readme).to.include('also installs the compatible CMS plugin');
    expect(readme).to.include('do not need a separate CMS install step');
    expect(readme).not.to.include('Imaginary retrieve-all');
  });

  it('documents the org authentication boundary for enriched segment exports', async () => {
    const readme = await readProjectFile('README.md');

    expect(readme).to.include('Normal Salesforce CLI org authorization covers `segment members export`');
    expect(readme).to.include('You do not need a separate Connected App for `--include-details`');
    expect(readme).to.include('Only `sf mcnext data-graph metadata` uses an externally obtained Data 360 token');
  });

  it('documents segment selection by display name and Id, with API name as a secondary option', async () => {
    const readme = await readProjectFile('README.md');
    const walkthroughStart = readme.indexOf('## Export segment members');
    const commandRefStart = readme.indexOf('## Command reference');
    expect(walkthroughStart).to.be.at.least(0);
    expect(commandRefStart).to.be.greaterThan(walkthroughStart);
    const walkthrough = readme.slice(walkthroughStart, commandRefStart);

    expect(walkthrough).to.include('display name');
    expect(walkthrough).to.include('Id');
    expect(walkthrough).to.include('browser URL');
    expect(walkthrough).to.include('API name');
    expect(walkthrough).to.match(/Prefer those over the API/iu);
    expect(walkthrough).to.include('uses the segment’s own data space automatically');
    expect(walkthrough).to.include('--data-space');
    expect(walkthrough).to.include('answer the prompt');
    expect(walkthrough).to.include('Without a TTY, or with `--json`');
    expect(walkthrough).to.include('prints the candidate list with each segment’s Id and data space');
    expect(walkthrough).to.include('exits nonzero');
    expect(walkthrough).to.include('--result-format json');
    expect(walkthrough).to.include('./data/<dataspace-name>/<segmentname>-<datetime>.json');
    expect(walkthrough).to.include('./data/<dataspace-name>/<segmentname>-<datetime>.csv');
    expect(walkthrough).to.include('An explicit `--output-file` overrides');

    const section = commandSection(readme, 'mcnext:segment:members:export');
    expect(section).to.include('display name');
    expect(section).to.include('Id');
    expect(section).to.include('API name');
    expect(section).to.include('./data/<dataspace-name>/<segmentname>-<datetime>.csv');
    expect(section).to.include('--result-format json');
    expect(section).to.include('./data/<dataspace-name>/<segmentname>-<datetime>.json');
  });
});
