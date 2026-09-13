# summary

List Marketing Cloud Next capability ownership and support state.

# description

Prints every registered capability with its owner, current support state, available operations, core Salesforce CLI delegation when applicable, and any evidence limitation.

A registry entry is not automatically supported. `conditional` and `deferred` capabilities are shown so users can see the v1 boundary without the plugin claiming they are implemented.

# examples

- List every known capability:

  <%= config.bin %> <%= command.id %>

- List only core Salesforce CLI delegations:

  <%= config.bin %> <%= command.id %> --provider core-sf

- List capabilities still blocked by evidence:

  <%= config.bin %> <%= command.id %> --state conditional

# flags.provider.summary

Restrict output to one owning provider.

# flags.state.summary

Restrict output to one current support state.
