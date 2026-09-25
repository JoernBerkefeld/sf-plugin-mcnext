# summary

Show one identity-resolution ruleset configuration.

# description

Returns the bare ruleset configuration object from the verified v67 endpoint, selected by Salesforce ruleset ID. This is configuration and aggregate status data, not unified-profile migration or profile-row export.

# examples

- Show one ruleset configuration:

  <%= config.bin %> <%= command.id %> --target-org my-org --ruleset-id 1ir000000000001AAA

# flags.target-org.summary

Username or alias of the Marketing Cloud Next org.

# flags.ruleset-id.summary

Salesforce identity-resolution ruleset ID.

# flags.api-version.summary

MCN API version. This command currently accepts only the verified v67.0 baseline.
