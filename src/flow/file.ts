import { basename, dirname, join } from 'node:path';

/**
 * Reading and patching a flow file (`<ApiName>.flow-meta.xml`) and its sidecar
 * (`<ApiName>.flow.json`). Pure: no file or org access. A patch replaces the text of one element
 * and keeps every other byte of the file.
 */

export const FLOW_FOLDER = 'mcnext/flows';
export const FLOW_XML_SUFFIX = '.flow-meta.xml';
export const FLOW_SIDECAR_SUFFIX = '.flow.json';

export type SegmentNeed = { kind: 'segment'; name: string; dataSpace: string };
export type ContentNeed = { kind: 'content'; type: string; apiName: string; workspace: string };
export type FlowNeed = SegmentNeed | ContentNeed;

/** What the flow file itself cannot say: its campaign, and what must exist before it is deployed. */
export type FlowSidecar = { campaign?: { name: string }; needs: FlowNeed[] };

export class FlowFileError extends Error {
  public constructor(public readonly code: 'FLOW_FILE_INVALID' | 'FLOW_SIDECAR_INVALID', message: string) {
    super(message);
    this.name = 'FlowFileError';
  }
}

/** `<root>/mcnext/flows/<ApiName>.flow-meta.xml` and its sidecar. */
export function flowPaths(root: string, apiName: string): { xml: string; sidecar: string } {
  const folder = join(root, ...FLOW_FOLDER.split('/'));
  return {
    xml: join(folder, `${apiName}${FLOW_XML_SUFFIX}`),
    sidecar: join(folder, `${apiName}${FLOW_SIDECAR_SUFFIX}`),
  };
}

/** API name of a flow file, from its file name; undefined when the path is no flow file. */
export function apiNameOfFlowFile(path: string): string | undefined {
  const name = basename(path);
  return name.endsWith(FLOW_XML_SUFFIX) && name.length > FLOW_XML_SUFFIX.length
    ? name.slice(0, -FLOW_XML_SUFFIX.length)
    : undefined;
}

/** The sidecar that belongs to a flow file. */
export function sidecarPathOf(xmlPath: string): string {
  const apiName = apiNameOfFlowFile(xmlPath) ?? basename(xmlPath);
  return join(dirname(xmlPath), `${apiName}${FLOW_SIDECAR_SUFFIX}`);
}

// ---------------------------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------------------------

type Node = { id: number; parent: number; path: string; start: number; end: number };

// Comments, CDATA sections and processing instructions are skipped; then one tag.
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([^\s<>/]+)[^<>]*?(\/?)>/g;

/** Every element with content, with the range of its inner text. Namespace prefixes are dropped. */
function scan(xml: string): Node[] {
  const nodes: Node[] = [];
  const open: Node[] = [];
  let nextId = 1;
  for (const match of xml.matchAll(TOKEN)) {
    const [token, closing, rawName, selfClosing] = match;
    if (rawName !== undefined && selfClosing !== '/') {
      const name = rawName.slice(rawName.indexOf(':') + 1);
      const parent = open.at(-1);
      if (closing === '/') {
        const node = open.pop();
        if (!node || !node.path.endsWith(`/${name}`))
          throw new FlowFileError('FLOW_FILE_INVALID', `The flow file is not well-formed XML near </${rawName}>.`);
        node.end = match.index;
        nodes.push(node);
      } else {
        open.push({
          id: nextId++,
          parent: parent?.id ?? 0,
          path: `${parent?.path ?? ''}/${name}`,
          start: match.index + token.length,
          end: -1,
        });
      }
    }
  }
  if (open.length > 0)
    throw new FlowFileError('FLOW_FILE_INVALID', 'The flow file is not well-formed XML: an element is not closed.');
  if (!nodes.some((node) => node.path === '/Flow'))
    throw new FlowFileError('FLOW_FILE_INVALID', 'The file has no <Flow> root element.');
  return nodes;
}

const ENTITIES: ReadonlyArray<[string, string]> = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&amp;', '&'],
];

function unescapeXml(text: string): string {
  return ENTITIES.reduce((result, [entity, character]) => result.replaceAll(entity, character), text);
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function textOf(xml: string, node: Node): string {
  return unescapeXml(xml.slice(node.start, node.end).trim());
}

function splice(xml: string, node: Node, value: string): string {
  return `${xml.slice(0, node.start)}${escapeXml(value)}${xml.slice(node.end)}`;
}

function getAt(xml: string, path: string): string | undefined {
  const node = scan(xml).find((candidate) => candidate.path === path);
  return node ? textOf(xml, node) : undefined;
}

function setAt(xml: string, path: string, value: string): string {
  const node = scan(xml).find((candidate) => candidate.path === path);
  if (!node)
    throw new FlowFileError(
      'FLOW_FILE_INVALID',
      `The flow file has no <${path.slice(1).replaceAll('/', '><')}> to change.`
    );
  return splice(xml, node, value);
}

/** Checks that the text is a flow file. Throws FlowFileError otherwise. */
export function assertFlowXml(xml: string): void {
  scan(xml);
}

/** `<dataSpace>`: the data space API name. */
export const getDataSpace = (xml: string): string | undefined => getAt(xml, '/Flow/dataSpace');
export const setDataSpace = (xml: string, value: string): string => setAt(xml, '/Flow/dataSpace', value);

/** `<start><segment>`: a `MarketSegment` record ID in the org, the segment API name in a file. */
export const getStartSegment = (xml: string): string | undefined => getAt(xml, '/Flow/start/segment');
export const setStartSegment = (xml: string, value: string): string => setAt(xml, '/Flow/start/segment', value);

/** `<start><object>`: the DMO the segment is built on. */
export const getStartObject = (xml: string): string | undefined => getAt(xml, '/Flow/start/object');
export const setStartObject = (xml: string, value: string): string => setAt(xml, '/Flow/start/object', value);

/** `<status>`: Draft, InvalidDraft, Active or Obsolete. */
export const getStatus = (xml: string): string | undefined => getAt(xml, '/Flow/status');
export const setStatus = (xml: string, value: string): string => setAt(xml, '/Flow/status', value);

/** The `<stringValue>` node of every `<inputParameters>` named `contentId`, in file order. */
function contentIdNodes(xml: string): Node[] {
  const nodes = scan(xml);
  const parameters = new Set(
    nodes
      .filter((node) => node.path.endsWith('/inputParameters/name') && textOf(xml, node) === 'contentId')
      .map((node) => node.parent)
  );
  const values = new Map(
    nodes.filter((node) => node.path.endsWith('/inputParameters/value')).map((node) => [node.id, node.parent])
  );
  return nodes
    .filter(
      (node) =>
        node.path.endsWith('/inputParameters/value/stringValue') && parameters.has(values.get(node.parent) ?? -1)
    )
    .sort((a, b) => a.start - b.start);
}

/** Every `contentId` input value (`marketing--<workspace>.sfdc_cms__<type>--<apiName>`), in file order. */
export function listContentIds(xml: string): string[] {
  return contentIdNodes(xml).map((node) => textOf(xml, node));
}

/** Replace every `contentId` input value; `replace` returns the new value (or the same one). */
export function replaceContentIds(xml: string, replace: (contentId: string) => string): string {
  // Back to front, so the ranges of the nodes not yet replaced stay valid.
  return contentIdNodes(xml)
    .reverse()
    .reduce((result, node) => {
      const before = textOf(xml, node);
      const after = replace(before);
      return after === before ? result : splice(result, node, after);
    }, xml);
}

// ---------------------------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function parseNeed(value: unknown, index: number): FlowNeed {
  if (isRecord(value)) {
    if (value.kind === 'segment' && filled(value.name) && filled(value.dataSpace))
      return { kind: 'segment', name: value.name, dataSpace: value.dataSpace };
    if (value.kind === 'content' && filled(value.type) && filled(value.apiName) && filled(value.workspace))
      return { kind: 'content', type: value.type, apiName: value.apiName, workspace: value.workspace };
  }
  throw new FlowFileError(
    'FLOW_SIDECAR_INVALID',
    `needs[${index}] must be { kind: "segment", name, dataSpace } or { kind: "content", type, apiName, workspace }.`
  );
}

/** Parse the text of a `.flow.json` file. Throws FlowFileError when it has another shape. */
export function parseSidecar(text: string): FlowSidecar {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FlowFileError(
      'FLOW_SIDECAR_INVALID',
      `Not JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(value)) throw new FlowFileError('FLOW_SIDECAR_INVALID', 'The file must hold one JSON object.');
  const { campaign, needs } = value;
  if (campaign !== undefined && !(isRecord(campaign) && filled(campaign.name)))
    throw new FlowFileError('FLOW_SIDECAR_INVALID', 'campaign must be { "name": "<campaign name>" }.');
  if (needs !== undefined && !Array.isArray(needs))
    throw new FlowFileError('FLOW_SIDECAR_INVALID', 'needs must be a list.');
  return {
    ...(isRecord(campaign) && filled(campaign.name) ? { campaign: { name: campaign.name } } : {}),
    needs: (needs ?? []).map((need, index) => parseNeed(need, index)),
  };
}

/** Text of a `.flow.json` file: two-space JSON, LF, one final line break. */
export function serializeSidecar(sidecar: FlowSidecar): string {
  const ordered: FlowSidecar = {
    ...(sidecar.campaign ? { campaign: { name: sidecar.campaign.name } } : {}),
    needs: sidecar.needs,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
