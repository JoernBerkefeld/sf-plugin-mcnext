# summary

Export, create or update a bounded Campaign configuration through Core CLI.

# description

EXPORT writes a flat describe-driven Campaign snapshot with canonical Id, including described custom and reference fields. Present nulls, empty strings, false, zero and compound values are preserved; transport attributes are omitted. Missing described fields are reported separately in result diagnostics, never fabricated as null. Fields unavailable to describe cannot be inventoried. Result-only association discovery validates Campaign.Flows and FlowRecord.AssociatedRecordId through exact schemas and completed queries, bounded to 100 attached flows. Each flow retains its actual SegmentId and core version references; unique Tooling definitions and latest Tooling Flow start configuration are correlated by exact API member, never by core ActiveVersionId. Missing, inaccessible, ambiguous or truncated evidence is blocked/incomplete, not false absence. Segment IDs and start API names are separate observations, not verified SegmentDefinition mappings or an inferred Campaign-wide segment. No native associated artifacts or relationship sidecar are written; this is not a full backup.

CREATE and UPDATE accept only the legacy {sourceId, fields} input with Name, Type, Status, IsActive and Description. An exported flat snapshot is not mutation input. CREATE explicitly maps the source ID to a new target ID and a distinct target name, checking name absence without claiming name uniqueness or atomic conflict prevention. UPDATE requires the exact target ID and expected current name; it cannot rename or upsert. Supply only changed fields for UPDATE. Owner defaults are target-local on CREATE; relationship inputs and custom fields remain unsupported. UPDATE preserves existing relationships without replacing them.

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

- Update selected fields on an explicitly identified Campaign:

  <%= config.bin %> <%= command.id %> --operation update --target-org target --expected-org-id <org-id> --api-version 67.0 --project-dir . --input-file campaign-patch.json --record-id <campaign-id> --expected-name "New campaign"
