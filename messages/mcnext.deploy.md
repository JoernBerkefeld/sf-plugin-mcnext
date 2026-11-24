# summary

Deploy CMS content, campaigns and flows in one run.

# description

Deploys the named components from the project folder (the current directory) in this order: CMS content, campaigns, flows, and for each flow its link to a campaign. Before anything is written, every component is checked; if one is blocked, nothing is written. A flow needs its content, its campaign and its segment in the org: content and campaigns that the same run deploys count. With --preview the command stops after the check and reports what it would do. The run stops at the first component that fails; the components after it are reported as not-attempted. A campaign is found by its name within the business unit its file names (or among the campaigns without a business unit); a campaign of the same name elsewhere is another campaign. With --business-unit the components are copied into that business unit: campaigns get its business unit and keep their name, so each becomes a new campaign there; flows get its data space, its segment and its CMS workspace, CMS content goes to its workspace. Data 360 components cannot be deployed with this command yet: use sf data360 deploy for them. A flow whose file says Active is refused without --allow-activation. The exit code is 0 on success, 68 when some components were written and another failed, 1 when nothing was written and something failed or was blocked, 69 when Salesforce is still working.

# examples

- See what a deploy of the whole mcnext folder and one email would do:

  <%= config.bin %> <%= command.id %> --target-org my-org --source-dir mcnext --metadata email:Welcome --preview

- Deploy one campaign and one flow:

  <%= config.bin %> <%= command.id %> --target-org my-org --metadata campaign:Spring --metadata flow:Welcome_Flow

- Copy a campaign, a flow and its email into another business unit:

  <%= config.bin %> <%= command.id %> --target-org my-org --metadata campaign:Spring --metadata flow:Welcome_Flow --metadata email:Welcome --business-unit otherBusinessUnit --allow-cross-dataspace

# flags.metadata.summary

Component to deploy, as type:Name (campaign, flow or a CMS type); a bare campaign or flow means every file of that type, and campaign:Name every campaign file of that name.

# flags.source-dir.summary

File or folder below cms/ or mcnext/ in the project folder; repeat the flag for several.

# flags.preview.summary

Check everything and report what would happen; write nothing.

# flags.business-unit.summary

Developer name of the business unit the components are copied into.

# flags.workspace.summary

CMS workspace the content is deployed to and the flows refer to.

# flags.dataspace.summary

Data space the flows and the CMS data graph providers are moved to.

# flags.allow-cross-dataspace.summary

Allow CMS content that uses another data space to be renamed into the target data space.

# flags.allow-activation.summary

Allow a flow whose file says Active; deploying it starts the flow.
