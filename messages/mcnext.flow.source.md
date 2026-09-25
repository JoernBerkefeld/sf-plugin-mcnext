# summary

Retrieve selected Flow source or validate it with Core deploy dry-run.

# description

Uses the selected DX project package directories. Validation never applies a deployment. CREATE transports an inactive Draft or InvalidDraft AutoLaunchedFlow using the original Core source XML, preserving actions, tracking, wiring and publishSegment configuration without executing it. Supply --source-file, --expected-org-id, --source-org-id, --reuse-same-org-references and one fresh valid Flow API name. The source org ID is a caller-verified provenance declaration; reference reuse must already be verified in that same destination org. Cross-org mapping is unsupported and rejected. It verifies destination identity and absence, dry-runs, checks absence again, then delegates one isolated Core deployment. CREATE rejects existing identities. UPDATE requires --expected-definition-id and --expected-latest-version-id for one existing inactive member, validates its status and modification baseline before and after dry-run, and never falls back to CREATE. Source XML is transported unchanged, without rename or activation. Core has no atomic update-only/compare-and-swap guarantee; reserve the target against concurrent external writers. No run, debug, send or publication operation is exposed. Accepted InvalidDraft source is NOT runtime-ready; informational member diagnostics are retained. No atomic create-only transport exists in Core: callers must reserve the selected name against concurrent external writers. A pending job is not success; inspect the Core job before retrying.

# examples

- <%= config.bin %> <%= command.id %> --operation retrieve --member MyFlow --target-org source --project-dir ./project
- <%= config.bin %> <%= command.id %> --operation validate --member MyFlow --target-org target --project-dir ./project --json

# flags.operation.summary

Retrieve, validate, create or explicitly update an inactive same-org draft.

# flags.expected-definition-id.summary

UPDATE only: verified existing 18-character FlowDefinition ID.

# flags.expected-latest-version-id.summary

UPDATE only: verified current 18-character latest Flow version ID.

# flags.expect-unchanged.summary

UPDATE only: permit an exact unchanged baseline repeat and require Core to report exactly the selected Flow member as Unchanged before independent semantic readback. Without this flag, UPDATE requires a top-level label and/or interviewLabel change and Core state Changed.

# flags.source-file.summary

CREATE/UPDATE: inactive Core Flow XML inside a configured package directory.

# flags.source-org-id.summary

CREATE/UPDATE: caller-verified source org identity; must equal expected-org-id.

# flags.reuse-same-org-references.summary

CREATE/UPDATE: declare all source references verified for reuse in the same org.

# flags.expected-org-id.summary

CREATE/UPDATE: verified 18-character destination org ID.

# flags.member.summary

Exact Flow API name (repeat for multiple members).

# flags.target-org.summary

Explicit org alias or username passed to Core.

# flags.project-dir.summary

Existing Salesforce DX project root.

# flags.wait.summary

Minutes to wait for Core (1–30).
