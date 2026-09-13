# summary

Export MarketSegment records through the core Salesforce CLI bulk export command.

# description

Delegates transparently to `sf data export bulk` with the verified MarketSegment fields: `Id`, `Name`, `MarketSegmentType`, `SegmentStatus`, and `PublishStatus`.

The equivalent delegated command is printed before execution. The core command owns Bulk API behavior, file creation, progress, errors, and the returned result.

# examples

- Export MarketSegment records as CSV:

  <%= config.bin %> <%= command.id %> --target-org my-org --output-file segments.csv

- Export JSON and pass through optional core bulk-export settings:

  <%= config.bin %> <%= command.id %> --target-org my-org --output-file segments.json --result-format json --wait 20 --api-version 67.0 --all-rows

# flags.target-org.summary

Username or alias of the org passed to the core bulk export command.

# flags.output-file.summary

File path passed to the core bulk export command.

# flags.result-format.summary

Result format passed to the core bulk export command.

# flags.wait.summary

Minutes to wait for the core bulk export command to finish.

# flags.api-version.summary

API version override passed to the core bulk export command.

# flags.all-rows.summary

Include soft-deleted records through the core bulk export command.

# flags.column-delimiter.summary

CSV column delimiter passed to the core bulk export command.

# flags.line-ending.summary

CSV line ending passed to the core bulk export command.
