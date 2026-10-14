# summary

Plan or explicitly attach one existing inactive Flow to an inactive Campaign.

# description

Consumes caller-selected correspondence, never generates business mappings or transports native Segment references. API 67.0 only. Input JSON contains exactly artifact, source and target: artifact is the schemaVersion 1 campaign-flow-associations retrieval evidence; source contains orgId, campaignId, flowRecordId, member and segmentId matching exactly one artifact flow; target contains campaignId, flowRecordId, member, segmentId, segmentApiName, segmentDefinitionId, expectedDefinitionId and expectedLatestVersionId. Supply all 18-character IDs explicitly. segmentDefinitionId is the destination Connect MarketSegment definition (3HX), distinct from expectedDefinitionId (300) and expectedLatestVersionId (301). Source provenance is not proof of destination eligibility or business equivalence.

The service independently qualifies the selected org, inactive Campaign and existing inactive Draft/InvalidDraft Segment-triggered Flow, exact latest version, and the narrowly supported DBT ACTIVE unpublished NO_REFRESH Segment in the active default data space on UnifiedssotIndividualMkt\_\_dlm. This is a bounded supported shape, not a universal Salesforce eligibility matrix. InvalidDraft is not runnable or activation-ready. Plan is read-only. Apply delegates at most one AssociatedRecordId-only PATCH to the reviewed service; SegmentId is never written. An existing intended association is independently verified as noop; a different non-null association is a conflict. Ambiguous writes are reconciled without retry. No overwrite, detach, activation, XML rewrite, deployment or CREATE fallback is available. Reserve the destination against concurrent writers; immediate rechecks are not atomic compare-and-swap.

Input and optional output must be files inside project-dir without linked/reparse ancestors. Output is reserved exclusively before service execution, never overwritten, and contains the same redacted result returned in JSON mode. A failed operation returns state failed with code, writeAttempted and writeOutcome and exits nonzero. RECONCILIATION_REQUIRED means a write was attempted: inspect the destination before any manual retry. OUTPUT_WRITE_FAILED is a local publication failure and may include the independently verified associationResult; it is not evidence that an org write was rolled back. Runtime readiness, sending and business equivalence are never assessed.

# examples

- <%= config.bin %> <%= command.id %> --operation plan --target-org target --expected-org-id 00D000000000002AAA --api-version 67.0 --project-dir ./project --input-file association-input.json --json
- <%= config.bin %> <%= command.id %> --operation apply --target-org target --expected-org-id 00D000000000002AAA --api-version 67.0 --project-dir ./project --input-file association-input.json --output-file association-result.json

# flags.operation.summary

Read-only plan or explicit field-only apply; no execution operations.

# flags.target-org.summary

Explicit destination org alias or username.

# flags.expected-org-id.summary

Caller-verified 18-character destination org ID.

# flags.api-version.summary

Explicit supported API version: 67.0 only.

# flags.project-dir.summary

Existing project directory confining local input and output files.

# flags.input-file.summary

JSON with explicit artifact, source and target correspondence; never inferred.

# flags.output-file.summary

Optional exclusive redacted result file inside project-dir; existing files are rejected before org writes.
