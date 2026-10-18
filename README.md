# sf-plugin-mcnext

Salesforce CLI plugin for inspecting, exporting, validating, or carefully moving selected Marketing Cloud Next configuration and data. It adds dedicated workflows where Marketing Cloud Next needs them and delegates to the core `sf` CLI where Salesforce CLI already provides the transport. It does **not** claim complete Marketing Cloud Next migration support.

Installing this plugin also installs the compatible CMS plugin (`sf-plugin-cms`); you do not need a separate CMS install step.

- [Install and sign in](#installation-and-getting-started)
- [Export segment members](#export-segment-members)
- [Command reference](#command-reference)
- [Safety and limitations](#safety-and-limitations)

## Installation and getting started

### Prerequisites

- Node.js `22.19.0` or later.
- The base Salesforce `sf` CLI.
- An authorized Salesforce org with the Marketing Cloud Next or Data 360 features required by the command you run.

```bash
npm install --global @salesforce/cli
sf --version
```

### Authenticate an org

```bash
sf org login web --alias my-mcnext-org
sf org display --target-org my-mcnext-org
```

For a sandbox or custom login host, add `--instance-url` to `sf org login web`.

Normal Salesforce CLI org authorization covers `segment members export` and every other org-backed command in this plugin. You do not need a separate Connected App for `--include-details`. Only `sf mcnext data-graph metadata` uses an externally obtained Data 360 token and tenant URL.

### Install the plugin

```bash
sf plugins install sf-plugin-mcnext
sf mcnext list types
```

If Salesforce CLI asks whether you trust this unsigned plugin, check the package name before confirming. The hidden `mcn` topic is a short alias for `mcnext`; this README uses canonical `mcnext` names. Run `sf mcnext <command> --help` for current flags.

## Export segment members

A practical first workflow: export members of one segment you can see in the Marketing Cloud Next UI.

### Choose the segment

In the UI, copy the segment **display name**, or open the segment and copy its **Id** from the browser URL. Prefer those over the API/developer name — that name is usually hard to find in the GUI. `--segment` also accepts the API name when you already have it.

### Basic export

Omit `--output-file` to write under `./data/<dataspace-name>/<segmentname>-<datetime>.csv` (not the current working directory alone). With `--result-format json`, the default destination is `./data/<dataspace-name>/<segmentname>-<datetime>.json`. An explicit `--output-file` overrides that default.

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment "Annual Promo"
```

Or by Id, with a chosen path:

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment 1sg000000000001AAA --output-file members.csv
```

### Enriched details

Add `--include-details` for a richer Unified Individual–style export. The command then uses the segment’s own data space automatically (that same data space also shapes the default `./data/<dataspace-name>/…` path). Pass `--data-space` only when you need to override that choice.

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment "Annual Promo" --include-details
```

### When the display name is ambiguous

If the same display name exists in more than one business unit or data space, either:

- pass `--data-space` with the correct data space name, or
- pass the segment **Id** instead of the display name, or
- in an interactive terminal (TTY), answer the prompt that lists matching candidates.

Without a TTY, or with `--json`, the command is non-interactive: it prints the candidate list with each segment’s Id and data space and exits nonzero so you can re-run with an Id or `--data-space`.

## Demo project

The [demo project](test/demo-project) is an imaginary result of retrieve-all, not import-ready source. Its [artifact inventory](test/fixtures/demo-project/inventory.json) and [marketing-type coverage](test/fixtures/demo-project/marketing-type-coverage.json) distinguish existing formats from proposed layouts and unresolved providers.

## Command reference

| Command                                | Details                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `sf mcnext list types`                 | [List capability types](#sf-mcnext-list-types)                                |
| `sf mcnext retrieve all`               | [Bounded project retrieve](#sf-mcnext-retrieve-all)                           |
| `sf mcnext segment members export`     | [Export segment members](#sf-mcnext-segment-members-export)                   |
| `sf mcnext segment records export`     | [Export MarketSegment records](#sf-mcnext-segment-records-export)             |
| `sf mcnext segment definition create`  | [Create a segment definition](#sf-mcnext-segment-definition-create)           |
| `sf mcnext identity-resolution list`   | [List identity-resolution rulesets](#sf-mcnext-identity-resolution-list)      |
| `sf mcnext identity-resolution show`   | [Show one ruleset](#sf-mcnext-identity-resolution-show)                       |
| `sf mcnext identity-resolution export` | [Export one ruleset](#sf-mcnext-identity-resolution-export)                   |
| `sf mcnext identity-resolution plan`   | [Plan identity-resolution create/update](#sf-mcnext-identity-resolution-plan) |
| `sf mcnext email send-definition show` | [Show a ListEmail record](#sf-mcnext-email-send-definition-show)              |
| `sf mcnext email-template show`        | [Show a CMS email template](#sf-mcnext-email-template-show)                   |
| `sf mcnext data-graph metadata`        | [Read Data Graph metadata](#sf-mcnext-data-graph-metadata)                    |
| `sf mcnext flow source`                | [Retrieve or mutate Flow source](#sf-mcnext-flow-source)                      |
| `sf mcnext flow association`           | [Plan or attach Flow to Campaign](#sf-mcnext-flow-association)                |
| `sf mcnext campaign config`            | [Export or mutate Campaign config](#sf-mcnext-campaign-config)                |
| `sf mcnext migration plan`             | [Write a migration assessment](#sf-mcnext-migration-plan)                     |
| `sf mcnext migration cms`              | [Run bounded CMS migration steps](#sf-mcnext-migration-cms)                   |

Use `sf mcnext <command> --help` for the full flag list. Most org-backed commands take `--target-org` / `-o`. Add `--json` for machine-readable output.

## `sf mcnext list types`

Lists capability ownership, support state, and limitations without contacting an org.

```bash
sf mcnext list types --provider core-sf
```

## `sf mcnext retrieve all`

Downloads bounded best-available working files into one existing Salesforce DX project. This is not a full backup or restore kit; results report `complete:false`.

```bash
sf mcnext retrieve all --target-org my-mcnext-org --expected-org-id 00D000000000001AAA --project-dir ./project --api-version 67.0 --wait 10 --json
```

## `sf mcnext segment members export`

Resolves one segment and exports computed member rows. Prefer the **display name** or **Id** from the UI; the API name is also accepted. Without `--output-file`, the CSV lands at `./data/<dataspace-name>/<segmentname>-<datetime>.csv`; `--result-format json` uses `./data/<dataspace-name>/<segmentname>-<datetime>.json`. See [Export segment members](#export-segment-members) for enriched mode, data-space defaults, and ambiguity handling.

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment "Annual Promo"
```

## `sf mcnext segment records export`

Delegates a `MarketSegment` bulk export to core `sf data export bulk`.

```bash
sf mcnext segment records export --target-org my-mcnext-org --output-file segments.csv
```

## `sf mcnext segment definition create`

Strictly creates one mapped `MarketSegmentDefinition`. Use `--dry-run` before applying.

```bash
sf mcnext segment definition create --source-org source-mcn --target-org target-mcn --expected-source-org-id 00D000000000001AAA --expected-target-org-id 00D000000000002AAA --project-dir ./project --source-file force-app/main/default/marketSegmentDefinitions/FreshSegment.marketSegmentDefinition-meta.xml --member FreshSegment --mapping-file mappings/segment.json --dry-run
```

## `sf mcnext identity-resolution list`

Lists identity-resolution ruleset configurations. It does not export unified-profile rows.

```bash
sf mcnext identity-resolution list --target-org my-mcnext-org --api-version 67.0
```

## `sf mcnext identity-resolution show`

Retrieves one ruleset configuration by Salesforce ruleset ID.

```bash
sf mcnext identity-resolution show --target-org my-mcnext-org --ruleset-id 1ir000000000001AAA --api-version 67.0
```

## `sf mcnext identity-resolution export`

Writes one complete ruleset configuration as JSON.

```bash
sf mcnext identity-resolution export --target-org my-mcnext-org --ruleset-id 1ir000000000001AAA --output-file identity-resolution.json --api-version 67.0
```

## `sf mcnext identity-resolution plan`

Builds a GET-only CREATE plan or UPDATE shell. It never sends a mutation request.

```bash
sf mcnext identity-resolution plan --intent create --source-org source-mcn --target-org target-mcn --expected-source-org-id 00D000000000001AAA --expected-target-org-id 00D000000000002AAA --input-file identity-resolution-plan.json --api-version 67.0
```

## `sf mcnext email send-definition show`

Reads one `ListEmail` record through core `sf data get record`. It does not publish or send email.

```bash
sf mcnext email send-definition show --target-org my-mcnext-org --record-id 0XB000000000001AAA --api-version 67.0
```

## `sf mcnext email-template show`

Reads one CMS email template by managed content ID.

```bash
sf mcnext email-template show --target-org my-mcnext-org --content-id 20Y000000000001AAA --api-version 67.0
```

## `sf mcnext data-graph metadata`

Performs one read-only Data Graph metadata GET. Supply a tenant URL and a private access-token file obtained outside this plugin.

```bash
sf mcnext data-graph metadata --instance-url https://example.c360a.salesforce.com --access-token-file "C:\private\data360-token.txt"
```

## `sf mcnext flow source`

Retrieves or validates selected Flow source, or creates/updates one inactive same-org draft. It does not activate, execute, or send.

```bash
sf mcnext flow source --operation retrieve --member MyFlow --target-org my-mcnext-org --project-dir ./project
```

## `sf mcnext flow association`

Plans or attaches one existing inactive Segment-triggered Flow to an inactive Campaign. This is a bounded attachment write, not Flow creation or activation.

```bash
sf mcnext flow association --operation plan --target-org target-mcn --expected-org-id 00D000000000002AAA --api-version 67.0 --project-dir ./project --input-file association-input.json --json
```

## `sf mcnext campaign config`

Exports a describe-driven Campaign snapshot, or performs a bounded create/update with a separate mutation-shaped input file.

```bash
sf mcnext campaign config --operation export --target-org target-mcn --expected-org-id 00D000000000002AAA --api-version 67.0 --project-dir . --record-id 701000000000001AAA --output-file campaign.json
```

## `sf mcnext migration plan`

Writes a deterministic, read-only source-to-target assessment. It does not deploy or mutate either org.

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json
```

## `sf mcnext migration cms`

Experimental bounded CMS execution for independently ready selected routes. Dry-run is the default; `--apply` runs only after preflight succeeds.

```bash
sf mcnext migration cms --target-org target-mcn --expected-target-org-id 00D000000000002AAA --plan-file migration-plan.json --result-file cms-result.json --report-root .mcnext-runs/cms-reports --allow-experimental-cms
```

## Safety and limitations

- Planning and discovery do not authorize mutation. Check each command’s help before any write.
- Read-only commands can still write local export, plan, or result files.
- Core CLI delegation means core `sf` owns underlying jobs, errors, and transport for delegated commands.
- Segment member IDs are opaque membership values, not asserted CRM record IDs.
- Identity Resolution support covers configuration and planning, not unified-profile row migration.
- Email commands are exact reads; the plugin does not publish or send email.
- Data Graph support is metadata GET only; token exchange and graph mutation remain external.
- The plugin does not provide complete dependency discovery, automatic reference rewriting, rollback, or end-to-end migration for all Marketing Cloud Next capabilities.

## License

MIT
