# sf-plugin-mcnext

Salesforce CLI plugin for working with Marketing Cloud Next data and configuration. The plugin can support read/write workflows overall: it implements MCN-specific capabilities where needed and points to or delegates to the core `sf` CLI when Salesforce CLI already owns retrieval, deployment, or data operations.

CMS-aware migration planning is available through a separately installed, compatible `sf-plugin-cms`. The MCN plugin does not bundle, auto-install, upgrade, downgrade, or repair the CMS provider.

## v1 installation and getting started

### Prerequisites

- Node.js `22.19.0` or later, as required by this package. Verify it with `node --version`.
- Salesforce CLI. Install or update the base CLI with npm, then verify it:

  ```bash
  npm install --global @salesforce/cli
  sf --version
  ```

- A Salesforce org with Marketing Cloud Next/Data 360 features configured for the capability you want to use.
- A user with API access and permission to view or operate on the relevant segment, `MarketSegment`, or identity-resolution resources. Exact licenses, products, and permission sets depend on the org; contact the org administrator if a command returns an authorization or unavailable-resource error.

The v1 commands documented below export or inspect data and configuration. The capability registry also identifies retrieval and deployment operations owned by the core `sf` CLI. Do not interpret the v1 command list as a package-level promise that this plugin will remain read-only.

### Install the published plugin

```bash
sf plugins install sf-plugin-mcnext
sf plugins
```

The CMS provider is optional for CMS-independent commands. Install it separately only when you intend to use `sf mcnext migration plan --cms-plan`:

```bash
sf plugins install sf-plugin-cms@0.4.0
sf plugins inspect sf-plugin-cms --json
sf cms info --contract-version 1 --json
```

CMS planning requires `sf-plugin-cms` version `0.4.0` or later, but version alone is not sufficient. The provider must be discoverable by the same `sf` executable and advertise compatible command-result and package-manifest contracts, capability `workspace.export.external-reference-correlation`, and correlation contract `sf-cms-external-reference-correlations@1`. A newer provider is accepted only when those retained contracts and semantics remain compatible.

If the provider is missing, too old, newer but incompatible, unavailable, malformed, or missing required provenance/correlation evidence, CMS-dependent planning fails closed. CMS-independent commands and a migration plan without `--cms-plan` remain available.

### Local-development alternative

Use this only when developing or testing a local checkout instead of the published npm package:

```bash
npm install
npm run compile
sf plugins link .
sf plugins
```

### Authorize an org and set an alias

Use the standard Salesforce CLI web login flow. The example sets `my-mcnext-org` as the alias used throughout this guide:

```bash
sf org login web --alias my-mcnext-org --instance-url https://login.salesforce.com
sf org display --target-org my-mcnext-org
```

Use your org's My Domain or the appropriate Salesforce login URL instead of `https://login.salesforce.com` when required. A successful `sf org display` confirms that the CLI can resolve the alias and access the saved authorization. Every v1 command that connects to an org requires `--target-org <alias-or-username>` (or `-o`).

### First safe commands

Start with the local capability registry; it does not access an org:

```bash
sf mcnext list types
```

Then try a bounded export against an authorized org. Replace the segment value with a segment API name, `MarketSegment` record ID, or exact display name from your org:

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment My_Published_Segment --output-file members.csv --max-items 100
```

The `mcn` topic is a hidden short alias for `mcnext`. This guide uses the full `mcnext` topic. Run `sf <command> --help` when you need the complete generated flag reference.

## v1 command guide

### `sf mcnext list types`

**Purpose:** Show the capability registry: who owns each Marketing Cloud Next capability, its v1 support state, available operations, any core CLI command family, and known limitations.

**Typical uses:** Discover what v1 implements, find capabilities delegated to core Salesforce CLI, or inspect functionality that is conditional or deferred.

**Common flags:**

- `--provider <mcnext|core-sf|cms-service|external/manual|secondary-data>` filters by owner.
- `--state <implemented|delegated|conditional|deferred>` filters by support state.

```bash
sf mcnext list types --provider core-sf
```

**Expected output:** A terminal table titled `Marketing Cloud Next capabilities`, with columns including capability name, provider, state, operations, delegation, and limitation. The command does not require an org.

**Important notes:** A registry row does not mean the plugin implements that capability. `delegated` rows identify work owned by core `sf`; `conditional` and `deferred` rows make the v1 boundary explicit.

### `sf mcnext segment members export`

**Purpose:** Resolve a segment and export its computed members from the verified MCN SSOT members endpoint, writing rows incrementally to CSV or JSON.

**Typical uses:** Produce a bounded membership sample, export a published segment's members for downstream analysis, or request selected SSOT fields with server-side filtering and ordering.

**Required flags:**

- `--target-org` / `-o`: authorized org alias or username.
- `--segment` / `-s`: segment API name, `MarketSegment` record ID, or exact display name.
- `--output-file`: destination path.

**Common flags:** `--result-format <csv|json>` (default `csv`), `--fields`, `--filters`, `--order-by`, `--limit` (page size, default `200`), `--offset`, and the safety bounds `--max-pages`, `--max-items`, and `--max-duration-ms`. CSV output also accepts `--column-delimiter` and `--line-ending`.

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment My_Published_Segment --output-file exports/members.json --result-format json --max-items 1000
```

**Expected output/file:** A streamed CSV file with a header row or a JSON array. The command result reports the resolved `segmentApiName`, output path, format, row count, and completion state.

**Important notes:** This direct endpoint is pinned to API version `67.0`. Pagination defaults are bounded at 1,000 pages, 1,000,000 items, and 15 minutes unless reduced by flags. If a request or safety limit stops the export, the command reports that the partially written file is incomplete. Member `id` values are opaque Watson/SSOT membership values, not asserted Salesforce CRM record IDs.

### `sf mcnext segment records export`

**Purpose:** Export Salesforce `MarketSegment` records and their status fields through the core Salesforce CLI bulk data export command.

**Typical uses:** Inventory segment records, compare segment and publish statuses, or create a CSV/JSON record extract separate from computed segment membership.

**Required flags:**

- `--target-org` / `-o`: authorized org alias or username.
- `--output-file`: destination path.

**Common flags:** `--result-format <csv|json>` (default `csv`), `--wait` / `-w` in minutes (default `10`), `--all-rows`, `--api-version`, and CSV `--column-delimiter` / `--line-ending` settings.

```bash
sf mcnext segment records export --target-org my-mcnext-org --output-file exports/segments.csv
```

**Expected output/file:** The command first prints the equivalent `sf data export bulk` invocation. Core Salesforce CLI then owns job progress, errors, result details, and creation of the requested CSV or JSON file. The export queries `Id`, `Name`, `MarketSegmentType`, `SegmentStatus`, and `PublishStatus` from `MarketSegment`.

**Important notes:** This is deliberate core `sf` delegation rather than a second bulk-export implementation. It exports segment records, not the computed member rows handled by `segment members export`. Availability and permissions therefore follow the installed core bulk data command and the org's access to `MarketSegment`.

### `sf mcnext identity-resolution list`

**Purpose:** List identity-resolution ruleset configurations and their aggregate statuses from the verified MCN endpoint.

**Typical uses:** Find a ruleset ID for `show` or `export`, review ruleset/job status, or compare aggregate unified-profile counts across configurations.

**Required flags:** `--target-org` / `-o` for the authorized org. `--api-version` is available but v1 accepts only `67.0`.

```bash
sf mcnext identity-resolution list --target-org my-mcnext-org
```

**Expected output:** A terminal table titled `Identity-resolution configurations`, including ruleset ID, label, data space, ruleset status, last job status, and total unified profiles.

**Important notes:** The endpoint has no proven pagination contract, so v1 performs one collection request. The result is configuration and aggregate status data; it is not an export or migration of unified-profile rows.

### `sf mcnext identity-resolution show`

**Purpose:** Return one complete identity-resolution ruleset configuration by Salesforce ruleset ID.

**Typical uses:** Inspect filters, matching and reconciliation rules, referenced objects, statuses, and aggregate counts before exporting or troubleshooting a configuration.

**Required flags:**

- `--target-org` / `-o`: authorized org alias or username.
- `--ruleset-id`: Salesforce identity-resolution ruleset ID, usually obtained from `identity-resolution list`.

`--api-version` is available but v1 accepts only `67.0`.

```bash
sf mcnext identity-resolution show --target-org my-mcnext-org --ruleset-id 1ir000000000001AAA
```

**Expected output:** The bare ruleset configuration object is returned to the CLI. Add the global `--json` flag when machine-readable terminal output is preferred.

**Important notes:** This command reads configuration and aggregate status only. It does not return computed unified-profile rows or perform migration.

### `sf mcnext identity-resolution export`

**Purpose:** Write one complete identity-resolution ruleset configuration to a formatted JSON file.

**Typical uses:** Keep a configuration snapshot, review or compare rules outside the org, or prepare configuration evidence for a future migration workflow.

**Required flags:**

- `--target-org` / `-o`: authorized org alias or username.
- `--ruleset-id`: Salesforce identity-resolution ruleset ID.
- `--output-file`: destination JSON path.

`--api-version` is available but v1 accepts only `67.0`.

```bash
sf mcnext identity-resolution export --target-org my-mcnext-org --ruleset-id 1ir000000000001AAA --output-file exports/identity-resolution.json
```

**Expected output/file:** A UTF-8, indented JSON file containing the bare configuration object. Missing parent directories are created. The command result identifies the ruleset and output path.

**Important notes:** This is a configuration export, including available filters, match rules, reconciliation rules, statuses, counts, and referenced DMO names. It does not migrate unified profiles or export their computed rows.

### `sf mcnext flow source`

**Purpose:** Retrieve selected Flow source, validate it through Core check-only deployment, or explicitly create/update one inactive same-org draft. Core Salesforce CLI remains the metadata transport; this adapter adds bounded selection and identity checks.

**Key inputs:**

- Every operation requires `--operation <retrieve|validate|create|update>`, `--member <exact-Flow-API-name>`, `--target-org <alias-or-username>`, and `--project-dir <existing-DX-project>`. `--wait` accepts 1–30 minutes (default `10`). Use `--json` for structured results.
- `retrieve` and `validate` accept repeated `--member` selections and use the project's configured package directories. Validation does not apply a deployment.
- `create` and `update` require exactly one member plus `--source-file <Flow-XML-path>`, `--expected-org-id <18-character-destination-org-ID>`, `--source-org-id <18-character-source-org-ID>`, and `--reuse-same-org-references`. The source file must be inside a configured package directory. Source and destination org IDs must match: source provenance and reference reuse are explicit caller-verified declarations, not inferred mappings.
- `update` additionally requires `--expected-definition-id <18-character-FlowDefinition-ID>` and `--expected-latest-version-id <18-character-latest-Flow-version-ID>` from a verified current target baseline. These flags are UPDATE-only.

**Mutation contract:** CREATE requires a fresh valid API name and rejects an existing definition rather than overwriting it. UPDATE requires the existing inactive member, checks its identity, status and modification baseline before and after dry-run, and never falls back to CREATE. Supported source is inactive `Draft` or `InvalidDraft` `AutoLaunchedFlow` XML. Configuration is transported unchanged, including actions, inputs, tracking, wiring and `publishSegment`; it is not stripped into a simplified replacement or made runtime-ready.

**Results and caller coordination:** Results identify the operation, state, Core job and retained member diagnostics. A pending result is not success (public command exit code `69`): inspect the Core job before retrying. Core provides neither atomic create-only deployment nor atomic update-only/compare-and-swap. Reserve the selected name or existing target against concurrent external writers for the entire operation; preflight and post-dry-run checks do not close the final check/apply race. No activation, execution, debugging, sending, publication operation, or Campaign-association rewrite is exposed.

**Retained acceptance (2026-09-15):** A normally packed, freshly privately npm-installed candidate passed public oclif retrieve, real check-only validation, same-org draft CREATE, UPDATE and repeat UPDATE. Independent XML readbacks matched the intended documents; repeated CREATE rejected the existing name, and the original source remained unchanged. Follow-up reads confirmed inactive definitions and versions, no active/activation/scheduled-start values on the selected FlowRecords, and no Campaign association on the two new fixtures. Repetition proves semantic equality, not absence of platform timestamp changes or automation side effects. This is public installed-command evidence, not host `sf plugins install` registration, cross-org Flow portability, runtime readiness, or historical no-send proof.

### `sf mcnext campaign config`

**Purpose:** Export, create or update a bounded Campaign scalar configuration through Core Salesforce CLI. Supported fields are `Name`, `Type`, `Status`, `IsActive` and `Description`; this is not a Campaign dependency-tree migration.

**Key inputs:**

- Every operation requires `--operation <export|create|update>`, `--target-org <alias-or-username>`, `--expected-org-id <18-character-org-ID>`, `--api-version <version>`, and `--project-dir <existing-directory>`. Relative file paths resolve from that directory; `--json` returns the structured result.
- `export`: exact `--record-id <18-character-Campaign-ID>` and `--output-file <new-artifact-path>`.
- `create`: `--input-file <artifact-path>`, a distinct fresh `--target-name`, and `--journal-file <new-private-journal-path>`.
- `update`: `--input-file <patch-path>`, exact `--record-id <18-character-target-Campaign-ID>`, and `--expected-name <current-target-name>`. UPDATE cannot rename or upsert.

**Artifacts and safety:** Input artifacts contain `sourceId` and a nonempty `fields` object. Export omits null scalar values. CREATE explicitly records the source-to-target identity mapping in its journal, retaining target-local owner defaults. A private pending journal is written before mutation and the returned identity is saved before readback. Existing target names are rejected, but name absence checks are not atomic uniqueness guarantees. UPDATE verifies the exact ID/current name, checks submitted values by readback, and preserves the selected untouched fields and relationships. Source relationships are rejected on export; relationship inputs, custom fields, null clearing, empty strings and complex quoting are unsupported. Reconcile failed or ambiguous writes manually; never blindly retry. Repeated UPDATE can rerun automation even when scalar values are unchanged. No member migration, sending, schema deployment or automatic lifecycle operation is implemented.

**Retained acceptance (2026-09-15):** An independently packed and privately npm-installed candidate passed public-command cross-org export, five-scalar CREATE, exact readback, Description UPDATE and repeat UPDATE, including preservation checks and an existing-name CREATE conflict. The source remained unchanged. Campaign-specific compiled implementation and messages, the Campaign manifest entry, and the shared Core execution function match the newer normally packed Flow candidate. The full shared Flow module and package metadata differ: this is matching component provenance, not a new Campaign roundtrip on that newer package or proof of an identical complete dependency tree. Scalar repeat equality does not prove side-effect idempotence or absence of indirect/background sends.

**Combined evidence boundary:** These bounded Flow/Campaign checks do not establish host `sf` plugin registration, integration with the current CMS provider, cross-org Flow rewriting, Flow-to-Campaign association creation, or complete seven-family migration acceptance.

### `sf mcnext migration plan`

**Purpose:** Write a deterministic source-to-target assessment. The command performs bounded prerequisite checks and can optionally add CMS contract, package, correlation, and workspace-route evidence. It is always planning-only.

**Typical use:** Compare source and target prerequisites, retain a stable capability inventory, or assess CMS workspace evidence and explicit source-to-target routes before deciding what can be migrated manually or by another tool.

**Key inputs:**

- `--source-org <alias-or-username>`: source org used for read-only assessment and CMS export.
- `--target-org <alias-or-username>` / `-o`: target org used for read-only prerequisite checks.
- `--output-file <path>`: destination for the deterministic JSON plan.
- `--cms-plan`: enables CMS provider discovery and one read-only aggregate export of Marketing workspaces.
- `--cms-workspace-map <path>`: required with `--cms-plan`; supplies explicit source-workspace-ID to target-workspace-ID routes.
- `--cms-export-dir <path>`: required with `--cms-plan`; must identify a new, unused run-owned location for exported packages and retained evidence.
- `--cms-evidence-file <path>`: optional separately supplied opaque evidence; it does not invoke CMS or make a plan executable.

The three CMS planning flags are a unit: both companion flags are required when `--cms-plan` is present, and neither companion flag is accepted without it. The workspace-map file has exactly this shape:

```json
{
  "version": 1,
  "workspaces": {
    "0Zu000000000001AAA": "0Zu000000000101AAA",
    "0Zu000000000002AAA": "0Zu000000000102AAA"
  }
}
```

Keys are exact canonical source workspace IDs and values are explicit target workspace IDs. Workspace names are never routing keys. The parser rejects duplicate JSON keys, duplicate target routes, empty or whitespace-altered IDs, unsupported versions, unexpected fields, empty maps, and oversized input. The plan retains the map's exact-byte SHA-256 and byte length as provenance. A missing route blocks only the affected CMS workspace.

Create a CMS-independent assessment:

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json
```

Add CMS planning evidence:

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-plan --cms-workspace-map cms-workspaces.json --cms-export-dir .mcnext-runs/cms-export
```

Supply opaque evidence without invoking CMS:

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-evidence-file cms-evidence.json
```

**Output and artifacts:** The command prints a `Migration prerequisite preflight` table and writes the JSON plan. Without CMS planning, a representative `--json` result is:

```json
{
  "outputFile": "migration-plan.json",
  "sourceOrgId": "0ZZ000000000001AAA",
  "targetOrgId": "0ZZ000000000002AAA",
  "preflightPassed": true,
  "inventoryItems": 66,
  "deferredCmsDependencies": 0,
  "readOnly": true
}
```

When CMS planning is requested, the result adds a bounded summary of the CMS branch:

```json
{
  "outputFile": "migration-plan.json",
  "sourceOrgId": "0ZZ000000000001AAA",
  "targetOrgId": "0ZZ000000000002AAA",
  "preflightPassed": true,
  "inventoryItems": 66,
  "deferredCmsDependencies": 0,
  "cmsPlanning": { "state": "ownership-uncertain", "experimental": true, "readyRoutes": 0, "blockedRoutes": 1 },
  "readOnly": true
}
```

The plan file begins with stable top-level fields and contains detailed `preflight`, `inventory`, optional `cmsPlanning`, and deferred-evidence records:

```json
{
  "schemaVersion": 1,
  "mode": "read-only",
  "testedApiVersion": "67.0",
  "sourceOrgId": "0ZZ000000000001AAA",
  "targetOrgId": "0ZZ000000000002AAA",
  "executableTargetPayloads": []
}
```

**CMS provider operations:** Planning invokes only these public CLI surfaces:

```bash
sf cms info --contract-version 1 --json
sf cms export workspace --target-org <source-org> --all --workspace-type Marketing --output-dir <cms-export-dir> --contract-version 1 --json
```

The export runs once per planning request. MCN validates the provider identity and version, status/exit agreement, capability state, package manifest, exact-byte hashes, path confinement, source-org/workspace/package provenance, and `sf-cms-external-reference-correlations@1` evidence. Correlation uses exact opaque source-value equality only. MCN does not inspect item bodies to derive identity, normalize or hash source references, fuzzy-match names or IDs, synthesize mappings, discover CMS dependencies, choose import order, or perform CMS-internal rewriting. CMS remains the owner of identity, dependency closure, canonical `referenceId` values, package schemas, source-to-target CMS mappings, import ordering, and internal rewrites.

**Planning states:**

- `ready-for-execution`: not produced because the command has no independently evidenced MCN dependency source.
- `partial`: usable evidence exists, but one or more CMS-dependent branches are blocked or failed.
- `blocked`: compatibility, capability, route, integrity, provenance, or correlation evidence prevents execution readiness.
- `failed`: CMS discovery or export failed.
- `ownership-uncertain`: exact ownership or field semantics are not evidenced.
- `experimental`: a visible qualifier on otherwise ready or partial evidence, not a primary state and not a waiver for validation.

Capabilities advertised as `implemented` or `experimental` can contribute planning evidence when every required check passes. Experimental qualification is visible in human output, command results, and plan records. Human output also summarizes CMS state and route counts separately from prerequisite preflight, with guidance when CMS planning is not ready. Correlations are retained as planning evidence, but there is no independently evidenced workspace/owner/field-bound MCN dependency source, so successful package and route evidence remains `ownership-uncertain` and produces no ready dependent edge. `--cms-evidence-file` input cannot fill that gap. Missing or unknown capability states, `unavailable` capabilities, malformed envelopes, incompatible contracts, partial package evidence, unresolved provider diagnostics, package/provenance failures, and zero, duplicate, or conflicting exact correlations block the dependent branch.

**Important limitations:** The command may read org prerequisites, discover the CMS provider, run read-only aggregate export, read public package evidence, and write local plan/evidence files. It never runs CMS import, passes `--apply`, deploys, writes or deletes target records, rewrites references, creates executable target payloads, performs cleanup or rollback, or mutates either org. Without `--cms-plan`, no CMS command runs, and CMS provider failures do not affect CMS-independent paths.

## Capability ownership

`sf mcnext list types` uses these support states:

- `implemented` — this plugin provides the listed operations.
- `delegated` — use the core `sf` CLI command shown in the `delegatedTo` column.
- `conditional` — evidence exists, but v1 does not expose the capability because safe portable behavior is not established.
- `deferred` — intentionally outside this plugin's v1 scope.

Flows, flow definitions, flow tests, managed content types, content type bundles, segment definitions, and segment records remain delegated to core Salesforce CLI functionality. Some delegated metadata capabilities support both retrieval and deployment, which is why the plugin should be understood as part of broader read/write MCN workflows even though its direct v1 commands focus on exports and configuration inspection.

## v1 scope and limitations

- Direct Marketing Cloud Next API commands are pinned to API version `67.0`. Other versions are rejected because the retained endpoints were verified only against v67.
- CMS-aware migration planning requires the separately installed provider and consumes only its public CLI JSON contract. There is no direct CMS JavaScript API dependency.
- `sf mcnext migration plan` is assessment-only and writes no executable target payloads.
- `ListEmail` is excluded from v1. Read evidence exists, but portable dependency resolution and safe deployment have not been proven.
- Identity-resolution support is configuration-only. It does not migrate or export unified-profile rows.
- Segment member export is read-only. Member IDs are opaque SSOT membership values and are not asserted to be Salesforce CRM record IDs.
- v2/v3 documentation must add migration and CMS prerequisites when those capabilities become available; the v1 prerequisites are not sufficient for those future workflows.

## Authorized NUT

The live NUT is read-only and restricted in its source to org alias `mcnext-sdo`, org ID `00Daj000010xkZNEAY`, and published segment API name `Annual_Promo_Segment_1789248847753`. It writes a bounded JSON export to a temporary directory, checks only sanitized structure and counts, and then removes the temporary files.

Authorize the existing org alias before opting in:

```bash
sf org login web --alias mcnext-sdo --instance-url https://login.salesforce.com
sf org display --target-org mcnext-sdo --json
```

Confirm that the displayed org ID is exactly `00Daj000010xkZNEAY`. Then run:

```bash
SF_PLUGIN_MCNEXT_NUTS=1 npm run test:nuts
```

In PowerShell 5.1:

```powershell
$env:SF_PLUGIN_MCNEXT_NUTS = '1'
npm run test:nuts
```

Without that environment variable, the live NUT is skipped.

## License

MIT
