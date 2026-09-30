# sf-plugin-mcnext

Salesforce CLI plugin for people who need to inspect, export, validate, or carefully move selected Marketing Cloud Next configuration and data.

The plugin adds commands where Marketing Cloud Next needs a dedicated workflow and delegates to the core `sf` CLI where Salesforce CLI already provides the transport. It does not claim complete Marketing Cloud Next migration support.

## Prerequisites

- Node.js `22.19.0` or later.
- The current Salesforce CLI.
- An authorized Salesforce org with the Marketing Cloud Next or Data 360 features and permissions required by the command you run.

```bash
npm install --global @salesforce/cli
sf --version
```

## Install or update the plugin

```bash
sf plugins install sf-plugin-mcnext
sf plugins update
```

Version `0.6.2` exposes the 15 public commands documented below.

MCNext declares the released [`sf-plugin-cms`](https://github.com/JoernBerkefeld/sf-plugin-cms) package as an installed oclif plugin dependency. A normal MCNext installation therefore installs and registers the compatible CMS provider automatically; users do not need a separate `sf plugins install sf-plugin-cms` step.

```bash
sf plugins install sf-plugin-mcnext
sf cms --help
sf cms info --contract-version 1 --json
```

The integration still uses the public Salesforce CLI boundary: MCNext invokes `sf cms` commands and negotiates their versioned JSON contracts rather than importing CMS implementation modules. CMS owns CMS discovery, payload construction, package files, internal CMS references, provider reports, and all CMS writes. MCNext owns cross-family selection, routing, policy, orchestration, typed dependency mapping, and fail-closed validation of the public provider results.

## Getting started and authentication

The examples use safe representative values such as `my-mcnext-org`, `Annual_Promo`, and `00D000000000001AAA`. Replace those values for your environment.

Normal Salesforce CLI org authorization covers `segment members export` and every other org-backed command in this plugin. Use any supported `sf org login` mode for the target org; you do not need a separate Connected App or authentication stack for `--include-details`.

```bash
sf org login web --alias my-mcnext-org --instance-url https://login.salesforce.com
sf mcnext list types
sf mcnext segment members export --target-org my-mcnext-org --segment Annual_Promo --output-file members.csv --max-items 100
```

Only `sf mcnext data-graph metadata` uses an externally obtained Data 360 token and tenant URL. That command's token can come from an External Client App flow; it is intentionally separate from normal CLI org authentication.

The hidden `mcn` topic is a short alias for `mcnext`; this README uses canonical `mcnext` command names. Run `sf <command> --help` before using unfamiliar flags or a mutating operation.

## Common inherited options

Every command inherits the following oclif options. Command-specific tables link here instead of duplicating them.

| Option                                                 | Required | Expected/allowed values                                                                                                          |
| ------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`--json`](#common-inherited-options)                  | No       | Boolean. Formats the command result as JSON. This controls CLI result output; it does not replace command-specific output files. |
| [`--flags-dir <directory>`](#common-inherited-options) | No       | String path to a directory from which oclif imports flag values. Not repeatable.                                                 |

## Command inventory

- [`sf mcnext list types`](#sf-mcnext-list-types)
- [`sf mcnext segment members export`](#sf-mcnext-segment-members-export)
- [`sf mcnext segment records export`](#sf-mcnext-segment-records-export)
- [`sf mcnext identity-resolution list`](#sf-mcnext-identity-resolution-list)
- [`sf mcnext identity-resolution show`](#sf-mcnext-identity-resolution-show)
- [`sf mcnext identity-resolution export`](#sf-mcnext-identity-resolution-export)
- [`sf mcnext email send-definition show`](#sf-mcnext-email-send-definition-show)
- [`sf mcnext email-template show`](#sf-mcnext-email-template-show)
- [`sf mcnext data-graph metadata`](#sf-mcnext-data-graph-metadata)
- [`sf mcnext identity-resolution plan`](#sf-mcnext-identity-resolution-plan)
- [`sf mcnext flow source`](#sf-mcnext-flow-source)
- [`sf mcnext migration plan`](#sf-mcnext-migration-plan)
- [`sf mcnext segment definition create`](#sf-mcnext-segment-definition-create)
- [`sf mcnext campaign config`](#sf-mcnext-campaign-config)
- [`sf mcnext migration cms`](#sf-mcnext-migration-cms)

## `sf mcnext list types`

Lists capability ownership, support state, operations, delegation targets, and limitations without accessing an org.

```bash
sf mcnext list types --provider core-sf
sf mcnext list types --state conditional
```

### Options

| Option                                                | Required | Expected/allowed values                                                                         |
| ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `--provider <provider>`                               | No       | One of `mcnext`, `core-sf`, `cms-service`, `external/manual`, `secondary-data`. Not repeatable. |
| `--state <state>`                                     | No       | One of `implemented`, `delegated`, `conditional`, `deferred`. Not repeatable.                   |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                                                                        |

## `sf mcnext segment members export`

Resolves a segment once and exports computed member rows. `--segment` accepts exactly these three identifier forms: the segment API/developer name, the exact display name, or a 15- or 18-character `MarketSegment` record ID. Display-name matches must be exact and unambiguous.

Basic mode is the default (`--include-details=false`) and preserves the v0.6.2 resolution and members endpoint contract. CSV uses the first returned row's keys as a stable header and column set; JSON contains the returned row objects. The endpoint's member `id` remains an opaque SSOT/Watson membership value. `--fields`, `--filters`, `--order-by`, and `--offset` apply only to this basic endpoint mode and are rejected with `--include-details`.

Enriched mode (`--include-details`) reads the latest-membership and segment-on DMO names from the resolved segment detail envelope. Before metadata or Query API access, it validates `--data-space` against the authorized user's core `DataSpace` records, because Data 360 metadata and synchronous Query API can silently fall back when given an unknown `Data-Space` header. The authorized org user needs read access to `DataSpace`, the segment, the selected data space, Data 360 metadata, Query API, and the involved DMOs. This does not require a separate Connected App.

The enriched output is details-only: exactly the 19 fields exposed by `UnifiedssotIndividualMkt__dlm`, in Data 360 service metadata order. There is one output row per membership. No membership key or match-count helper is emitted. A membership without a matching detail row has all 19 values as null: JSON writes explicit `null`; CSV writes empty cells. Multiple detail matches fail closed rather than duplicating a member.

Both modes stage CSV or JSON beside the destination and replace it only after segment discovery, metadata/query requests, paging, schema validation, formatting, file close, and final replacement all succeed. Normally, a failure restores the existing destination bytes and removes staging artifacts. In the exceptional case where automatic restoration cannot complete, the command raises `AtomicOutputRecoveryError`; its message reports whether the destination is absent, present, or unknown and gives the exact sibling backup path retaining the original bytes. The default paging safety bounds are 1,000 pages, 1,000,000 items, and 900,000 ms.

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment Annual_Promo --output-file members.csv
sf mcnext segment members export --target-org my-mcnext-org --segment "Annual Promo" --output-file members.json --result-format json --fields Id__c,Delta_Type__c --filters "Delta_Type__c in ('new')" --order-by "Id__c asc" --limit 100 --offset 0
sf mcnext segment members export --target-org my-mcnext-org --segment Annual_Promo --output-file member-details.csv --include-details
sf mcnext segment members export --target-org my-mcnext-org --segment Annual_Promo --output-file member-details.json --result-format json --include-details --data-space Marketing
sf mcnext segment members export --target-org my-mcnext-org --segment 1sg000000000001AAA --output-file members.csv --max-pages 10 --max-items 1000 --max-duration-ms 60000
```

With `--json`, the command result reports provenance without member data: `segmentApiName`, `outputFile`, `resultFormat`, `includeDetails`, `dataSpace`, `rowsWritten`, and `complete`. Enriched results also include `enriched.objectApiName` and the 19 `enriched.columns` metadata entries.

The enriched path passed the full packed installed-host live matrix for CSV and JSON, including populated and unmatched memberships, deterministic limits, atomic destination handling, and authoritative core `DataSpace` preflight before Data 360 metadata or Query API access. That evidence covers the bounded `--include-details` contract described here; it does not broaden the exported schema beyond the documented 19 fields.

### Options

| Option                                                | Required | Expected/allowed values                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target-org <alias-or-username>`, `-o`              | Yes      | Authorized Marketing Cloud Next org alias or username. String; not repeatable.                                                                                                                                            |
| `--segment <identifier>`, `-s`                        | Yes      | Segment API/developer name, exact display name, or 15/18-character `MarketSegment` record ID. String; not repeatable.                                                                                                     |
| `--output-file <path>`                                | Yes      | Destination CSV or JSON file. Parent directories are created. Existing bytes are normally restored on failure; if restoration is impossible, the command fails with the exact sibling backup path retaining the original. |
| `--result-format <format>`                            | No       | `csv` or `json`; default `csv`.                                                                                                                                                                                           |
| `--include-details`                                   | No       | Boolean; default `false`. Enables the details-only 19-field Unified Individual export through Data 360 Query API.                                                                                                         |
| `--data-space <name>`                                 | No       | Accessible core `DataSpace.Name` used for enriched metadata/query requests; default `default`. Unknown or ambiguous names fail before Data 360 access or destination replacement.                                         |
| `--fields <field-list>`                               | No       | Basic mode only: comma-separated SSOT storage fields, for example `Id__c,Delta_Type__c`; passed through to the endpoint.                                                                                                  |
| `--filters <expression>`                              | No       | Basic mode only: endpoint filter expression, for example `Delta_Type__c in ('new')`; passed through unchanged.                                                                                                            |
| `--order-by <expression>`                             | No       | Basic mode only: endpoint ordering expression, for example `Id__c asc`; passed through unchanged.                                                                                                                         |
| `--limit <integer>`                                   | No       | Rows requested per page; integer `>= 1`; default `200`.                                                                                                                                                                   |
| `--offset <integer>`                                  | No       | Basic mode only: zero-based first-page offset; integer `>= 0`; default `0`.                                                                                                                                               |
| `--max-pages <integer>`                               | No       | Paging safety bound; integer `>= 1`; default client bound `1000`. Exceeding it fails before destination replacement begins.                                                                                               |
| `--max-items <integer>`                               | No       | Maximum emitted rows; integer `>= 1`; default client bound `1000000`. A larger source result is truncated deterministically rather than treated as an error.                                                              |
| `--max-duration-ms <integer>`                         | No       | Paging-time safety bound in milliseconds; integer `>= 1`; default client bound `900000`. Exceeding it fails before destination replacement begins.                                                                        |
| `--column-delimiter <name>`                           | No       | CSV only: `BACKQUOTE`, `CARET`, `COMMA`, `PIPE`, `SEMICOLON`, or `TAB`; default `COMMA`.                                                                                                                                  |
| `--line-ending <name>`                                | No       | CSV only: `LF` or `CRLF`; default `LF`.                                                                                                                                                                                   |
| `--api-version <version>`                             | No       | Salesforce API version; only the retained `67.0` baseline is accepted by this direct MCN command.                                                                                                                         |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                                                                                                                                                                                                  |

## `sf mcnext segment records export`

Delegates a `MarketSegment` bulk export to core `sf data export bulk`, selecting `Id`, `Name`, `MarketSegmentType`, `SegmentStatus`, and `PublishStatus`. Core Salesforce CLI owns job behavior and file creation.

```bash
sf mcnext segment records export --target-org my-mcnext-org --output-file segments.csv
sf mcnext segment records export --target-org my-mcnext-org --output-file segments.json --result-format json --wait 20 --api-version 67.0 --all-rows
```

### Options

| Option                                                | Required | Expected/allowed values                                                                                                     |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--target-org <alias-or-username>`, `-o`              | Yes      | Org passed to core bulk export. String; not repeatable.                                                                     |
| `--output-file <path>`                                | Yes      | File path passed to core bulk export; core bulk export creates or overwrites the result file according to its own behavior. |
| `--result-format <format>`                            | No       | `csv` or `json`; default `csv`.                                                                                             |
| `--wait <minutes>`, `-w`                              | No       | Integer `>= 0`; default `10`. Passed to core bulk export.                                                                   |
| `--api-version <version>`                             | No       | API version override passed to core bulk export, for example `67.0`.                                                        |
| `--all-rows`                                          | No       | Boolean; includes soft-deleted records; default `false`.                                                                    |
| `--column-delimiter <name>`                           | No       | CSV: `BACKQUOTE`, `CARET`, `COMMA`, `PIPE`, `SEMICOLON`, or `TAB`.                                                          |
| `--line-ending <name>`                                | No       | CSV: `LF` or `CRLF`.                                                                                                        |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                                                                                                    |

## `sf mcnext identity-resolution list`

Lists ruleset configurations and aggregate status from one non-paginated collection request. It does not export unified-profile rows.

```bash
sf mcnext identity-resolution list --target-org my-mcnext-org --api-version 67.0
```

### Options

| Option                                                | Required | Expected/allowed values                     |
| ----------------------------------------------------- | -------- | ------------------------------------------- |
| `--target-org <alias-or-username>`, `-o`              | Yes      | Authorized MCN org. String; not repeatable. |
| `--api-version <version>`                             | No       | Only retained baseline `67.0`.              |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                    |

## `sf mcnext identity-resolution show`

Retrieves one ruleset configuration by Salesforce ruleset ID.

```bash
sf mcnext identity-resolution show --target-org my-mcnext-org --ruleset-id 1ir000000000001AAA --api-version 67.0
```

### Options

| Option                                                | Required | Expected/allowed values                          |
| ----------------------------------------------------- | -------- | ------------------------------------------------ |
| `--target-org <alias-or-username>`, `-o`              | Yes      | Authorized MCN org.                              |
| `--ruleset-id <id>`                                   | Yes      | Exact Salesforce identity-resolution ruleset ID. |
| `--api-version <version>`                             | No       | Only retained baseline `67.0`.                   |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                         |

## `sf mcnext identity-resolution export`

Writes one complete ruleset configuration as JSON.

```bash
sf mcnext identity-resolution export --target-org my-mcnext-org --ruleset-id 1ir000000000001AAA --output-file identity-resolution.json --api-version 67.0
```

### Options

| Option                                                | Required | Expected/allowed values                                                                                  |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `--target-org <alias-or-username>`, `-o`              | Yes      | Authorized MCN org.                                                                                      |
| `--ruleset-id <id>`                                   | Yes      | Exact Salesforce identity-resolution ruleset ID.                                                         |
| `--output-file <path>`                                | Yes      | Destination JSON configuration file. Parent directories are created and an existing file is overwritten. |
| `--api-version <version>`                             | No       | Only retained baseline `67.0`.                                                                           |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                                                                                 |

## `sf mcnext email send-definition show`

Delegates an exact read of one `ListEmail` record to core `sf data get record`. It does not publish or send email.

```bash
sf mcnext email send-definition show --target-org my-mcnext-org --record-id 0XB000000000001AAA --api-version 67.0
```

### Options

| Option                                                | Required | Expected/allowed values                                     |
| ----------------------------------------------------- | -------- | ----------------------------------------------------------- |
| `--target-org <alias-or-username>`, `-o`              | Yes      | Authorized Salesforce org.                                  |
| `--record-id <id>`                                    | Yes      | Exact Salesforce `ListEmail` record ID.                     |
| `--api-version <version>`                             | No       | API version passed to the core command, for example `67.0`. |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                                    |

## `sf mcnext email-template show`

Reads one CMS email template by managed content ID and verifies content type `sfdc_cms__emailTemplate`.

```bash
sf mcnext email-template show --target-org my-mcnext-org --content-id 20Y000000000001AAA --api-version 67.0
```

### Options

| Option                                                | Required | Expected/allowed values                |
| ----------------------------------------------------- | -------- | -------------------------------------- |
| `--target-org <alias-or-username>`, `-o`              | Yes      | Authorized Salesforce org.             |
| `--content-id <id>`                                   | Yes      | Exact 18-character managed content ID. |
| `--api-version <version>`                             | No       | Retained supported baseline `67.0`.    |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.               |

## `sf mcnext data-graph metadata`

Performs one read-only `GET /api/v1/dataGraph/metadata`. Obtain the Data 360 bearer token outside this plugin and keep its file outside the repository.

```bash
sf mcnext data-graph metadata --instance-url https://example.c360a.salesforce.com --access-token-file "C:\private\data360-token.txt"
```

### Options

| Option                                                | Required | Expected/allowed values                                                   |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `--instance-url <url>`                                | Yes      | Tenant-specific HTTPS Data 360 instance URL. Non-HTTPS URLs are rejected. |
| `--access-token-file <path>`                          | Yes      | Existing private file containing exactly one non-whitespace bearer token. |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                                                  |

## `sf mcnext identity-resolution plan`

Builds a GET-only, conflict-checked CREATE plan or an exact UPDATE shell. It never sends a mutation request and does not produce an executable mutation payload.

```bash
sf mcnext identity-resolution plan --intent create --source-org source-mcn --target-org target-mcn --expected-source-org-id 00D000000000001AAA --expected-target-org-id 00D000000000002AAA --input-file identity-resolution-plan.json --api-version 67.0
sf mcnext identity-resolution plan --intent update-shell --source-org source-mcn --target-org target-mcn --expected-source-org-id 00D000000000001AAA --expected-target-org-id 00D000000000002AAA --target-ruleset-id 1ir000000000001AAA --expected-target-label "Marketing Rules" --expected-target-key Individual__dlm --expected-target-status DRAFT --input-file identity-resolution-plan.json --api-version 67.0
```

### Options

| Option                                                | Required           | Expected/allowed values                                             |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `--intent <intent>`                                   | Yes                | `create` or `update-shell`.                                         |
| `--source-org <alias-or-username>`                    | Yes                | Source MCN org.                                                     |
| `--target-org <alias-or-username>`, `-o`              | Yes                | Different target MCN org.                                           |
| `--expected-source-org-id <id>`                       | Yes                | Expected 18-character source org ID.                                |
| `--expected-target-org-id <id>`                       | Yes                | Expected 18-character target org ID; must differ from source.       |
| `--target-ruleset-id <id>`                            | For `update-shell` | Exact target ruleset ID. Forbidden for `create`.                    |
| `--expected-target-label <label>`                     | For `update-shell` | Exact target label. Forbidden for `create`.                         |
| `--expected-target-key <key>`                         | For `update-shell` | Exact target object API name/read-only key. Forbidden for `create`. |
| `--expected-target-status <status>`                   | For `update-shell` | Exact target status. Forbidden for `create`.                        |
| `--input-file <path>`                                 | Yes                | JSON containing only `configuration` and `mappings`.                |
| `--api-version <version>`                             | No                 | Only retained baseline `67.0`.                                      |
| [Common inherited options](#common-inherited-options) | No                 | `--json`, `--flags-dir`.                                            |

## `sf mcnext flow source`

Retrieves or validates selected Flow source through core CLI, or creates/updates one inactive same-org draft. `retrieve` and `validate` accept repeatable exact members. `create` and `update` require exactly one member and do not support cross-org mapping, activation, execution, sending, or publication.

```bash
sf mcnext flow source --operation retrieve --member MyFlow --target-org my-mcnext-org --project-dir ./project
sf mcnext flow source --operation validate --member MyFlow --target-org my-mcnext-org --project-dir ./project --wait 10
sf mcnext flow source --operation create --member FreshFlow --target-org my-mcnext-org --project-dir ./project --source-file force-app/main/default/flows/FreshFlow.flow-meta.xml --expected-org-id 00D000000000002AAA --source-org-id 00D000000000002AAA --reuse-same-org-references
sf mcnext flow source --operation update --member MyFlow --target-org my-mcnext-org --project-dir ./project --source-file force-app/main/default/flows/MyFlow.flow-meta.xml --expected-org-id 00D000000000002AAA --source-org-id 00D000000000002AAA --reuse-same-org-references --expected-definition-id 300000000000001AAA --expected-latest-version-id 301000000000001AAA
```

### Options

| Option                                                | Required      | Expected/allowed values                                                                                                                                         |
| ----------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--operation <operation>`                             | Yes           | `retrieve`, `validate`, `create`, or `update`.                                                                                                                  |
| `--member <api-name>`                                 | Yes           | Exact Flow API name. Repeatable for retrieve/validate; exactly one for create/update. Wildcards are rejected.                                                   |
| `--target-org <alias-or-username>`                    | Yes           | Org passed to core CLI.                                                                                                                                         |
| `--project-dir <directory>`                           | Yes           | Existing Salesforce DX project root.                                                                                                                            |
| `--source-file <path>`                                | Create/update | Inactive Core Flow XML inside a configured package directory. Mutation-only.                                                                                    |
| `--expected-org-id <id>`                              | Create/update | Verified 18-character destination org ID. Mutation-only.                                                                                                        |
| `--expected-definition-id <id>`                       | Update        | Verified 18-character existing `FlowDefinition` ID. Update-only.                                                                                                |
| `--expected-latest-version-id <id>`                   | Update        | Verified current 18-character latest Flow version ID. Update-only.                                                                                              |
| `--source-org-id <id>`                                | Create/update | Caller-verified source org ID; must equal `--expected-org-id`. Mutation-only.                                                                                   |
| `--reuse-same-org-references`                         | Create/update | Boolean declaration that all references were verified for reuse in the same org. Required by the mutation workflow; default `false`.                            |
| `--expect-unchanged`                                  | Update only   | Boolean; default `false`. Permits an exact unchanged repeat and requires core/readback to confirm it; otherwise update requires a label/interview-label change. |
| `--wait <minutes>`                                    | No            | Integer `1`–`30`; default `10`.                                                                                                                                 |
| [Common inherited options](#common-inherited-options) | No            | `--json`, `--flags-dir`.                                                                                                                                        |

## `sf mcnext migration plan`

Writes a deterministic, read-only source-to-target assessment. It does not deploy, import, rewrite references, create target payloads, or mutate either org.

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-evidence-file cms-evidence.json
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-plan --cms-workspace-map cms-workspaces.json --cms-export-dir .mcnext-runs/cms-export
```

### Options

| Option                                                | Required          | Expected/allowed values                                                                                                           |
| ----------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--source-org <alias-or-username>`                    | Yes               | Source org used for read-only assessment.                                                                                         |
| `--target-org <alias-or-username>`, `-o`              | Yes               | Target org used for read-only checks.                                                                                             |
| `--output-file <path>`                                | Yes               | Deterministic JSON migration plan. Parent directories are created and an existing file is overwritten.                            |
| `--cms-evidence-file <path>`                          | No                | JSON array of minimal opaque deferred CMS evidence; cannot make CMS planning executable.                                          |
| `--cms-plan`                                          | No                | Boolean; default `false`. Enables provider discovery and read-only aggregate CMS export. Requires both companion flags.           |
| `--cms-workspace-map <path>`                          | With `--cms-plan` | JSON exactly shaped as `{"version":1,"workspaces":{"<sourceWorkspaceId>":"<targetWorkspaceId>"}}`. Rejected without `--cms-plan`. |
| `--cms-export-dir <path>`                             | With `--cms-plan` | New, unused run-owned export directory. Rejected without `--cms-plan`.                                                            |
| [Common inherited options](#common-inherited-options) | No                | `--json`, `--flags-dir`.                                                                                                          |

## `sf mcnext segment definition create`

Strictly creates one mapped `MarketSegmentDefinition`; it never updates or upserts. Use `--dry-run` first. Without it, the command validates, rechecks identity and absence, applies once, independently retrieves, and performs bounded correlation checks.

```bash
sf mcnext segment definition create --source-org source-mcn --target-org target-mcn --expected-source-org-id 00D000000000001AAA --expected-target-org-id 00D000000000002AAA --project-dir ./project --source-file force-app/main/default/marketSegmentDefinitions/FreshSegment.marketSegmentDefinition-meta.xml --member FreshSegment --mapping-file mappings/segment.json --dry-run
sf mcnext segment definition create --source-org source-mcn --target-org target-mcn --expected-source-org-id 00D000000000001AAA --expected-target-org-id 00D000000000002AAA --project-dir ./project --source-file force-app/main/default/marketSegmentDefinitions/FreshSegment.marketSegmentDefinition-meta.xml --member FreshSegment --mapping-file mappings/segment.json --wait 10 --visibility-polls 3
```

### Options

| Option                                                | Required | Expected/allowed values                                                           |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `--source-org <alias>`                                | Yes      | Authenticated source alias used for identity provenance.                          |
| `--target-org <alias>`                                | Yes      | Authenticated target alias passed to Core and Connect.                            |
| `--expected-source-org-id <id>`                       | Yes      | Expected 18-character source org ID.                                              |
| `--expected-target-org-id <id>`                       | Yes      | Expected 18-character target org ID.                                              |
| `--project-dir <directory>`                           | Yes      | Existing Salesforce DX project.                                                   |
| `--source-file <path>`                                | Yes      | Exact `MarketSegmentDefinition` XML inside a configured package directory.        |
| `--member <api-name>`                                 | Yes      | Exact `MarketSegmentDefinition` API name.                                         |
| `--mapping-file <path>`                               | Yes      | JSON explicit segment-reference mapping file, resolved from project directory.    |
| `--api-version <version>`                             | No       | Connect API version; defaults to supported plugin baseline.                       |
| `--dry-run`                                           | No       | Boolean; default `false`. Runs core check-only validation and stops before apply. |
| `--wait <minutes>`                                    | No       | Integer `1`–`30`; default `10`.                                                   |
| `--visibility-polls <count>`                          | No       | Integer `1`–`10`; default `3`.                                                    |
| [Common inherited options](#common-inherited-options) | No       | `--json`, `--flags-dir`.                                                          |

## `sf mcnext campaign config`

Exports, creates, or updates only `Name`, `Type`, `Status`, `IsActive`, and `Description`. Files are resolved relative to `--project-dir`. CREATE writes a private pending journal before mutation. UPDATE cannot rename or upsert and accepts only changed scalar fields.

```bash
sf mcnext campaign config --operation export --target-org target-mcn --expected-org-id 00D000000000002AAA --api-version 67.0 --project-dir . --record-id 701000000000001AAA --output-file campaign.json
sf mcnext campaign config --operation create --target-org target-mcn --expected-org-id 00D000000000002AAA --api-version 67.0 --project-dir . --input-file campaign.json --target-name "New campaign" --journal-file campaign-created.json
sf mcnext campaign config --operation update --target-org target-mcn --expected-org-id 00D000000000002AAA --api-version 67.0 --project-dir . --input-file campaign-patch.json --record-id 701000000000001AAA --expected-name "New campaign"
```

### Options

| Option                                                | Required      | Expected/allowed values                                                                                                                     |
| ----------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--operation <operation>`                             | Yes           | `export`, `create`, or `update`.                                                                                                            |
| `--target-org <alias-or-username>`                    | Yes           | Explicit core CLI org.                                                                                                                      |
| `--expected-org-id <id>`                              | Yes           | Expected 18-character org ID.                                                                                                               |
| `--api-version <version>`                             | Yes           | Explicit `NN.0` Salesforce API version, for example `67.0`.                                                                                 |
| `--project-dir <directory>`                           | Yes           | Existing project directory; relative files resolve here.                                                                                    |
| `--record-id <id>`                                    | Export/update | Exact 18-character Campaign ID. Forbidden for create.                                                                                       |
| `--expected-name <name>`                              | Update        | Exact current target name. Forbidden for export/create.                                                                                     |
| `--target-name <name>`                                | Create        | Fresh name distinct from source name. Forbidden for export/update.                                                                          |
| `--expect-unchanged`                                  | Update only   | Boolean; default `false`. Requires submitted values to equal the independent baseline before repeating the write.                           |
| `--input-file <path>`                                 | Create/update | JSON artifact containing `sourceId` and supported `fields`. Forbidden for export.                                                           |
| `--output-file <path>`                                | Export        | New JSON artifact; created with no overwrite. Forbidden for create/update.                                                                  |
| `--journal-file <relative-path>`                      | Create        | Required new private identity journal inside project root; no absolute, traversal, or existing-file overwrite. Forbidden for export/update. |
| [Common inherited options](#common-inherited-options) | No            | `--json`, `--flags-dir`.                                                                                                                    |

## `sf mcnext migration cms`

Experimental bounded CMS execution for independently ready selected routes; incomplete or blocked workspace routes remain excluded. Dry-run is the default. `--apply` enables sequential create-only imports only after every selected executable route passes preflight and dry-run. The command stops at the first non-success and does not retry or roll back.

```bash
sf mcnext migration cms --target-org target-mcn --expected-target-org-id 00D000000000002AAA --plan-file migration-plan.json --result-file cms-result.json --report-root .mcnext-runs/cms-reports --allow-experimental-cms
sf mcnext migration cms --target-org target-mcn --expected-target-org-id 00D000000000002AAA --plan-file migration-plan.json --result-file cms-result.json --report-root .mcnext-runs/cms-reports --allow-experimental-cms --apply
```

### Options

| Option                                                | Required        | Expected/allowed values                                                                                                      |
| ----------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--target-org <alias-or-username>`, `-o`              | Yes             | Target org resolved independently before execution.                                                                          |
| `--expected-target-org-id <id>`                       | Yes             | Exact 18-character target org ID; must match alias resolution and plan binding.                                              |
| `--plan-file <path>`                                  | Yes             | Existing deterministic migration-plan JSON with CMS package/route evidence.                                                  |
| `--result-file <path>`                                | Yes             | New durable execution-result JSON created with no overwrite; the plan is never modified.                                     |
| `--report-root <path>`                                | Yes             | Parent path for distinct provider-owned applied-import report directories.                                                   |
| `--allow-experimental-cms`                            | Effectively yes | Boolean opt-in required for dry-run and apply; default `false` and omission fails.                                           |
| `--apply`                                             | No              | Boolean; default `false`. After all dry-runs pass, runs sequential create-only imports. Requires `--allow-experimental-cms`. |
| [Common inherited options](#common-inherited-options) | No              | `--json`, `--flags-dir`.                                                                                                     |

## Safety and limitations

- Direct Marketing Cloud Next API commands use the verified API `67.0` baseline unless a delegated core command accepts another version.
- Read-only commands can still write local export, plan, evidence, or result files.
- Planning and discovery do not authorize mutation. Check the command's documented operation-specific requirements.
- Core CLI delegation means core `sf` owns underlying jobs, errors, and supported metadata or data transport.
- Segment member IDs are opaque SSOT membership values, not asserted Salesforce CRM record IDs.
- Identity Resolution support covers configuration and planning, not unified-profile row migration or mutation.
- Email commands are exact read operations; the plugin does not publish or send email.
- Data Graph support is metadata GET only; token exchange and graph mutation remain external.
- CMS support uses the registered `sf-plugin-cms` oclif plugin dependency and remains experimental for local execution; the dependency range controls installation compatibility, while versioned `sf cms` JSON contracts and advertised capabilities control runtime compatibility.
- The plugin does not provide complete dependency discovery, automatic reference rewriting, rollback, or end-to-end migration for all Marketing Cloud Next capabilities.

## Development

```bash
npm install --no-workspaces
npm run compile
npm run lint
npm test
sf plugins link .
```

Live-org tests require explicit private environment variables; never commit org IDs, aliases, keys, tokens, or test data.

## License

MIT
