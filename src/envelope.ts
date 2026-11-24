export type Area = 'data360' | 'cms' | 'mcnext';

export type Outcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'deleted'
  | 'retrieved'
  | 'would-create'
  | 'would-update'
  | 'would-delete'
  | 'failed'
  | 'blocked'
  | 'unknown'
  | 'not-attempted';

export type Item = {
  area: Area;
  type: string;
  name: string;
  outcome: Outcome;
  path?: string;
  id?: string;
  code?: string;
  message?: string;
};

/** Equals the process exit code. */
export type Status = 0 | 1 | 68 | 69;

export type Operation = 'retrieve' | 'deploy' | 'delete' | 'list';

export type Envelope = {
  status: Status;
  operation: Operation;
  preview: boolean;
  orgId: string;
  items: Item[];
  /** The other plugins' envelopes, unchanged. */
  areas: { data360?: unknown; cms?: unknown };
  warnings: string[];
  errors: Array<{ code: string; message: string; area?: Area }>;
};

const PROBLEM: ReadonlySet<Outcome> = new Set<Outcome>(['failed', 'blocked', 'unknown']);
const WRITTEN: ReadonlySet<Outcome> = new Set<Outcome>(['created', 'updated', 'deleted', 'retrieved']);

/**
 * Status of a run from its own items and the exit codes of the other plugins' phases.
 *
 * A failure is a failed, blocked or unknown item, or a phase code 1 or 68. With a failure the
 * status is 68 when something is confirmed written (an item, or a phase reporting 68), else 1.
 * Without a failure, a phase code 69 gives 69. Otherwise 0.
 */
export function statusOf(items: readonly Item[], phaseCodes: readonly Status[]): Status {
  const failed = phaseCodes.includes(1) || phaseCodes.includes(68) || items.some((item) => PROBLEM.has(item.outcome));
  // A phase that reports 68 has itself confirmed a write.
  const written = phaseCodes.includes(68) || items.some((item) => WRITTEN.has(item.outcome));
  if (failed) return written ? 68 : 1;
  return phaseCodes.includes(69) ? 69 : 0;
}

export function exitCodeOf(envelope: Pick<Envelope, 'status'>): Status {
  return envelope.status;
}

export function emptyEnvelope(operation: Operation, preview: boolean, orgId: string): Envelope {
  return { status: 0, operation, preview, orgId, items: [], areas: {}, warnings: [], errors: [] };
}
