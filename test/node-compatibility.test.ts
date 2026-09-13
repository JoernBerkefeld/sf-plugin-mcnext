import { readFile } from 'node:fs/promises';
import { expect } from 'chai';

const requiredNodeVersion = '>=22.19.0';

type YamlLine = {
  indent: number;
  text: string;
};

const readProjectFile = async (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const yamlLines = (source: string): YamlLine[] =>
  source
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));

const mappingBlock = (lines: YamlLine[], key: string, indent: number): YamlLine[] => {
  const start = lines.findIndex((line) => line.indent === indent && line.text === `${key}:`);
  expect(start, `expected YAML mapping ${key}`).to.be.at.least(0);

  const end = lines.findIndex((line, index) => index > start && line.indent <= indent);
  return lines.slice(start, end === -1 ? undefined : end);
};

const childIndent = (block: YamlLine[]): number => {
  const indent = Math.min(...block.slice(1).map((line) => line.indent).filter((value) => value > block[0].indent));
  expect(indent, `expected children under ${block[0].text}`).to.be.finite;
  return indent;
};

const directValues = (block: YamlLine[], key: string): string[] => {
  const indent = childIndent(block);
  return block
    .filter((line) => line.indent === indent)
    .map((line) => new RegExp(`^${key}:\\s*(.+)$`, 'u').exec(line.text))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
};

const setupNodeStep = (job: YamlLine[]): YamlLine[] => {
  const starts = job
    .map((line, index) => ({ index, match: /^-\s+uses:\s+actions\/setup-node@\S+$/u.test(line.text) }))
    .filter(({ match }) => match);
  expect(starts, `expected one setup-node step in ${job[0].text}`).to.have.length(1);

  const { index: start } = starts[0];
  const indent = job[start].indent;
  const end = job.findIndex((line, index) => index > start && line.indent === indent && line.text.startsWith('- '));
  return job.slice(start, end === -1 ? undefined : end);
};

const parseInlineList = (value: string): string[] => {
  const match = /^\[(.*)\]$/u.exec(value);
  expect(match, `expected inline YAML list, received ${value}`).to.not.equal(null);
  return match![1].split(',').map((item) => item.trim().replace(/^(['"])(.*)\1$/u, '$2'));
};

describe('Node compatibility metadata', () => {
  it('keeps package, lockfile, documentation, and workflows aligned', async () => {
    const [packageText, lockfileText, readme, codeTestWorkflow, publishWorkflow] = await Promise.all([
      readProjectFile('package.json'),
      readProjectFile('package-lock.json'),
      readProjectFile('README.md'),
      readProjectFile('.github/workflows/code-test.yml'),
      readProjectFile('.github/workflows/npm-publish.yml'),
    ]);
    const packageJson = JSON.parse(packageText) as { engines: { node: string } };
    const lockfile = JSON.parse(lockfileText) as { packages: { '': { engines: { node: string } } } };
    const codeTestJobs = mappingBlock(yamlLines(codeTestWorkflow), 'jobs', 0);
    const testJob = mappingBlock(codeTestJobs, 'test', childIndent(codeTestJobs));
    const strategy = mappingBlock(testJob, 'strategy', childIndent(testJob));
    const matrix = mappingBlock(strategy, 'matrix', childIndent(strategy));
    const matrixNodeValues = directValues(matrix, 'node');
    const codeTestSetupNode = setupNodeStep(testJob);
    const publishJobs = mappingBlock(yamlLines(publishWorkflow), 'jobs', 0);
    const publishJobIndent = childIndent(publishJobs);
    const buildJob = mappingBlock(publishJobs, 'build', publishJobIndent);
    const publishNpmJob = mappingBlock(publishJobs, 'publish-npm', publishJobIndent);

    expect(packageJson.engines.node).to.equal(requiredNodeVersion);
    expect(lockfile.packages[''].engines.node).to.equal(requiredNodeVersion);
    expect(readme).to.include('Node.js `22.19.0` or later');
    expect(matrixNodeValues).to.have.length(1);
    expect(parseInlineList(matrixNodeValues[0])).to.deep.equal(['22.19.0', '24']);
    const codeTestSetupNodeWith = mappingBlock(codeTestSetupNode, 'with', childIndent(codeTestSetupNode));
    expect(directValues(codeTestSetupNodeWith, 'node-version')).to.deep.equal(['${{ matrix.node }}']);
    expect(directValues(codeTestSetupNodeWith, 'node-version-file')).to.be.empty;

    for (const job of [buildJob, publishNpmJob]) {
      const setupNode = setupNodeStep(job);
      const withBlock = mappingBlock(setupNode, 'with', childIndent(setupNode));
      expect(directValues(withBlock, 'node-version'), `${job[0].text} setup-node version`).to.deep.equal(['24']);
      expect(directValues(withBlock, 'node-version-file'), `${job[0].text} must not use node-version-file`).to.be.empty;
    }
  });
});
