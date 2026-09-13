# summary

List identity-resolution ruleset configurations.

# description

Lists the ruleset configurations returned by the verified v67 identity-resolutions endpoint. This is configuration and aggregate status data, not unified-profile migration or profile-row export. The endpoint does not expose proven pagination, so this command makes one collection request and parses `identityResolutions`.

# examples

- List identity-resolution configurations:

  <%= config.bin %> <%= command.id %> --target-org my-org

# flags.target-org.summary

Username or alias of the Marketing Cloud Next org.

# flags.api-version.summary

MCN API version. This command currently accepts only the verified v67.0 baseline.
