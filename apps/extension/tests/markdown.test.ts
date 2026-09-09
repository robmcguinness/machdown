/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTabLinksMarkdown } from '../src/lib/markdown.ts';

await test('bookmark export renders every link in one markdown document', () => {
  const md = buildTabLinksMarkdown(
    [
      { title: 'First', url: 'https://example.com/a' },
      { title: 'Multi\nline  ', url: 'https://example.com/b' },
      { title: '', url: 'https://example.com/c' },
    ],
    new Date('2026-09-08T10:00:00Z'),
  );

  assert.equal(
    md,
    [
      '---',
      'exported: 2026-09-08',
      'tabs: 3',
      '---',
      '',
      '- [First](https://example.com/a)',
      '- [Multi line](https://example.com/b)',
      '- [https://example.com/c](https://example.com/c)',
      '',
    ].join('\n'),
  );
});

await test('bookmark export of nothing still produces a valid document', () => {
  const md = buildTabLinksMarkdown([], new Date('2026-09-08T10:00:00Z'));
  assert.equal(md, '---\nexported: 2026-09-08\ntabs: 0\n---\n\n');
});
