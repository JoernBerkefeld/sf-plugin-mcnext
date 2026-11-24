# summary

Delete flows, campaigns and CMS content in one run.

# description

Deletes the named components in the org in this order: flows, campaigns, CMS content. Without --confirm-delete or --preview nothing is read and nothing is deleted. Before anything is deleted, every component is checked; if one is blocked, nothing is deleted. A flow with an active version is blocked, and so is a name that several records share. A campaign named with --metadata is the one of the business unit its local file belongs to; with several local files of that name, or none and several campaigns of that name in the org, select the file with --source-dir. The run stops at the first component that fails; the components after it are reported as not-attempted. The local files of deleted components are removed unless --keep-local-files is set. Data 360 components cannot be deleted with this command yet: use sf data360 delete for them. The exit code is 0 on success, 68 when some components were deleted and another failed, 1 when nothing was deleted and something failed or was blocked.

# examples

- See what would be deleted:

  <%= config.bin %> <%= command.id %> --target-org my-org --metadata flow:Welcome_Flow --metadata campaign:Spring --preview

- Delete a flow and its campaign:

  <%= config.bin %> <%= command.id %> --target-org my-org --metadata flow:Welcome_Flow --metadata campaign:Spring --confirm-delete

- Delete an email and keep its local files:

  <%= config.bin %> <%= command.id %> --target-org my-org --source-dir cms/Default_Content_Workspace/email/Welcome.email.json --confirm-delete --keep-local-files

# flags.metadata.summary

Component to delete, as type:Name (campaign, flow or a CMS type); a bare campaign or flow means every file of that type.

# flags.source-dir.summary

File or folder below cms/ or mcnext/ in the project folder; repeat the flag for several.

# flags.preview.summary

Report what would be deleted; delete nothing.

# flags.workspace.summary

CMS workspace of the CMS components.

# flags.confirm-delete.summary

Confirm that the named components are deleted in the org.

# flags.keep-local-files.summary

Keep the local files of deleted components.
