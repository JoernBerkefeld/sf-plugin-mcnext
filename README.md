# sf-plugin-mcnext

Salesforce CLI plugin for working with Marketing Cloud Next data and configuration. The plugin can support read/write workflows overall: it implements MCN-specific capabilities where needed and points to or delegates to the core `sf` CLI when Salesforce CLI already owns retrieval, deployment, or data operations.

CMS integration is deferred until `sf-plugin-cms` publishes an approved public service contract.

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

**Purpose:** Write a deterministic, read-only source-to-target assessment containing the first v2 ownership/transport/support-state inventory and prerequisite preflight.

**Required flags:** `--source-org`, `--target-org` / `-o`, and `--output-file`. Optional `--cms-evidence-file` accepts only an array of minimal opaque deferred nodes with `owner`, `status`, `sourceReference`, and `blockedOperation`.

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json
```

**Expected output/file:** A stable JSON plan with source/target org IDs, v67 availability and distinct-org checks, actionable manual prerequisites, the full first-increment inventory, and no executable target payloads. Maximum-version discovery is diagnostic only; each org's authenticated v67 request independently determines its pass or blocked status. Coverage is expressed as separate declarative rows whenever ownership, transport, selection, prerequisites, dependencies, evidence, or status differs—for example MarketSegment object/field configuration versus records, clickjack trusted domains for external-form framing, managed packages, required target components, unresolved Prospect identity, layouts versus Lightning pages, and Data 360 definitions versus secondary rows.

**Important notes:** Inventory completeness does not imply automation completeness. Rows honestly remain `conditional`, `manual prerequisite`, `unsupported`, or `deferred` until representative transport and source-to-target evidence exists. This command never deploys or mutates data. It does not import CMS code, inspect CMS payloads, create mappings, rewrite references, infer CMS lifecycle or ordering, or place a CMS source reference in a target payload. Blocked preflight checks produce an incomplete plan instead of an execution attempt.

## Capability ownership

`sf mcnext list types` uses these support states:

- `implemented` — this plugin provides the listed operations.
- `delegated` — use the core `sf` CLI command shown in the `delegatedTo` column.
- `conditional` — evidence exists, but v1 does not expose the capability because safe portable behavior is not established.
- `deferred` — intentionally outside this plugin's v1 scope.

Flows, flow definitions, flow tests, managed content types, content type bundles, segment definitions, and segment records remain delegated to core Salesforce CLI functionality. Some delegated metadata capabilities support both retrieval and deployment, which is why the plugin should be understood as part of broader read/write MCN workflows even though its direct v1 commands focus on exports and configuration inspection.

## v1 scope and limitations

- Direct Marketing Cloud Next API commands are pinned to API version `67.0`. Other versions are rejected because the retained endpoints were verified only against v67.
- Generic CMS content, variants, media, workspaces, publication, identities, mappings, lifecycle, and reference rewriting are excluded. CMS integration is deferred until `sf-plugin-cms` publishes an approved public service contract.
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
