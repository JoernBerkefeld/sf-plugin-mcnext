# summary

Retrieve one Marketing Cloud Next email send definition.

# description

Delegates an exact `ListEmail` record read to the installed core Salesforce CLI. This command is read-only and does not create, update, deploy, publish, or send email.

# flags.target-org.summary

Authorized Salesforce org alias or username.

# flags.record-id.summary

Exact Salesforce record ID for the `ListEmail` send definition.

# flags.api-version.summary

Salesforce API version passed to the delegated core command.

# examples

- Retrieve one email send definition:

  <%= config.bin %> <%= command.id %> --target-org my-mcnext-org --record-id 0XB000000000001AAA --api-version 67.0
