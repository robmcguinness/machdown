import fs from 'node:fs';
import path from 'node:path';

type VersionedJson = { version?: string; version_name?: string };

/** Turns malformed JSON into a build error that identifies the offending file. */
const parseJson = (text: string, what: string): VersionedJson => {
  try {
    // SAFETY: callers declare the fields they read or write; all other parsed fields remain intact.
    return JSON.parse(text) as VersionedJson;
  } catch (cause) {
    throw new Error(`${what} is not valid JSON`, { cause });
  }
};

export function syncVersion(buffer: { toString: () => string }, _mode: string) {
  void _mode;
  const manifest = parseJson(buffer.toString(), 'manifest.json');

  // Resolve against this file, not the cwd, so the version is stable no matter
  // where the build is invoked from (repo root, workspace filter, editor task).
  const pkgPath = path.resolve(import.meta.dirname, '..', 'package.json');
  const pkg = parseJson(fs.readFileSync(pkgPath, 'utf-8'), pkgPath);
  const pkgVersion = pkg.version;

  if (!pkgVersion) {
    throw new Error('Missing or invalid package.json version');
  }

  manifest.version = pkgVersion;
  manifest.version_name = `Version ${pkgVersion}`;

  return JSON.stringify(manifest, null, 2);
}
