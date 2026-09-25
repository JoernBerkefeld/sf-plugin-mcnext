import { expect } from 'chai';
import { McnClient } from '../../src/client/mcnClient.js';
import { showEmailTemplate } from '../../src/email/emailTemplate.js';

type RequestOptions = Parameters<McnClient['request']>[0];

function clientWith(result: unknown, requests: RequestOptions[]): McnClient {
  return {
    request: async (request: RequestOptions) => {
      requests.push(request);
      return result;
    },
  } as McnClient;
}

describe('email template', () => {
  const contentId = '20Y000000000001AAA';

  it('retrieves the exact CMS email template', async () => {
    const requests: RequestOptions[] = [];
    const template = {
      managedContentId: contentId,
      contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
      title: 'Welcome',
    };

    expect(await showEmailTemplate(clientWith(template, requests), contentId)).to.deep.equal(template);
    expect(requests).to.deep.equal([{ path: `/connect/cms/contents/${contentId}` }]);
  });

  it('rejects a non-template CMS response', async () => {
    const client = clientWith(
      { managedContentId: contentId, contentType: { fullyQualifiedName: 'sfdc_cms__email' } },
      []
    );
    try {
      await showEmailTemplate(client, contentId);
      expect.fail('expected response validation to fail');
    } catch (error) {
      expect((error as Error).name).to.equal('InvalidEmailTemplateResponse');
    }
  });
});
