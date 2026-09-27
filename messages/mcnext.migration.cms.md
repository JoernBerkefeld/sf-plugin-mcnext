# summary

Preflight or execute a bounded CMS migration through the public CMS CLI contract.

# description

Consumes retained CMS package and route evidence from a migration plan, negotiates `sf cms info` contract v1 and experimental `workspace.import.mapping`, then runs every selected route as a dry-run before any apply. Apply requires both `--allow-experimental-cms` and `--apply`, executes sequentially by source workspace ID, stops on the first non-success result, and never retries. The command revalidates target org, provider, package path, and manifest bindings before mutations. It never imports provider JavaScript, rewrites CMS references, infers dependencies, or passes native-copy, editable, or partial-package flags.

# examples

- Dry-run all selected CMS routes:

  <%= config.bin %> <%= command.id %> --target-org target --expected-target-org-id 00D000000000000AAA --plan-file migration-plan.json --result-file cms-result.json --report-root .mcnext-runs/cms-reports --allow-experimental-cms

- Apply only after all route dry-runs succeed:

  <%= config.bin %> <%= command.id %> --target-org target --expected-target-org-id 00D000000000000AAA --plan-file migration-plan.json --result-file cms-result.json --report-root .mcnext-runs/cms-reports --allow-experimental-cms --apply

# flags.target-org.summary

Target org alias or username resolved independently before CMS execution.

# flags.expected-target-org-id.summary

Exact expected 18-character target org ID. Execution stops if alias resolution differs.

# flags.plan-file.summary

Existing deterministic migration plan containing CMS package, route, and target bindings.

# flags.result-file.summary

New durable execution-result JSON file. The planning artifact is never modified.

# flags.report-root.summary

Parent path for distinct provider-owned applied-import report directories.

# flags.allow-experimental-cms.summary

Explicitly accept the experimental CMS import-mapping capability for dry-run or apply.

# flags.apply.summary

After every route passes dry-run, invoke sequential create-only provider imports. No retry or rollback.
