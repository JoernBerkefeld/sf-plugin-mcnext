import { expect } from 'chai';
import EmailTemplateShow from '../../../../src/commands/mcnext/email-template/show.js';

describe('mcnext email-template show', () => {
  it('requires an org and exact content selection', () => {
    expect(EmailTemplateShow.flags['target-org'].required).to.equal(true);
    expect(EmailTemplateShow.flags['content-id'].required).to.equal(true);
    expect(EmailTemplateShow.description).to.include('read-only');
    expect(EmailTemplateShow.aliases).to.deep.equal(['mcn:email-template:show']);
  });
});
