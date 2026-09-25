import { expect } from 'chai';
import { requirePrivateNutAlias } from './privateNutValues.js';

describe('private NUT org alias validation', () => {
  it('accepts normal aliases and Salesforce usernames', () => {
    for (const value of ['mcnext-sandbox', 'mcnext_sandbox.2', 'developer@example.com']) {
      expect(requirePrivateNutAlias(value)).to.equal(value);
    }
  });

  it('rejects empty, leading-dash and metacharacter-bearing values', () => {
    for (const value of [
      undefined,
      '',
      '-target',
      'target org',
      'target\norg',
      'target"org',
      "target'org",
      'target&org',
      'target|org',
      'target;org',
      'target`org',
      'target/org',
      'target\\org',
    ]) {
      expect(() => requirePrivateNutAlias(value), String(value)).to.throw('safe Salesforce alias or username');
    }
  });
});
