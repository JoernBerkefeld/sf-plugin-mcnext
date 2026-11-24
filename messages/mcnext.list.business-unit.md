# summary

List the business units of the org with their data space and CMS workspaces.

# description

Shows each business unit with its developer name, label, data space and the API names of its CMS workspaces. Use a developer name with --business-unit of sf mcnext retrieve and sf mcnext deploy. In an org that does not use business units the one business unit is listed with its data space, the workspaces are not available per business unit, and a warning says so.

# examples

- List the business units:

  <%= config.bin %> <%= command.id %> --target-org my-org

- The same as JSON:

  <%= config.bin %> <%= command.id %> --target-org my-org --json

# error.readFailed

The business units of this org could not be read: %s
