# summary

Retrieve one Marketing Cloud Next email template.

# description

Reads one CMS email template by exact managed content ID through the documented Connect API and verifies that the returned content type is `sfdc_cms__emailTemplate`. This command is read-only and does not create, publish, or modify CMS content.

# flags.target-org.summary

Authorized Salesforce org alias or username.

# flags.content-id.summary

Exact 18-character managed content ID for the email template.

# flags.api-version.summary

Salesforce API version; the plugin supports its retained v67 baseline.

# examples

- Retrieve one email template:

  <%= config.bin %> <%= command.id %> --target-org my-mcnext-org --content-id 20Y000000000001AAA --api-version 67.0
