# summary

Plan an Identity Resolution configuration without mutation.

# description

Parses a closed Identity Resolution source configuration, applies exact family-local dependency mappings at declared fields, verifies the expected source and target orgs separately, and performs read-only target discovery for the explicitly selected `create` or `update-shell` intent.

Intent is never inferred or switched. CREATE fails when the exact target label and key already exist. UPDATE-shell requires an exact target ruleset ID plus expected label, key, and status; missing, ambiguous, or mismatched targets fail without becoming CREATE.

This command is inherently mutation-free. It uses GET paths only and never calls POST, PATCH, publication, scheduling, or run-now paths. CREATE and PATCH writable-schema checkpoints and the lifecycle checkpoint remain blocked because this repository does not contain authoritative evidence for those contracts. A blocked plan never includes a prospective request body.

# examples

- Plan a conflict-checked CREATE against separately verified source and target orgs:

  <%= config.bin %> <%= command.id %> --intent create --source-org source --target-org target --expected-source-org-id <source-org-id> --expected-target-org-id <target-org-id> --input-file identity-resolution-plan.json --api-version 67.0

- Plan an exact UPDATE shell without mutation:

  <%= config.bin %> <%= command.id %> --intent update-shell --source-org source --target-org target --expected-source-org-id <source-org-id> --expected-target-org-id <target-org-id> --target-ruleset-id <ruleset-id> --expected-target-label Marketing --expected-target-key Individual\_\_dlm --expected-target-status DRAFT --input-file identity-resolution-plan.json --api-version 67.0

# flags.intent.summary

Explicit planning intent. The command never infers or changes it.

# flags.source-org.summary

Username or alias of the Marketing Cloud Next source org.

# flags.target-org.summary

Username or alias of the Marketing Cloud Next target org.

# flags.expected-source-org-id.summary

Expected 18-character source organization ID.

# flags.expected-target-org-id.summary

Expected 18-character target organization ID.

# flags.target-ruleset-id.summary

UPDATE-shell only: exact expected target ruleset ID.

# flags.expected-target-label.summary

UPDATE-shell only: exact expected target label.

# flags.expected-target-key.summary

UPDATE-shell only: exact expected target object API name used as the supported read-only key.

# flags.expected-target-status.summary

UPDATE-shell only: exact expected target ruleset status.

# flags.input-file.summary

JSON file containing only `configuration` and `mappings`.

# flags.api-version.summary

MCN API version. This command currently accepts only the verified v67.0 baseline.

# info.result

Identity Resolution %s plan produced with %s semantic difference(s); all write and lifecycle checkpoints remain blocked.
