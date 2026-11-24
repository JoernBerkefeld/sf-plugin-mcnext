/**
 * The one module that imports the two sibling plugins' libraries.
 *
 * `sf-plugin-data` and `sf-plugin-cms` type their connection parameter with their own nested
 * `@salesforce/core` 8, while this repo is on core 9 (the Metadata API retrieve needs it). The two
 * `Connection` classes are different types for the compiler, so every wrapper casts once, here.
 * At run time a core 9 connection works in both libraries (checked read-only against a live org:
 * `listDataSpaces`, `listSegments`, `getItems`); they only use `instanceUrl`, `accessToken`,
 * `getApiVersion` and `request`.
 */
import type { Connection } from '@salesforce/core';
import * as cms from 'sf-plugin-cms/api';
import * as data from 'sf-plugin-data/api';

export type {
  CrossSpaceContext,
  DataSpaceListing,
  RetrieveEnvelope as Data360RetrieveEnvelope,
  RetrieveOptions as Data360RetrieveOptions,
  SegmentLookup,
  SegmentRow,
} from 'sf-plugin-data/api';
export type {
  CmsResult,
  DeployOptions as CmsDeployOptions,
  DeployResult as CmsDeployResult,
  Diagnostic as CmsDiagnostic,
  FlowContentReference,
  GetItemsOptions,
  GetItemsResult,
  ItemState,
  LifecycleResult as CmsLifecycleResult,
  RemoveOptions as CmsRemoveOptions,
  RetrieveOptions as CmsRetrieveOptions,
  RetrieveResult as CmsRetrieveResult,
} from 'sf-plugin-cms/api';

type DataConnection = Parameters<typeof data.listSegments>[0];
type DataRunConnection = Parameters<typeof data.runRetrieve>[0];
type CmsConnection = Parameters<typeof cms.getItems>[0];

// Compile-time bridge between core 9 and the libraries' core 8; see the module comment.
const forData = (connection: Connection): DataConnection => connection as unknown as DataConnection;
const forDataRun = (connection: Connection): DataRunConnection => connection as unknown as DataRunConnection;
const forCms = (connection: Connection): CmsConnection => connection as unknown as CmsConnection;

/** `sf data360 retrieve` over this connection; returns its envelope, prints nothing. */
export function runRetrieve(connection: Connection, options: data.RetrieveOptions): Promise<data.RetrieveEnvelope> {
  return data.runRetrieve(forDataRun(connection), options);
}

/** Every data space of the org. Throws an error with `.code` when the list is not readable. */
export function listDataSpaces(connection: Connection): Promise<data.DataSpaceListing[]> {
  return data.listDataSpaces(forData(connection));
}

/** Exit code of a `sf-plugin-data` envelope. */
export const data360ExitCodeOf = data.exitCodeOf;

/** `sf cms deploy` into one workspace. Never throws; check the envelope. */
export function cmsDeploy(
  connection: Connection,
  options: cms.DeployOptions
): Promise<cms.CmsResult<cms.DeployResult>> {
  return cms.deploy(forCms(connection), options);
}

/** `sf cms delete` in one workspace. Never throws; check the envelope. */
export function cmsRemove(
  connection: Connection,
  options: cms.RemoveOptions
): Promise<cms.CmsResult<cms.LifecycleResult>> {
  return cms.remove(forCms(connection), options);
}

/** `sf cms retrieve` of one workspace. Never throws; check the envelope. */
export function cmsRetrieve(
  connection: Connection,
  options: cms.RetrieveOptions
): Promise<cms.CmsResult<cms.RetrieveResult>> {
  return cms.retrieve(forCms(connection), options);
}

/** Exit code of a `sf-plugin-cms` envelope. */
export const cmsExitCodeOf = cms.exitCodeOf;

/** Every segment of one data space. Throws an error with `.code` when the list is not readable. */
export function listSegments(connection: Connection, options: { dataSpace: string }): Promise<data.SegmentRow[]> {
  return data.listSegments(forData(connection), options);
}

/** One segment by API name or record ID. Throws with `.code` SEGMENT_NOT_FOUND, SEGMENT_OTHER_DATASPACE or SEGMENT_ACQUISITION_FAILED. */
export function resolveSegment(connection: Connection, lookup: data.SegmentLookup): Promise<data.SegmentRow> {
  return data.resolveSegment(forData(connection), lookup);
}

/** The context the rename rules of `salesforce-data360-rules` need. Throws with `.code`. */
export function crossSpaceContext(
  connection: Connection,
  options: { from: string; to: string; names?: readonly string[] }
): Promise<data.CrossSpaceContext> {
  return data.crossSpaceContext(forData(connection), options);
}

/** State of CMS components in one workspace. Never throws; check `status`. */
export function getItems(
  connection: Connection,
  options: cms.GetItemsOptions
): Promise<cms.CmsResult<cms.GetItemsResult>> {
  return cms.getItems(forCms(connection), options);
}

export const flowContentReference = cms.flowContentReference;
export const parseFlowContentReference = cms.parseFlowContentReference;
