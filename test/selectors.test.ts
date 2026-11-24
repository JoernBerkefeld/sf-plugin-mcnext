import { join, resolve } from 'node:path';
import { expect } from 'chai';
import {
  DATA360_FAMILIES,
  areaOfType,
  isSelectorError,
  parseMetadataSelector,
  parsePathSelector,
} from '../src/selectors.js';

describe('metadata selectors (-m)', () => {
  it('exports the ten Data 360 family names', () => {
    expect([...DATA360_FAMILIES]).to.deep.equal([
      'dlo',
      'dmo',
      'mapping',
      'relationship',
      'data-stream',
      'data-transform',
      'data-graph',
      'segment',
      'identity-resolution',
      'calculated-insight',
    ]);
  });

  for (const type of ['campaign', 'flow']) {
    it(`routes ${type} to mcnext`, () => {
      expect(parseMetadataSelector(type)).to.deep.equal({ area: 'mcnext', type, raw: type });
      expect(parseMetadataSelector(`${type}:My_Name`)).to.deep.equal({
        area: 'mcnext',
        type,
        name: 'My_Name',
        raw: `${type}:My_Name`,
      });
    });
  }

  for (const type of DATA360_FAMILIES) {
    it(`routes ${type} to data360`, () => {
      expect(parseMetadataSelector(type)).to.deep.equal({ area: 'data360', type, raw: type });
      expect(parseMetadataSelector(`${type}:Some_Name__dlm`)).to.include({ area: 'data360', name: 'Some_Name__dlm' });
    });
  }

  it('routes every other type to cms without a local list of CMS types', () => {
    for (const type of ['email', 'emailTemplate', 'web-fragment', 'not_a_known_type']) {
      expect(areaOfType(type), type).to.equal('cms');
      expect(parseMetadataSelector(`${type}:Welcome`)).to.deep.equal({
        area: 'cms',
        type,
        name: 'Welcome',
        raw: `${type}:Welcome`,
      });
    }
  });

  it('keeps colons and spaces inside the name and trims around it', () => {
    expect(parseMetadataSelector(' campaign: Autumn Promo: part 2 ')).to.deep.equal({
      area: 'mcnext',
      type: 'campaign',
      name: 'Autumn Promo: part 2',
      raw: ' campaign: Autumn Promo: part 2 ',
    });
  });

  it('returns INVALID_SELECTOR instead of throwing on bad syntax', () => {
    // A flow name becomes a file name, so path characters are refused.
    for (const raw of [
      '',
      '   ',
      ':Name',
      'flow:',
      'flow:   ',
      'my type:Name',
      '1flow',
      'flow/x:Name',
      '*',
      'flow:../x',
      'flow:a/b',
      'flow:a\\b',
    ]) {
      const result = parseMetadataSelector(raw);
      expect(isSelectorError(result), JSON.stringify(raw)).to.equal(true);
      expect(result).to.include({ code: 'INVALID_SELECTOR', raw });
      expect((result as { message: string }).message).to.be.a('string').and.not.be.empty;
    }
  });

  it('tells a selector from an error', () => {
    expect(isSelectorError(parseMetadataSelector('flow'))).to.equal(false);
    expect(isSelectorError(undefined)).to.equal(false);
    expect(isSelectorError(null)).to.equal(false);
  });
});

describe('path selectors (-d)', () => {
  const project = resolve('some-project');

  it('routes by the first folder', () => {
    expect(parsePathSelector('mcnext/flows/Welcome.flow-meta.xml', project)).to.deep.equal({
      area: 'mcnext',
      path: 'mcnext/flows/Welcome.flow-meta.xml',
      raw: 'mcnext/flows/Welcome.flow-meta.xml',
    });
    expect(parsePathSelector('cms/My_Workspace/email', project)).to.include({
      area: 'cms',
      path: 'cms/My_Workspace/email',
    });
    expect(parsePathSelector('data360/default/dlo', project)).to.include({
      area: 'data360',
      path: 'data360/default/dlo',
    });
    expect(parsePathSelector('mcnext', project)).to.include({ area: 'mcnext', path: 'mcnext' });
  });

  it('accepts ./, backslashes, a trailing slash and absolute paths inside the project', () => {
    expect(parsePathSelector('./mcnext/campaigns/', project)).to.include({ area: 'mcnext', path: 'mcnext/campaigns' });
    expect(parsePathSelector('cms\\My_Workspace\\email', project)).to.include({
      area: 'cms',
      path: 'cms/My_Workspace/email',
    });
    expect(parsePathSelector(join(project, 'data360', 'default'), project)).to.include({
      area: 'data360',
      path: 'data360/default',
    });
    expect(parsePathSelector('mcnext/../cms/My_Workspace', project)).to.include({
      area: 'cms',
      path: 'cms/My_Workspace',
    });
  });

  it('uses the working directory when no project folder is given', () => {
    expect(parsePathSelector('mcnext/flows')).to.include({ area: 'mcnext', path: 'mcnext/flows' });
  });

  it('returns INVALID_SELECTOR for an empty path, a path outside the project and an unknown first folder', () => {
    for (const raw of ['', '  ', '.', '..', '../mcnext/flows', 'force-app/main/default/flows', 'mcnextish/flows']) {
      const result = parsePathSelector(raw, project);
      expect(isSelectorError(result), JSON.stringify(raw)).to.equal(true);
      expect(result).to.include({ code: 'INVALID_SELECTOR', raw });
    }
    expect(isSelectorError(parsePathSelector(resolve('other-project', 'mcnext'), project))).to.equal(true);
  });
});
