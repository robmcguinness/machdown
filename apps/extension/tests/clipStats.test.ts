/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipStats } from '../src/lib/clipStats.ts';

await test('clipStats counts words, images and reading time', () => {
  const markdown = ['# Title', '', 'One two three four.', '', '![alt](a.png) ![](b.png)'].join(
    '\n',
  );

  assert.deepEqual(clipStats(markdown), { images: 2, readingMinutes: 1, words: 8 });
});

await test('clipStats reports nothing for an empty clip', () => {
  assert.deepEqual(clipStats('   \n\n  '), { images: 0, readingMinutes: 0, words: 0 });
});

await test('clipStats rounds reading time to whole minutes', () => {
  const words = Array.from({ length: 2_140 }, () => 'word').join(' ');

  assert.equal(clipStats(words).words, 2_140);
  assert.equal(clipStats(words).readingMinutes, 11);
});
