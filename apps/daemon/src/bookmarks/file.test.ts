import { describe, test } from 'node:test';
import { appendBookmarks } from './file.ts';
import assert from 'node:assert/strict';

/**
 * `bookmarks.md` is the file the user reads, so these assert the whole text
 * rather than a parsed shape: spacing, heading reuse, and the trailing newline
 * are the behaviour, not incidental formatting.
 */

const DAY_ONE = new Date('2026-03-04T10:00:00.000Z');
const DAY_TWO = new Date('2026-03-05T09:30:00.000Z');

describe('appendBookmarks', () => {
  test('starts a new file with a title and a dated heading', () => {
    const result = appendBookmarks(
      null,
      [{ siteName: 'example.com', title: 'Example', url: 'https://example.com/a' }],
      DAY_ONE,
    );

    assert.equal(result.added, 1);
    assert.equal(result.skipped, 0);
    assert.equal(
      result.content,
      '# Bookmarks\n\n## 2026-03-04\n\n- [Example](https://example.com/a) · example.com\n',
    );
  });

  test('reuses the heading when appending on the same day', () => {
    const first = appendBookmarks(
      null,
      [{ siteName: 'example.com', title: 'One', url: 'https://example.com/1' }],
      DAY_ONE,
    );

    const second = appendBookmarks(
      first.content,
      [{ title: 'Two', url: 'https://example.com/2' }],
      DAY_ONE,
    );

    assert.equal(second.added, 1);
    assert.equal(
      second.content,
      '# Bookmarks\n\n## 2026-03-04\n\n' +
        '- [One](https://example.com/1) · example.com\n' +
        '- [Two](https://example.com/2)\n',
    );
  });

  test('opens a new heading on a later day', () => {
    const first = appendBookmarks(null, [{ title: 'One', url: 'https://example.com/1' }], DAY_ONE);

    const second = appendBookmarks(
      first.content,
      [{ title: 'Two', url: 'https://example.com/2' }],
      DAY_TWO,
    );

    assert.equal(second.added, 1);
    assert.equal(
      second.content,
      '# Bookmarks\n\n## 2026-03-04\n\n- [One](https://example.com/1)\n' +
        '\n## 2026-03-05\n\n- [Two](https://example.com/2)\n',
    );
  });

  test('skips URLs already in the file and repeats within the batch', () => {
    const first = appendBookmarks(null, [{ title: 'One', url: 'https://example.com/1' }], DAY_ONE);

    const second = appendBookmarks(
      first.content,
      [
        { title: 'Again', url: 'https://example.com/1' },
        { title: 'New', url: 'https://example.com/2' },
        { title: 'New twice', url: 'https://example.com/2' },
      ],
      DAY_ONE,
    );

    assert.equal(second.added, 1);
    assert.equal(second.skipped, 2);
    assert.match(second.content, /- \[New]\(https:\/\/example\.com\/2\)\n$/);
    assert.doesNotMatch(second.content, /New twice/);
  });

  test('leaves the file untouched when every link is a duplicate', () => {
    const first = appendBookmarks(null, [{ title: 'One', url: 'https://example.com/1' }], DAY_ONE);

    const second = appendBookmarks(
      first.content,
      [{ title: 'One again', url: 'https://example.com/1' }],
      DAY_TWO,
    );

    assert.equal(second.added, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.content, first.content);
  });

  test('falls back to the URL for an empty title and collapses a multi-line one', () => {
    const result = appendBookmarks(
      null,
      [
        { title: '   \n  ', url: 'https://example.com/blank' },
        { title: 'Two\nlines', url: 'https://example.com/wrapped' },
      ],
      DAY_ONE,
    );

    assert.match(
      result.content,
      /- \[https:\/\/example\.com\/blank]\(https:\/\/example\.com\/blank\)/,
    );
    assert.match(result.content, /- \[Two lines]\(https:\/\/example\.com\/wrapped\)/);
  });

  test('escapes a bracket in the title and a parenthesis in the URL', () => {
    const result = appendBookmarks(
      null,
      [{ title: 'Draft [WIP]', url: 'https://example.com/a_(b)' }],
      DAY_ONE,
    );

    assert.match(result.content, /- \[Draft \[WIP\\]]\(https:\/\/example\.com\/a_\(b%29\)/);
  });
});
