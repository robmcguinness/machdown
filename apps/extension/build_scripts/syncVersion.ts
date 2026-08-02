import fs from 'node:fs';
import path from 'node:path';

export function syncVersion(buffer: { toString: () => string }, _mode: string) {
  void _mode;
  const manifest = JSON.parse(buffer.toString());

  // Resolve against this file, not the cwd, so the version is stable no matter
  // where the build is invoked from (repo root, workspace filter, editor task).
  const pkgPath = path.resolve(import.meta.dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const pkgVersion = pkg.version;

  if (!pkgVersion) {
    throw new Error('Missing or invalid package.json version');
  }

  manifest.version = pkgVersion;
  manifest.version_name = `Version ${pkgVersion}`;

  return JSON.stringify(manifest, null, 2);
}
