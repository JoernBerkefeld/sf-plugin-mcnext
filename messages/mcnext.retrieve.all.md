# summary

Retrieve bounded working Campaign, Flow, Marketing CMS and identity configuration files.

# description

Downloads best-available working retrieval into an existing Salesforce DX project without overwrite. Requires an explicit selected org and expected org ID, API 67.0, and exactly one default package directory; every configured native root and output tree is checked before provider work. Retrieves bounded accessible Campaign flat snapshots at mcnext/campaigns/<Name>.mcn-campaign.json and exact associated native Flow XML in configured package roots. Delegates Marketing-only bulk CMS retrieval to the public sf-plugin-cms provider and preserves its declared package tree at cms/<artifact.path>/; this does not wrap ordinary CMS commands. An incompatible installed provider is blocked, not installed or upgraded. Downloads the existing Data360 identity-resolution configuration collection at data/identity-resolution.json, not native deployable configuration or all-data-space/restore qualification. Native Segment completeness, Campaign/Flow attachment persistence, native identity prerequisites and native data graphs remain blocked. Every result has complete:false: this is not a full backup or restore kit. Reports actual written files, provider states, diagnostics, retained stages and Core jobs even on partial failure. Exit codes are 0 success, 2 partial, 1 blocked/failed and 69 pending; a pending job alongside terminal blockers does not override the aggregate state. No org mutation, inventory input, overwrite, activation or send is performed.

# examples

- <%= config.bin %> <%= command.id %> --target-org source --expected-org-id 00D000000000001AAA --project-dir ./project
- <%= config.bin %> <%= command.id %> --target-org source --expected-org-id 00D000000000001AAA --project-dir ./project --api-version 67.0 --wait 10 --json

# flags.target-org.summary

Explicit authenticated org alias or username (no configured default).

# flags.expected-org-id.summary

Verified exact 18-character selected Salesforce org ID.

# flags.project-dir.summary

Existing Salesforce DX project root with exactly one default native package directory.

# flags.api-version.summary

Verified API version; only 67.0 is supported (default 67.0).

# flags.wait.summary

Minutes to wait for Core native retrieval (1–30, default 10).
