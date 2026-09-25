# summary

Export, create or update a bounded Campaign configuration through Core CLI.

# description

Supports Name, Type, Status, IsActive and Description only. CREATE explicitly maps the source ID to a new target ID and a distinct target name, checking name absence without claiming name uniqueness or atomic conflict prevention. UPDATE requires the exact target ID and expected current name; it cannot rename or upsert. Supply only changed fields for UPDATE. Export omits null scalar fields. Owner defaults are target-local on CREATE. Source relationships are rejected on export; relationship inputs and custom fields are unsupported. UPDATE preserves existing relationships without replacing them.

Null clearing, empty strings and strings containing quotes, backslashes or control whitespace are unsupported. CREATE writes a private pending journal before mutation and saves the returned identity before readback. Reconcile any failed or ambiguous write manually; never blindly retry. Repeated UPDATE can rerun automation even when values are unchanged. No members, sends, schema deployment or automatic lifecycle actions are implemented. This bounded adapter still requires real command roundtrip acceptance; Core transport evidence alone is not adapter acceptance.

# flags.operation.summary

Explicit configuration operation.

# flags.target-org.summary

Explicit Core CLI org alias or username.

# flags.expected-org-id.summary

Expected 18-character organization ID.

# flags.api-version.summary

Explicit Salesforce API version.

# flags.project-dir.summary

Existing project directory; relative file paths resolve here.

# flags.record-id.summary

Exact Campaign ID for export or update.

# flags.expected-name.summary

Expected current target name for update.

# flags.target-name.summary

Distinct fresh name for create.

# flags.expect-unchanged.summary

UPDATE only: require the submitted scalar values to equal the independently retrieved baseline before repeating the write.

# flags.input-file.summary

JSON artifact containing sourceId and fields.

# flags.output-file.summary

New JSON artifact file for export.

# flags.journal-file.summary

New private identity journal file required for create.

# examples

- Export a selected Campaign configuration:

  <%= config.bin %> <%= command.id %> --operation export --target-org source --expected-org-id <org-id> --api-version 67.0 --project-dir . --record-id <campaign-id> --output-file campaign.json

- Create a distinct Campaign and save its identity mapping:

  <%= config.bin %> <%= command.id %> --operation create --target-org target --expected-org-id <org-id> --api-version 67.0 --project-dir . --input-file campaign.json --target-name "New campaign" --journal-file campaign-created.json

- Update selected fields on an explicitly identified Campaign:

  <%= config.bin %> <%= command.id %> --operation update --target-org target --expected-org-id <org-id> --api-version 67.0 --project-dir . --input-file campaign-patch.json --record-id <campaign-id> --expected-name "New campaign"
