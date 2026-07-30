import { McnClient } from '../client/mcnClient.js';

/**
 * Whether a type needs this plugin at all.
 *
 * - `gap`     - unreachable via core `sf` commands; this plugin implements it.
 * - `core-sf` - already covered by a core command; this plugin only delegates.
 */
export type Coverage = 'gap' | 'core-sf';

/** How a `core-sf` type is retrieved and deployed by the orchestrator. */
export type Delegation = {
  /** Metadata API type name, when delegated to `sf project retrieve|deploy start`. */
  metadataType?: string;
  /** sObject name, when delegated to the `sf data` commands. */
  sObject?: string;
  /** Fields to select for record exports. */
  fields?: string[];
};

/** A single retrievable/deployable artifact within an org. */
export type McnArtifact = {
  /** Stable, portable identity used as the on-disk file name. */
  key: string;
  /** Human-readable label for logs and tables. */
  name: string;
  /** The serialized payload written to disk. */
  content: Record<string, unknown>;
  /** Optional body written to a sidecar file, e.g. email HTML. */
  sidecar?: { extension: string; body: string };
};

/** Implementation for one `gap` type. */
export type TypeHandler = {
  /**
   * List every artifact of this type in the org, without hydrating bodies.
   *
   * @param client - the API client
   * @returns lightweight descriptors
   */
  list(client: McnClient): Promise<Array<{ key: string; name: string }>>;

  /**
   * Fetch one artifact in full.
   *
   * @param client - the API client
   * @param key - the artifact key from `list`
   * @returns the hydrated artifact
   */
  retrieve(client: McnClient, key: string): Promise<McnArtifact>;

  /**
   * Write one artifact back to the org.
   *
   * @param client - the API client
   * @param artifact - the artifact read from disk
   */
  deploy(client: McnClient, artifact: McnArtifact): Promise<void>;
};

/** A registered Marketing Cloud Next type. */
export type McnType = {
  /** CLI-facing name, e.g. `emailContent`. */
  name: string;
  /** One-line description used in `sf mcnext list types` and the generated README table. */
  description: string;
  coverage: Coverage;
  /** Directory name under the retrieve root. */
  directory: string;
  /** Present when `coverage` is `core-sf`. */
  delegation?: Delegation;
  /** Present when `coverage` is `gap`. */
  handler?: TypeHandler;
};
