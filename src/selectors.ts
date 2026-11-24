import { isAbsolute, relative, resolve } from 'node:path';
import type { Area } from './envelope.js';

/** The component families `sf-plugin-data` owns. */
export const DATA360_FAMILIES = [
  'dlo',
  'dmo',
  'mapping',
  'relationship',
  'data-stream',
  'data-transform',
  'data-graph',
  'segment',
  'identity-resolution',
  'calculated-insight',
] as const;

export type Data360Family = (typeof DATA360_FAMILIES)[number];

/** The types this plugin handles itself. */
export const MCNEXT_TYPES = ['campaign', 'flow'] as const;

/** A project path belongs to the area its first folder names. */
const AREAS: readonly Area[] = ['data360', 'cms', 'mcnext'];

export type MetadataSelector = { area: Area; type: string; name?: string; raw: string };

/** `path` is relative to the project folder, with forward slashes. */
export type PathSelector = { area: Area; path: string; raw: string };

export type SelectorError = { code: 'INVALID_SELECTOR'; message: string; raw: string };

const invalid = (raw: string, reason: string): SelectorError => ({
  code: 'INVALID_SELECTOR',
  message: `Invalid selector "${raw}": ${reason}`,
  raw,
});

export function isSelectorError(value: unknown): value is SelectorError {
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'INVALID_SELECTOR';
}

/** Every type that is not ours or a Data 360 family goes to CMS; `sf-plugin-cms` decides whether it exists. */
export function areaOfType(type: string): Area {
  if ((MCNEXT_TYPES as readonly string[]).includes(type)) return 'mcnext';
  if ((DATA360_FAMILIES as readonly string[]).includes(type)) return 'data360';
  return 'cms';
}

/** Parse one `-m` value: `type` or `type:Name`. */
export function parseMetadataSelector(raw: string): MetadataSelector | SelectorError {
  const value = raw.trim();
  const colon = value.indexOf(':');
  const type = colon === -1 ? value : value.slice(0, colon);
  if (type === '') return invalid(raw, 'the type is missing; use "type" or "type:Name".');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(type)) return invalid(raw, `"${type}" is not a type name.`);
  if (colon === -1) return { area: areaOfType(type), type, raw };
  const name = value.slice(colon + 1).trim();
  if (name === '') return invalid(raw, 'the name after ":" is missing.');
  // A flow name becomes a file name under mcnext/flows, so it must be a flow API name and nothing else.
  if (type === 'flow' && !/^[A-Za-z][A-Za-z0-9_]*$/u.test(name))
    return invalid(raw, `"${name}" is not a flow API name.`);
  return { area: areaOfType(type), type, name, raw };
}

/** Parse one `-d` value and route it by its first folder below the project folder. */
export function parsePathSelector(raw: string, projectDir: string = process.cwd()): PathSelector | SelectorError {
  const value = raw.trim();
  if (value === '') return invalid(raw, 'the path is empty.');
  const path = relative(resolve(projectDir), resolve(projectDir, value)).replaceAll('\\', '/');
  if (path === '' || path === '..' || path.startsWith('../') || isAbsolute(path)) {
    return invalid(raw, 'the path is not inside the project folder.');
  }
  const first = path.split('/')[0];
  const area = AREAS.find((folder) => folder === first);
  if (!area) return invalid(raw, 'the path must start with data360/, cms/ or mcnext/.');
  return { area, path, raw };
}
