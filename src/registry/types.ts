import { McnClient } from '../client/mcnClient.js';

/** The component responsible for an operation. */
export type Provider = 'mcnext' | 'core-sf' | 'cms-service' | 'external/manual' | 'secondary-data';

/** Current implementation status of a registered type. */
export type SupportState = 'implemented' | 'delegated' | 'conditional' | 'deferred';

/** Operations a type can expose through this plugin or a delegated provider. */
export type McnOperation = 'list' | 'retrieve' | 'deploy' | 'export' | 'create' | 'update' | 'plan';

/** How a core-sf type is retrieved or deployed by the orchestrator. */
export type Delegation = {
  /** Metadata API type name, when delegated to sf project commands. */
  metadataType?: string;
  /** sObject name, when delegated to sf data commands. */
  sObject?: string;
  /** Fields to select for record exports. */
  fields?: string[];
  /** Exact core command family exposed by a public delegation command. */
  command?: string;
};

/** A single retrievable/deployable artifact within an org. */
export type McnArtifact = {
  /** Stable identity used by the owning MCN workflow. */
  key: string;
  /** Human-readable label for logs and tables. */
  name: string;
  /** The serialized payload written to disk. */
  content: Record<string, unknown>;
  /** Optional body written to a sidecar file. */
  sidecar?: { extension: string; body: string };
};

/** Implementation for one MCN-owned artifact type. */
export type TypeHandler = {
  /** List lightweight artifact descriptors. */
  list(client: McnClient): Promise<Array<{ key: string; name: string }>>;
  /** Fetch one artifact in full. */
  retrieve(client: McnClient, key: string): Promise<McnArtifact>;
  /** Write one artifact back to the org. */
  deploy(client: McnClient, artifact: McnArtifact): Promise<void>;
};

/** A registered Marketing Cloud Next capability. */
export type McnType = {
  /** CLI-facing name, for example marketSegmentMember. */
  name: string;
  /** One-line description used in list output and documentation. */
  description: string;
  /** Component that owns the implementation or future implementation. */
  provider: Provider;
  /** Truthful current status; conditional and deferred entries are not supported. */
  state: SupportState;
  /** Operations available or planned under the declared state. */
  operations: McnOperation[];
  /** Directory name for MCN-owned artifacts when applicable. */
  directory?: string;
  /** Present when provider is core-sf. */
  delegation?: Delegation;
  /** Present only when an MCN-owned artifact workflow is implemented. */
  handler?: TypeHandler;
  /** Short reason for a conditional or deferred state. */
  limitation?: string;
};
