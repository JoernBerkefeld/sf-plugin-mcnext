import { expect } from 'chai';
import { getType, getTypes, MCN_TYPES } from '../../src/registry/registry.js';

describe('type registry', () => {
  it('every type has a unique name', () => {
    const names = MCN_TYPES.map((type) => type.name);
    expect(new Set(names).size).to.equal(names.length);
  });

  it('every core-sf type declares how it is delegated', () => {
    for (const type of getTypes('core-sf')) {
      expect(type.delegation, `${type.name} must declare a delegation`).to.not.equal(undefined);
      const hasTarget = Boolean(type.delegation?.metadataType ?? type.delegation?.sObject);
      expect(hasTarget, `${type.name} needs a metadataType or sObject`).to.equal(true);
    }
  });

  it('no gap type declares a delegation', () => {
    for (const type of getTypes('gap')) {
      expect(type.delegation, `${type.name} is a gap type and must not delegate`).to.equal(undefined);
    }
  });

  it('filters by coverage', () => {
    const gap = getTypes('gap');
    const core = getTypes('core-sf');
    expect(gap.length + core.length).to.equal(MCN_TYPES.length);
    expect(gap.every((type) => type.coverage === 'gap')).to.equal(true);
  });

  it('looks up a single type by name', () => {
    expect(getType('emailContent')?.coverage).to.equal('gap');
    expect(getType('flow')?.coverage).to.equal('core-sf');
    expect(getType('nope')).to.equal(undefined);
  });

  it('keeps the segment distinction intact', () => {
    // Definition and records are covered by core sf; membership is the actual gap
    // and must never be modelled as a delegated type.
    expect(getType('marketSegmentDefinition')?.coverage).to.equal('core-sf');
    expect(getType('marketSegmentRecord')?.delegation?.sObject).to.equal('MarketSegment');
  });
});
