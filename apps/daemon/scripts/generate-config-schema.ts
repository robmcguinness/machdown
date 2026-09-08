import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildConfigJsonSchema } from '#config-schema.ts';

// The output is committed: editors point at it and the sync test compares
// against it, so it must be pretty-printed and reviewable in a diff.
const outPath = path.join(import.meta.dirname, '..', 'daemon.schema.json');

await writeFile(outPath, `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`);
