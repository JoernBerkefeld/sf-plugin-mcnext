/** Types of run-owned-temp.mjs for the TypeScript tests. */
export type RunOwnedTemp = Readonly<{ root: string }>;
export function createRunOwnedTemp(prefix: string): Promise<RunOwnedTemp>;
export function createRunOwnedDirectory(run: RunOwnedTemp, name: string): Promise<string>;
export function assertRunOwnedPath(run: RunOwnedTemp, target: string): Promise<void>;
export function removeRunOwnedPath(run: RunOwnedTemp, target: string): Promise<void>;
export function removeRunOwnedRoot(run: RunOwnedTemp): Promise<void>;
