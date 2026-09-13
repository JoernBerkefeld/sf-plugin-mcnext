# summary

Create a deterministic, read-only Marketing Cloud Next migration plan.

# description

Runs bounded source/target prerequisite checks and writes the first v2 ownership, transport, support-state, and dependency inventory as deterministic JSON.

This command never deploys, mutates data, or creates target payloads. Optional CMS evidence is accepted only as minimal opaque deferred nodes and is never interpreted or copied into an executable payload.

# examples

- Plan a source-to-target assessment:

  <%= config.bin %> <%= command.id %> --source-org source-mcn --target-org target-mcn --output-file migration-plan.json

- Include strictly shaped opaque CMS evidence:

  <%= config.bin %> <%= command.id %> --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-evidence-file cms-evidence.json

# flags.source-org.summary

Source org alias or username used for read-only assessment.

# flags.target-org.summary

Target org alias or username used for read-only prerequisite checks.

# flags.output-file.summary

Path for the deterministic JSON migration plan.

# flags.cms-evidence-file.summary

Optional JSON array of minimal opaque deferred CMS evidence nodes.

# warnings.blocked

Preflight found %s blocked prerequisite check(s). The plan was written as incomplete and no mutation was attempted.
