import { SfError } from '@salesforce/core';
import { McnClient } from '../client/mcnClient.js';

export type EmailTemplate = Record<string, unknown> & {
  managedContentId: string;
  contentType: { fullyQualifiedName: string };
};

/** Retrieve one CMS email template and reject other CMS content types. */
export async function showEmailTemplate(client: McnClient, contentId: string): Promise<EmailTemplate> {
  if (!/^20Y[A-Za-z0-9]{15}$/u.test(contentId)) {
    throw new SfError('An exact 18-character managed content ID is required.', 'InvalidEmailTemplateId');
  }

  const result = await client.request<EmailTemplate>({ path: `/connect/cms/contents/${contentId}` });
  if (result.managedContentId !== contentId || result.contentType?.fullyQualifiedName !== 'sfdc_cms__emailTemplate') {
    throw new SfError('The retrieved CMS item is not the requested email template.', 'InvalidEmailTemplateResponse');
  }

  return result;
}
