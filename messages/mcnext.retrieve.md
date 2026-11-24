# summary

Retrieve campaigns and flows, or everything of one business unit.

# description

Without --metadata and without --business-unit, every campaign and every marketing flow of the org is written to mcnext/campaigns and mcnext/flows in the project folder. A campaign of a business unit goes into mcnext/campaigns/<business unit>, a campaign without one directly into mcnext/campaigns. With --business-unit, the campaigns of that business unit, the flows and the Data 360 components of its data space and the content of its CMS workspaces are retrieved; nothing of other data spaces or workspaces. --metadata narrows the run to the components it names: campaign and flow are retrieved by this plugin, the Data 360 types (dlo, dmo, mapping, relationship, data-stream, data-transform, data-graph, segment, identity-resolution, calculated-insight) by sf-plugin-data, every other type by sf-plugin-cms. A CMS selector needs --workspace or --business-unit. Existing files are replaced. The exit code is 0 when everything was retrieved, 68 when some components were retrieved and others failed, 1 when nothing was retrieved and something failed.

# examples

- Retrieve every campaign and every marketing flow:

  <%= config.bin %> <%= command.id %> --target-org my-org

- Retrieve everything of one business unit:

  <%= config.bin %> <%= command.id %> --target-org my-org --business-unit defaultBusinessUnit

- Retrieve one campaign, one flow, one segment and one email:

  <%= config.bin %> <%= command.id %> --target-org my-org --metadata campaign:Spring --metadata flow:Welcome_Flow --metadata segment:My_Segment --metadata email:Welcome --workspace Default_Content_Workspace

# flags.metadata.summary

Component to retrieve, as type or type:Name; repeat the flag for several.

# flags.output-dir.summary

Project folder the files are written to.

# flags.business-unit.summary

Developer name of the business unit whose campaigns, flows, data space and CMS workspaces are retrieved.

# flags.workspace.summary

CMS workspace of the CMS components.

# flags.dataspace.summary

Data space of the Data 360 components; default: the data space of --business-unit, else "default".
