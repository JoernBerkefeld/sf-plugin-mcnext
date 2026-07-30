import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { McnArtifact, McnType } from '../registry/types.js';

/** On-disk layout. */
export type FormatName = 'mcdev' | 'sfdx';

/**
 * Resolves on-disk paths for retrieved artifacts.
 *
 * Serialization itself is format-agnostic - only path resolution differs, which
 * keeps the round-trip guarantee identical in both layouts.
 */
export class FormatWriter {
  public constructor(
    private readonly format: FormatName,
    private readonly root: string,
    private readonly orgAlias: string
  ) {}

  /**
   * Ensure the parent directory of a path exists.
   *
   * @param filePath - the file whose directory should exist
   */
  public static async ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
  }

  /**
   * Resolve the directory that holds artifacts of a given type.
   *
   * @param type - the registered type
   * @returns the absolute-or-relative directory path
   */
  public directoryFor(type: McnType): string {
    return this.format === 'mcdev'
      ? join(this.root, 'retrieve', this.orgAlias, type.directory)
      : join(this.root, 'force-app', 'main', 'default', type.directory);
  }

  /**
   * Write one artifact, plus its sidecar body when present.
   *
   * @param type - the registered type
   * @param artifact - the artifact to persist
   * @returns the paths written
   */
  public async write(type: McnType, artifact: McnArtifact): Promise<string[]> {
    const dir = this.directoryFor(type);
    await mkdir(dir, { recursive: true });

    const written: string[] = [];
    const jsonPath = join(dir, `${sanitize(artifact.key)}.json`);
    await writeFile(jsonPath, `${JSON.stringify(artifact.content, undefined, 2)}\n`, 'utf8');
    written.push(jsonPath);

    if (artifact.sidecar) {
      const sidecarPath = join(dir, `${sanitize(artifact.key)}.${artifact.sidecar.extension}`);
      await writeFile(sidecarPath, artifact.sidecar.body, 'utf8');
      written.push(sidecarPath);
    }

    return written;
  }

  /**
   * Read one artifact back from disk.
   *
   * @param type - the registered type
   * @param key - the artifact key
   * @param [sidecarExtension] - extension of the sidecar body, when the type uses one
   * @returns the reconstructed artifact
   */
  public async read(type: McnType, key: string, sidecarExtension?: string): Promise<McnArtifact> {
    const dir = this.directoryFor(type);
    const jsonPath = join(dir, `${sanitize(key)}.json`);
    const content = JSON.parse(await readFile(jsonPath, 'utf8')) as Record<string, unknown>;

    const artifact: McnArtifact = { key, name: String(content.name ?? key), content };

    if (sidecarExtension) {
      const sidecarPath = join(dir, `${sanitize(key)}.${sidecarExtension}`);
      artifact.sidecar = { extension: sidecarExtension, body: await readFile(sidecarPath, 'utf8') };
    }

    return artifact;
  }
}

/**
 * Replace characters that are illegal in file names on Windows or POSIX.
 *
 * @param value - the raw key
 * @returns a file-system-safe key
 */
function sanitize(value: string): string {
  return value.replaceAll(/[<>:"/\\|?*]/g, '_');
}
