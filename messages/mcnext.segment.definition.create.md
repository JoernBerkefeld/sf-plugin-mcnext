# summary

Create one mapped MarketSegmentDefinition with Core validation and independent readback.

# description

Requires explicit source and target aliases plus their expected 18-character org IDs. Loads exactly one selected MarketSegmentDefinition XML file from a configured package directory, applies the explicit reference mapping, validates an isolated one-member DX project with Core check-only deployment, and applies only after rechecking both org identities and strict target absence. --dry-run stops after validation. Successful apply is independently retrieved into a fresh empty DX project and compared semantically, including includeCriteria. Connect is read-only and used only to correlate a unique identity and non-published lifecycle. Bounded visibility lag returns pending and never redeploys. No publication, membership calculation, scheduling, UPDATE, unchanged result, implicit upsert, or automatic write retry is supported.

# examples

- <%= config.bin %> <%= command.id %> --source-org source --target-org target --expected-source-org-id 00D000000000000AAA --expected-target-org-id 00D000000000001AAA --project-dir ./project --source-file force-app/main/default/marketSegmentDefinitions/FreshSegment.marketSegmentDefinition-meta.xml --member FreshSegment --mapping-file mappings/segment.json --dry-run

# flags.source-org.summary

Explicit authenticated source alias used only for identity provenance.

# flags.target-org.summary

Explicit authenticated target alias passed to Core and Connect.

# flags.expected-source-org-id.summary

Expected 18-character source org ID, guarded separately.

# flags.expected-target-org-id.summary

Expected 18-character target org ID, guarded separately.

# flags.project-dir.summary

Salesforce DX project containing the selected source file.

# flags.source-file.summary

Exact MarketSegmentDefinition XML file inside a configured package directory.

# flags.member.summary

Exact MarketSegmentDefinition API name.

# flags.mapping-file.summary

JSON file containing the explicit Chunk B segment reference mappings.

# flags.api-version.summary

Connect API version; defaults to the supported plugin baseline.

# flags.dry-run.summary

Run Core check-only validation and stop without apply.

# flags.wait.summary

Minutes to wait for each Core job (1–30).

# flags.visibility-polls.summary

Bounded read-only Connect checks after independent Core readback (1–10).
