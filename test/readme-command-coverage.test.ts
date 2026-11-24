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
  it('uses CMS as a library dependency without bundling its commands', async () => {
    const packageJson = JSON.parse(await readProjectFile('package.json')) as {
      dependencies?: Record<string, string>;
      oclif?: { plugins?: string[] };
    };

    expect(packageJson.dependencies?.['sf-plugin-cms']).to.be.a('string').and.not.be.empty;
    expect(packageJson.oclif?.plugins).to.equal(undefined);
  });

  it('documents every manifest command in the reference table, a section, and a shell-safe bash example', async () => {
    const [readme, manifestText] = await Promise.all([
      readProjectFile('README.md'),
      readProjectFile('oclif.manifest.json'),
    ]);
    const manifest = JSON.parse(manifestText) as Manifest;
    const commands = Object.values(manifest.commands);

    expect(readme).to.include('## Command reference');
    expect(readme).to.include('sf mcnext <command> --help');

    const reference = readme.split('## Command reference\n')[1].split('\n## ')[0];
    const tableCommands = [...reference.matchAll(/^\|\s*(`sf [^`\n]+`)\s*\|/gmu)].map((match) => match[1]);
    const sectionHeadings = [...readme.matchAll(/^## (`sf [^`\n]+`)$/gmu)].map((match) => match[1]);
    const expectedCells = commands.map((command) => tableCommandCell(command.id)).sort();

    // Both directions: every command is documented, and nothing is documented that does not exist.
    expect([...tableCommands].sort(), 'command reference table rows').to.deep.equal(expectedCells);
    expect([...sectionHeadings].sort(), 'command sections').to.deep.equal(expectedCells);

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

  it('documents that the sf cms and sf data360 commands need their own plugins', async () => {
    const readme = await readProjectFile('README.md');

    expect(readme).to.include('adds the `sf mcnext` commands only');
    expect(readme).to.include('https://www.npmjs.com/package/sf-plugin-cms');
    expect(readme).to.include('https://www.npmjs.com/package/sf-plugin-data');
  });
});
