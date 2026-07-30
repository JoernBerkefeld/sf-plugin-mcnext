# summary

List the Marketing Cloud Next types this plugin knows about.

# description

Prints every registered type along with its coverage: whether this plugin implements it directly because core Salesforce CLI commands cannot reach it, or whether it is delegated to a core command such as "sf project retrieve start" or "sf data export bulk".

Use this to understand what "sf mcnext retrieve --gap-only" covers versus what "--all" adds.

# examples

- List every known type:

  <%= config.bin %> <%= command.id %>

- List only the types this plugin implements itself:

  <%= config.bin %> <%= command.id %> --coverage gap

# flags.coverage.summary

Restrict the output to one coverage bucket.
