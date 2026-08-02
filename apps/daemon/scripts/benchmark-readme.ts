import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPool } from '../src/util/mutex.ts';
import { regenerateReadme } from '../src/repo/generate.ts';

const count = Number(process.argv[2] ?? 5_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 20_000) {
  throw new Error('Provide a clip count between 1 and 20000.');
}
const repo = await mkdtemp(path.join(os.tmpdir(), 'machdown-readme-bench-'));
const body = 'Archived page content.\n'.repeat(3_000);
const document = (index: number, title = `Clip ${index}`) =>
  `---\ntitle: ${title}\nurl: https://example.com/${index}\ncategories: [Backend]\n---\n\n${body}`;

try {
  await mkdir(path.join(repo, 'clips'));
  const pool = createPool(16);
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      pool(() => writeFile(path.join(repo, 'clips', `${index}.md`), document(index))),
    ),
  );
  for (const phase of ['cold', 'warm', 'one changed']) {
    if (phase === 'one changed') {
      await writeFile(path.join(repo, 'clips', '0.md'), document(0, 'Edited clip'));
    }
    const stats = { read: 0, reused: 0 };
    const start = performance.now();
    await regenerateReadme(repo, { stats });
    process.stdout.write(
      `${JSON.stringify({ count, ms: Math.round(performance.now() - start), phase, ...stats })}\n`,
    );
  }
} finally {
  await rm(repo, { force: true, recursive: true });
}
