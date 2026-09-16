# summary

Create a deterministic, read-only Marketing Cloud Next migration plan.

# description

Runs bounded source/target prerequisite checks and writes an ownership, transport, support-state, and dependency inventory as deterministic JSON.

With `--cms-plan`, this command discovers a separately installed compatible `sf-plugin-cms`, performs one read-only aggregate Marketing workspace export, validates public contract, package integrity, provenance, exact correlation evidence, and explicit workspace routes, and records planning-only states. Install and verify the provider with `sf plugins install sf-plugin-cms@0.4.0`, `sf plugins inspect sf-plugin-cms --json`, and `sf cms info --contract-version 1 --json`. Version `0.4.0` is the minimum; retained contract compatibility is authoritative. Implemented and experimental capabilities can contribute visibly labeled planning evidence after all checks pass. This increment has no independently evidenced workspace/owner/field-bound MCN dependency source, so successful package and route evidence remains ownership-uncertain and creates no ready dependent edge. Provider installation, compatibility, package, provenance, route, and correlation failures block only the CMS-dependent branch.

Without `--cms-plan`, no CMS subprocess runs and CMS-independent behavior is unchanged. Optional legacy CMS evidence remains minimal deferred input; it cannot override provider evidence, participate in CMS route or edge readiness, or make CMS planning executable or ready. This command never imports CMS packages, passes `--apply`, deploys, mutates either org, rewrites references, creates target payloads, performs cleanup or rollback, or reports migration as completed.

# examples

- Plan a source-to-target assessment:

  <%= config.bin %> <%= command.id %> --source-org source-mcn --target-org target-mcn --output-file migration-plan.json

- Include strictly shaped opaque CMS evidence:

  <%= config.bin %> <%= command.id %> --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-evidence-file cms-evidence.json

- Add planning-only CMS contract, aggregate export, package-integrity, and explicit workspace-route evidence:

  <%= config.bin %> <%= command.id %> --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-plan --cms-workspace-map cms-workspaces.json --cms-export-dir .mcnext-runs/cms-export

# flags.source-org.summary

Source org alias or username used for read-only assessment.

# flags.target-org.summary

Target org alias or username used for read-only prerequisite checks.

# flags.output-file.summary

Path for the deterministic JSON migration plan.

# flags.cms-evidence-file.summary

Optional JSON array of minimal opaque deferred CMS evidence nodes. This does not enable CMS discovery or export and cannot influence CMS route or edge readiness.

# flags.cms-plan.summary

Enable planning-only discovery and one read-only aggregate Marketing workspace export through separately installed `sf-plugin-cms` 0.4.0 or later with compatible retained contracts. Requires both CMS companion flags.

# flags.cms-workspace-map.summary

Path to JSON shaped exactly as `{"version":1,"workspaces":{"<sourceWorkspaceId>":"<targetWorkspaceId>"}}`. Required with `--cms-plan` and rejected without it; names are not routing keys.

# flags.cms-export-dir.summary

New, unused run-owned directory for read-only aggregate CMS export artifacts and retained planning evidence. Required with `--cms-plan` and rejected without it.

# info.cmsPlanning

CMS planning: %s (%s); ready routes: %s; blocked or ownership-uncertain routes: %s. Read-only planning only; no migration was executed.

# warnings.cmsPlanning

CMS-dependent planning is not ready. Inspect cmsPlanning diagnostics and routes in the written plan; resolve provider/package/route failures or missing ownership evidence before proceeding. CMS-independent preflight results remain separate.

# warnings.blocked

Preflight found %s blocked prerequisite check(s). The plan was written as incomplete and no mutation was attempted.
