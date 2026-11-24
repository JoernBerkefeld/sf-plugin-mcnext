# sf-plugin-mcnext

Salesforce CLI plugin for Marketing Cloud Next. It retrieves, deploys and deletes campaigns and flows, and it runs one retrieve, deploy or delete across campaigns, flows, CMS content and Data 360 components by handing the CMS and Data 360 parts to `sf-plugin-cms` and `sf-plugin-data`.

Installing this plugin also installs the compatible CMS plugin (`sf-plugin-cms`); you do not need a separate CMS install step.

- [Install and sign in](#installation-and-getting-started)
- [Command reference](#command-reference)
- [Files in the project folder](#files-in-the-project-folder)
- [Exit codes](#exit-codes)
- [Not available yet](#not-available-yet)

## Installation and getting started

### Prerequisites

- Node.js `22.22.2` or later on the 22 line, or `24.15.0` or later on the 24 line.
- The base Salesforce `sf` CLI.
- An authorized Salesforce org with Marketing Cloud Next.

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

### Install the plugin

```bash
sf plugins install sf-plugin-mcnext
sf mcnext --help
```

If Salesforce CLI asks whether you trust this unsigned plugin, check the package name before confirming.

### First steps

```bash
sf mcnext list business-unit --target-org my-mcnext-org
sf mcnext retrieve --target-org my-mcnext-org --business-unit defaultBusinessUnit
```

The first command shows the business units of the org. The second writes everything of one business unit into the current folder. In an org that does not use business units, run `sf mcnext retrieve --target-org my-mcnext-org` for the campaigns and flows.

## Command reference

Use `sf mcnext <command> --help` for the full flag list. Every command takes `--target-org` / `-o`. Add `--json` for machine-readable output; its top-level `status` is the exit code.

| Command                        | What it does                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| `sf mcnext list business-unit` | Lists the business units with their data space and CMS workspaces |
| `sf mcnext retrieve`           | Retrieves campaigns and flows, or everything of one business unit |
| `sf mcnext deploy`             | Deploys CMS content, campaigns and flows in one run               |
| `sf mcnext delete`             | Deletes flows, campaigns and CMS content in one run               |

Components are named with `--metadata` / `-m` as `type:Name`:

- `campaign` and `flow` are handled by this plugin. A campaign is named by its name, a flow by its API name.
  - In an org with business units, a campaign name stands for one campaign per business unit, plus one campaign without a business unit. Two business units can each have a campaign called `Spring`.
  - In an org without business units, the name alone identifies the campaign.
- `dlo`, `dmo`, `mapping`, `relationship`, `data-stream`, `data-transform`, `data-graph`, `segment`, `identity-resolution` and `calculated-insight` are Data 360 types.
- Every other type, such as `email`, is a CMS type.

`sf mcnext deploy` and `sf mcnext delete` also take `--source-dir` / `-d` with a file or folder below `cms/` or `mcnext/`.

## `sf mcnext list business-unit`

Shows each business unit with its developer name, label, data space and the API names of its CMS workspaces.

```bash
sf mcnext list business-unit --target-org my-mcnext-org
sf mcnext list business-unit --target-org my-mcnext-org --json
```

In an org that does not use business units, the one business unit is listed with its data space, the workspaces are not available per business unit, and a warning says so.

## `sf mcnext retrieve`

- Without `--metadata` and without `--business-unit`: every campaign and every marketing flow of the org.
- With `--business-unit`: the campaigns of that business unit, the flows and the Data 360 components of its data space, and the content of its CMS workspaces. Nothing of other data spaces or workspaces. A flow named with `--metadata` that exists in another data space is reported as failed (`FLOW_OTHER_DATASPACE`).
- With `--metadata`: only the named components. A Data 360 component is read from `--dataspace` (default: `default`). A CMS component needs `--workspace` or `--business-unit`.
- A campaign of a business unit is written to `mcnext/campaigns/<business unit>/`, a campaign without a business unit to `mcnext/campaigns/`. `--metadata campaign:Spring` retrieves every campaign of that name, each into its own folder.
- `--output-dir` names the project folder; the default is the current folder.
- Existing files are replaced. Use Git to see what changed.

```bash
sf mcnext retrieve --target-org my-mcnext-org
sf mcnext retrieve --target-org my-mcnext-org --business-unit defaultBusinessUnit --output-dir my-project
sf mcnext retrieve --target-org my-mcnext-org --metadata campaign:Spring --metadata flow:Welcome_Flow
sf mcnext retrieve --target-org my-mcnext-org --metadata segment:My_Segment --dataspace default
sf mcnext retrieve --target-org my-mcnext-org --metadata email:Welcome --workspace Default_Content_Workspace
```

## `sf mcnext deploy`

Deploys from the current folder in this order: CMS content, campaigns, flows, and for each flow its link to a campaign.

- Every component is checked before anything is written. If one is blocked, nothing is written.
- A flow needs its emails, its campaign and its segment in the org. Content and campaigns of the same run count.
- `--preview` stops after the check and shows what would happen.
- The run stops at the first component that fails. Components after it are reported as `not-attempted`.
- A flow file whose status is `Active` is refused without `--allow-activation`, because deploying it starts the flow.
- A CMS component goes to the workspace of its `cms/<workspace>/` folder, or to `--workspace`.
- A bare `campaign` or `flow` means every file of that type in the project folder.
- A campaign file is deployed to the business unit it names, and to no business unit when it names none. The campaign of that name is looked up there only: it is updated when it exists and created when it does not. A campaign of the same name elsewhere is left alone.
- `--metadata campaign:Spring` selects every file of that name: the one in `mcnext/campaigns/` and the ones in the business unit folders. Use `--source-dir` with a file to deploy just one.
- A campaign file whose folder and `businessUnit` disagree is blocked (`CAMPAIGN_FILE_INVALID`).
- A parent campaign is looked up in the campaign's own business unit first. If none is there, the one campaign of that name in the org is used.
- A flow is attached to the campaign of its name in the business unit that owns the flow's data space. If none is there, the campaign of that name without a business unit is used. A campaign of another business unit is never used.

```bash
sf mcnext deploy --target-org my-mcnext-org --source-dir mcnext --metadata email:Welcome --preview
sf mcnext deploy --target-org my-mcnext-org --metadata email:Welcome --metadata campaign:Spring --metadata flow:Welcome_Flow
```

Copy into another business unit with `--business-unit`: campaigns get that business unit, flows get its data space, its segment and its CMS workspace, and CMS content goes to its workspace. A copied campaign keeps its name and becomes a new campaign in the target business unit; the original stays as it is. Run the same command again to update the copy. If the business unit has several workspaces and none is named like the source workspace, name one with `--workspace`. `--allow-cross-dataspace` lets CMS content that uses another data space be renamed into the target data space.

```bash
sf mcnext deploy --target-org my-mcnext-org --metadata campaign:Spring --metadata flow:Welcome_Flow --metadata email:Welcome --business-unit otherBusinessUnit --allow-cross-dataspace
```

## `sf mcnext delete`

Deletes in this order: flows, campaigns, CMS content.

- Needs `--confirm-delete`. Without it, only `--preview` runs, and it deletes nothing.
- Every component is checked before anything is deleted. If one is blocked, nothing is deleted.
- A flow with an active version is blocked. Deactivate it in Salesforce first.
- A name that several records share is blocked.
- `--metadata campaign:Spring` deletes the campaign of the business unit that the local file of that name belongs to.
  - Several local files of that name: the delete is blocked (`CAMPAIGN_NAME_AMBIGUOUS`). Select the file with `--source-dir`.
  - No local file and exactly one campaign of that name in the org: that campaign is deleted, whatever its business unit.
  - No local file and several campaigns of that name in the org: the delete is blocked (`CAMPAIGN_NAME_AMBIGUOUS`). Retrieve the campaigns first, then select the file of the one to delete with `--source-dir`.
  - A local file whose `name` is not the name given: the delete is blocked (`CAMPAIGN_FILE_INVALID`).
- `--source-dir` with a campaign file deletes the campaign of that file's business unit.
- The run stops at the first component that fails, is blocked or gets no answer. Components after it are reported as `not-attempted`.
- Local files are removed only for a component that Salesforce confirmed as `deleted`:
  - A component named with `--source-dir`: the file it was read from. For a flow, its `.flow.json` next to it as well.
  - A campaign or flow named with `--metadata`: its own file below `mcnext/campaigns/` or in `mcnext/flows/`.
  - A component that the org does not have (`unchanged`), a blocked or failed one, and every component of a `--preview` keep their files.
  - `--keep-local-files` keeps all files.

```bash
sf mcnext delete --target-org my-mcnext-org --metadata flow:Welcome_Flow --metadata campaign:Spring --preview
sf mcnext delete --target-org my-mcnext-org --metadata flow:Welcome_Flow --metadata campaign:Spring --confirm-delete
sf mcnext delete --target-org my-mcnext-org --metadata email:Welcome --workspace Default_Content_Workspace --confirm-delete --keep-local-files
```

## Files in the project folder

```text
mcnext/
  campaigns/
    <Name>.campaign.json        one campaign without a business unit: its fields, and parent and brief by name
    <BusinessUnit>/
      <Name>.campaign.json      one campaign of that business unit; the file names the business unit as well
  flows/
    <ApiName>.flow-meta.xml     the flow; its segment is written as API name
    <ApiName>.flow.json         the campaign the flow belongs to, and what the flow needs
cms/
  <workspace>/<type>/           CMS content, written and read by sf-plugin-cms
data360/                        Data 360 components, written by sf-plugin-data
```

`<BusinessUnit>` is the developer name of the business unit. The `businessUnit` inside a campaign file decides where the campaign goes; the folder has to match it. In an org without business units all campaign files are in `mcnext/campaigns/`.

No record IDs of the org are stored in the campaign and flow files, so the same files deploy to another org.

## Exit codes

| Code | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| 0    | Every selected component succeeded or was unchanged                              |
| 1    | Something failed, was blocked or has an unknown outcome, and nothing was written |
| 68   | At least one component was written and at least one other failed                 |
| 69   | Nothing failed, but Salesforce is still working on a component                   |

With `--json`, `status` holds the same number, `items` lists every component with its outcome, and `areas` holds the unchanged results of `sf-plugin-data` and `sf-plugin-cms` (`areas.cms` is a list with one result per workspace).

## Not available yet

- Data 360 components in `sf mcnext deploy` and `sf mcnext delete`. Use `sf data360 deploy` and `sf data360 delete` from [sf-plugin-data](https://www.npmjs.com/package/sf-plugin-data) for them; a run that names one is refused before anything is written.
- Publish and unpublish. Use `sf cms publish` and `sf cms unpublish` for CMS content.
- `--changed-since`, to deploy only what changed since a Git commit.

## License

MIT
