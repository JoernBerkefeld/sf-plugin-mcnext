# summary

Export one identity-resolution ruleset configuration as JSON.

# description

Writes the complete bare configuration object returned by the verified v67 endpoint, including filters, match rules, reconciliation rules, statuses, aggregate counts, and referenced DMO names. This exports configuration only; it does not migrate unified profiles or export computed profile rows.

# examples

- Export one ruleset configuration:

  <%= config.bin %> <%= command.id %> --target-org my-org --ruleset-id 1ir000000000001AAA --output-file identity-resolution.json

# flags.target-org.summary

Username or alias of the Marketing Cloud Next org.

# flags.ruleset-id.summary

Salesforce identity-resolution ruleset ID.

# flags.output-file.summary

Destination JSON file for the ruleset configuration.

# flags.api-version.summary

MCN API version. This command currently accepts only the verified v67.0 baseline.
