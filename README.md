# sf-plugin-mcnext

Salesforce CLI plugin for people who need to inspect, export, validate, or carefully move selected Marketing Cloud Next configuration and data.

The plugin adds commands where Marketing Cloud Next needs a dedicated workflow and delegates to the core `sf` CLI where Salesforce CLI already provides the transport. It does not claim complete Marketing Cloud Next migration support.

## Prerequisites

- Node.js `22.19.0` or later.
- The current Salesforce CLI.
- An authorized Salesforce org with the Marketing Cloud Next or Data 360 features and permissions required by the command you run.

Install or update the Salesforce CLI:

```bash
npm install --global @salesforce/cli
sf --version
```

## Install or update the plugin

Install the current npm release:

```bash
sf plugins install sf-plugin-mcnext
sf plugins
```

Update installed Salesforce CLI plugins:

```bash
sf plugins update
```

The current npm release is `0.6.0` and includes all 15 commands described below, including the experimental bounded CMS migration executor.

The separate [`sf-plugin-cms`](https://github.com/JoernBerkefeld/sf-plugin-cms) provider is optional. Install it only for CMS-aware migration planning or the experimental CMS execution workflow:

```bash
sf plugins install sf-plugin-cms@0.4.0
sf plugins inspect sf-plugin-cms --json
sf cms info --contract-version 1 --json
```

`sf-plugin-cms` `0.4.0` is the minimum supported version, but the advertised contract and capabilities must also be compatible. This plugin never installs, upgrades, downgrades, or repairs the CMS provider.

## Quick start

Authorize an org and confirm the alias:

```bash
sf org login web --alias my-mcnext-org --instance-url https://login.salesforce.com
sf org display --target-org my-mcnext-org
```

Use your My Domain or the correct Salesforce login URL when required.

Discover the available capabilities without connecting to an org:

```bash
sf mcnext list types
sf mcnext --help
```

Inspect complete flags and examples for any command:

```bash
sf mcnext segment members export --help
```

Start with a bounded, read-only export:

```bash
sf mcnext segment members export \
  --target-org my-mcnext-org \
  --segment My_Published_Segment \
  --output-file members.csv \
  --max-items 100
```

The hidden `mcn` topic is a short alias for `mcnext`; this README uses `mcnext` throughout.

## Command guide

The npm `0.6.0` release exposes 15 commands.

| Command                                                                       | Availability                            | Behavior                                                         | Purpose                                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`sf mcnext list types`](#command-list-types)                                 | npm `0.6.0`                             | Read-only                                                        | Show capability ownership, support state, operations, and delegation targets.  |
| [`sf mcnext segment members export`](#command-segment-members-export)         | npm `0.6.0`                             | Read-only; writes a local file                                   | Export computed segment members to bounded CSV or JSON output.                 |
| [`sf mcnext segment records export`](#command-segment-records-export)         | npm `0.6.0`                             | Read-only; writes a local file                                   | Export `MarketSegment` records through core `sf data export bulk`.             |
| [`sf mcnext identity-resolution list`](#command-identity-resolution-list)     | npm `0.6.0`                             | Read-only                                                        | List identity-resolution ruleset configurations and aggregate status.          |
| [`sf mcnext identity-resolution show`](#command-identity-resolution-show)     | npm `0.6.0`                             | Read-only                                                        | Retrieve one ruleset configuration by exact ID.                                |
| [`sf mcnext identity-resolution export`](#command-identity-resolution-export) | npm `0.6.0`                             | Read-only; writes a local file                                   | Export one ruleset configuration as JSON.                                      |
| [`sf mcnext email send-definition show`](#command-email-send-definition-show) | npm `0.6.0`                             | Read-only                                                        | Read one exact `ListEmail` send-definition record through core Salesforce CLI. |
| [`sf mcnext email-template show`](#command-email-template-show)               | npm `0.6.0`                             | Read-only                                                        | Read one CMS email template by managed content ID.                             |
| [`sf mcnext data-graph metadata`](#command-data-graph-metadata)               | npm `0.6.0`                             | Read-only                                                        | Retrieve accessible Data 360 Data Graph metadata with an external token.       |
| [`sf mcnext identity-resolution plan`](#command-identity-resolution-plan)     | npm `0.6.0`                             | Read-only; writes plan output with `--json` or shell redirection | Build a conflict-checked CREATE plan or exact UPDATE shell without mutation.   |
| [`sf mcnext flow source`](#command-flow-source)                               | npm `0.6.0`                             | Read-only or mutating, selected by `--operation`                 | Retrieve, validate, create, or update one selected Flow source.                |
| [`sf mcnext migration plan`](#command-migration-plan)                         | npm `0.6.0`                             | Read-only; writes a local plan                                   | Assess source-to-target prerequisites, ownership, transport, and dependencies. |
| [`sf mcnext segment definition create`](#command-segment-definition-create)   | npm `0.6.0`                             | Mutating unless `--dry-run`                                      | Validate and create one explicitly mapped segment definition.                  |
| [`sf mcnext campaign config`](#command-campaign-config)                       | npm `0.6.0`                             | Read-only or mutating, selected by `--operation`                 | Export, create, or update a bounded Campaign configuration.                    |
| [`sf mcnext migration cms`](#command-migration-cms)                           | npm `0.6.0`                             | Dry-run by default; mutating with `--apply`                      | Preflight or execute bounded CMS routes through `sf-plugin-cms`.               |

Every command supports command-level help. Run `sf <command> --help`, for example `sf mcnext migration plan --help`, before using unfamiliar flags or any mutating operation.

### Discover capabilities

<a id="command-list-types"></a>

#### `sf mcnext list types`

Lists each known capability, its owner, support state, operations, delegation target, and limitations. It does not access an org. Use `--provider` or `--state` to filter the output; run `sf mcnext list types --help` for all options.

```bash
sf mcnext list types
sf mcnext list types --provider core-sf
sf mcnext list types --state conditional
```

A listed capability is not necessarily implemented by this plugin:

- `implemented`: the plugin exposes the listed operation.
- `delegated`: use the indicated core `sf` command or transport.
- `conditional`: evidence exists, but safe portable behavior is not fully established.
- `deferred`: intentionally unsupported.

### Read and export data

These commands are read-only with respect to Salesforce orgs. Commands that accept `--output-file` write local files.

<a id="command-segment-members-export"></a>

#### `sf mcnext segment members export`

Read-only against the org; writes computed members to the required `--output-file`. Select the segment with `--segment`, choose CSV or JSON with `--result-format`, and bound paging with `--max-pages`, `--max-items`, or `--max-duration-ms`. Run `sf mcnext segment members export --help` for filtering, ordering, and delimiter flags.

<a id="command-segment-records-export"></a>

#### `sf mcnext segment records export`

Read-only against the org; delegates a `MarketSegment` bulk export to core Salesforce CLI and writes the required `--output-file`. The primary flags are `--target-org`, `--result-format`, `--wait`, and optional core export settings. Run `sf mcnext segment records export --help` for the complete delegated usage.

<a id="command-identity-resolution-list"></a>

#### `sf mcnext identity-resolution list`

Read-only. Lists ruleset configuration and aggregate status for `--target-org`; `--api-version` is optional and limited to the supported baseline. Run `sf mcnext identity-resolution list --help` for complete usage.

<a id="command-identity-resolution-show"></a>

#### `sf mcnext identity-resolution show`

Read-only. Retrieves one ruleset configuration selected by required `--ruleset-id` from `--target-org`. Run `sf mcnext identity-resolution show --help` for complete usage.

<a id="command-identity-resolution-export"></a>

#### `sf mcnext identity-resolution export`

Read-only against the org; writes one complete ruleset configuration to the required `--output-file`. Select it with `--ruleset-id` and `--target-org`. Run `sf mcnext identity-resolution export --help` for complete usage.

<a id="command-email-send-definition-show"></a>

#### `sf mcnext email send-definition show`

Read-only. Retrieves one exact `ListEmail` record through core Salesforce CLI using `--target-org` and `--record-id`; it does not publish or send email. Run `sf mcnext email send-definition show --help` for complete usage.

<a id="command-email-template-show"></a>

#### `sf mcnext email-template show`

Read-only. Retrieves one CMS email template by exact `--content-id` from `--target-org` and verifies its content type. Run `sf mcnext email-template show --help` for complete usage.

<a id="command-data-graph-metadata"></a>

#### `sf mcnext data-graph metadata`

Read-only. Performs one metadata GET against `--instance-url` using the bearer token stored in `--access-token-file`; it does not obtain or persist tokens. Run `sf mcnext data-graph metadata --help` for complete usage.

Examples:

```bash
sf mcnext segment records export \
  --target-org my-mcnext-org \
  --output-file segments.csv

sf mcnext identity-resolution export \
  --target-org my-mcnext-org \
  --ruleset-id 1ir000000000001AAA \
  --output-file identity-resolution.json

sf mcnext email-template show \
  --target-org my-mcnext-org \
  --content-id 20Y000000000001AAA \
  --api-version 67.0
```

For Data Graph metadata, obtain the Data 360 token outside this plugin and keep the token file outside the repository:

```bash
sf mcnext data-graph metadata \
  --instance-url https://example.c360a.salesforce.com \
  --access-token-file C:\private\data360-token.txt
```

The command does not perform JWT or Data 360 token exchange. For a new setup, use a Salesforce External Client App with only the scopes and user access required by your organization. Never commit client secrets, private keys, assertions, or access tokens.

### Validate and plan without mutation

<a id="command-identity-resolution-plan"></a>

#### `sf mcnext identity-resolution plan`

Builds a conflict-checked CREATE plan or exact UPDATE shell using read-only target discovery. It never sends `POST` or `PATCH` requests and does not produce an executable mutation payload. Select the mode with `--intent`, bind both orgs and expected org IDs, and provide `--input-file`; run `sf mcnext identity-resolution plan --help` for update-shell safeguards.

```bash
sf mcnext identity-resolution plan \
  --intent create \
  --source-org source-mcn \
  --target-org target-mcn \
  --expected-source-org-id 00D000000000001AAA \
  --expected-target-org-id 00D000000000002AAA \
  --input-file identity-resolution-plan.json \
  --api-version 67.0
```

<a id="command-flow-source"></a>

#### `sf mcnext flow source`

Use `--operation retrieve|validate` for read-only retrieval or check-only validation. Use `--operation create|update` for the bounded mutating workflow described below. Primary flags for read-only use are `--member`, `--target-org`, and `--project-dir`; run `sf mcnext flow source --help` before selecting an operation.

Retrieves selected Flow source or validates it through a core check-only deployment. `validate` does not apply a deployment.

```bash
sf mcnext flow source \
  --operation validate \
  --member MyFlow \
  --target-org target-mcn \
  --project-dir ./project
```

<a id="command-migration-plan"></a>

#### `sf mcnext migration plan`

Writes the required `--output-file` as a deterministic, read-only source-to-target assessment. The primary inputs are `--source-org` and `--target-org`; run `sf mcnext migration plan --help` before adding optional CMS evidence or planning flags. It checks prerequisites and records capability ownership, support, transport, and dependency evidence. It never deploys, imports, rewrites references, creates target payloads, or mutates either org.

Basic assessment:

```bash
sf mcnext migration plan \
  --source-org source-mcn \
  --target-org target-mcn \
  --output-file migration-plan.json
```

Add CMS planning with a separately installed compatible CMS provider:

```bash
sf mcnext migration plan \
  --source-org source-mcn \
  --target-org target-mcn \
  --output-file migration-plan.json \
  --cms-plan \
  --cms-workspace-map cms-workspaces.json \
  --cms-export-dir .mcnext-runs/cms-export
```

`--cms-plan`, `--cms-workspace-map`, and `--cms-export-dir` must be used together. The workspace map must explicitly map canonical source workspace IDs to target workspace IDs; names are not routing keys.

CMS planning runs one read-only aggregate Marketing workspace export and validates provider contracts, package integrity, provenance, correlations, and routes. Even valid package and route evidence can remain `ownership-uncertain`; the plan does not claim that a CMS route is safe to execute unless all required evidence exists.

### Create or update configuration

The following commands can mutate an org. Read `sf <command> --help`, verify every org ID and file, and use validation or dry-run behavior first where available.

<a id="command-segment-definition-create"></a>

#### `sf mcnext segment definition create`

This is a mutating strict-CREATE command unless `--dry-run` is supplied. It requires explicit source and target org bindings, a selected metadata file, member name, and mapping file; run `sf mcnext segment definition create --help` and validate with `--dry-run` before apply.

```bash
sf mcnext segment definition create \
  --source-org source-mcn \
  --target-org target-mcn \
  --expected-source-org-id 00D000000000001AAA \
  --expected-target-org-id 00D000000000002AAA \
  --project-dir ./project \
  --source-file force-app/main/default/marketSegmentDefinitions/FreshSegment.marketSegmentDefinition-meta.xml \
  --member FreshSegment \
  --mapping-file mappings/segment.json \
  --dry-run
```

`--dry-run` performs core check-only validation and stops before apply. Without it, the command rechecks org identities and target absence, applies once, retrieves the result independently, and performs bounded read-only correlation checks. A `pending` result exits with code `69`; investigate it instead of rerunning CREATE. UPDATE, upsert, publication, scheduling, and membership execution are not supported.

#### Flow source CREATE or UPDATE

`sf mcnext flow source --operation create|update` is the mutating mode of the [Flow source command](#command-flow-source). It transports one inactive same-org Flow draft through core Metadata API operations. Both operations require exactly one `--member`, plus `--source-file`, `--expected-org-id`, `--source-org-id`, and `--reuse-same-org-references`. The source and destination org IDs must match; cross-org reference mapping is unsupported.

```bash
sf mcnext flow source \
  --operation create \
  --member MyFlow \
  --target-org target-mcn \
  --project-dir ./project \
  --source-file force-app/main/default/flows/MyFlow.flow-meta.xml \
  --expected-org-id 00D000000000002AAA \
  --source-org-id 00D000000000002AAA \
  --reuse-same-org-references
```

UPDATE additionally requires `--expected-definition-id` and `--expected-latest-version-id`. A normal update may change only the top-level Flow `label` or `interviewLabel`; an exact unchanged repeat requires `--expect-unchanged`. Activation, execution, sending, and publication are unsupported. A pending core job is not success; inspect it before retrying.

<a id="command-campaign-config"></a>

#### `sf mcnext campaign config`

Select read-only export or mutating create/update with required `--operation`. The command also requires explicit org identity, API version, and project directory; operation-specific flags select the record, input/output file, target name, or journal. Run `sf mcnext campaign config --help` before create or update.

It supports only these Campaign fields: `Name`, `Type`, `Status`, `IsActive`, and `Description`.

```bash
sf mcnext campaign config \
  --operation create \
  --target-org target-mcn \
  --expected-org-id 00D000000000002AAA \
  --api-version 67.0 \
  --project-dir . \
  --input-file campaign.json \
  --target-name "New campaign" \
  --journal-file campaign-created.json
```

CREATE writes a private pending journal before mutation. UPDATE requires the exact record ID and expected current name and cannot rename or upsert. Relationships, custom fields, null clearing, and lifecycle operations are unsupported. Reconcile ambiguous writes manually; do not retry blindly.

<a id="command-migration-cms"></a>

## `sf mcnext migration cms` — experimental bounded execution

Dry-run is the default; `--apply` enables mutation only after every selected route passes preflight and dry-run. Required inputs bind the target org, migration `--plan-file`, new `--result-file`, and `--report-root`; `--allow-experimental-cms` is always required. Run `sf mcnext migration cms --help` before use.

The command consumes CMS package and workspace-route evidence from `sf mcnext migration plan` and calls the separately installed `sf-plugin-cms` public CLI contract. The executor checks successful provider export/package evidence, but it does not require the plan to classify a route as `ready-for-execution`; an `ownership-uncertain` route can therefore reach dry-run.

Inspect the complete command contract:

```bash
sf mcnext migration cms --help
```

Dry-run every selected route:

```bash
sf mcnext migration cms \
  --target-org target-mcn \
  --expected-target-org-id 00D000000000001AAA \
  --plan-file migration-plan.json \
  --result-file cms-execution-result.json \
  --report-root .mcnext-runs/cms-reports \
  --allow-experimental-cms
```

The command requires `--allow-experimental-cms` even for dry-run. It writes a separate result file and never modifies the migration plan.

Do not add `--apply` when the plan still marks any route `ownership-uncertain`; a successful provider dry-run does not resolve the missing Marketing Cloud Next ownership or dependency evidence. Apply is appropriate only after that evidence has been independently resolved and the dry-run result has been reviewed.

Before mutation, all selected routes must pass preflight. Apply runs routes sequentially by source workspace ID, revalidates the target org, provider, plan fingerprint, package paths, and manifest hashes, and repeats route preflight immediately before each mutation. It stops on the first non-success result and does not retry or roll back. The plugin does not inspect CMS payloads, infer dependencies, or rewrite CMS-owned references.

## Safety and limitations

- Direct Marketing Cloud Next API commands use the verified API `67.0` baseline unless a delegated core command accepts another version.
- Read-only commands can still write local export, plan, evidence, or result files.
- Planning and discovery do not authorize mutation. Check the command's documented operations and flags.
- Core CLI delegation means core `sf` owns the underlying job behavior, errors, and supported metadata or data transport.
- Segment member IDs are opaque SSOT membership values, not asserted Salesforce CRM record IDs.
- Identity Resolution support covers configuration and planning, not unified-profile row migration or mutation.
- Email commands are exact read operations; the plugin does not publish or send email.
- Data Graph support is metadata GET only; token exchange and graph mutation remain external.
- CMS support depends on a separately installed compatible provider and remains experimental for local execution.
- This plugin does not provide complete dependency discovery, automatic reference rewriting, rollback, or end-to-end migration for all Marketing Cloud Next capabilities.

## Development

Use local development only when contributing or testing unreleased commands:

```bash
npm install --no-workspaces
npm run compile
npm run lint
npm test
sf plugins link .
```

Run `sf mcnext --help` and command-level help after linking. Live org tests require explicit private environment variables; never commit org IDs, aliases, keys, tokens, or test data.

## License

MIT
