# Extension development

Run `pnpm --filter @machdown/extension test` for regression tests and
`pnpm --filter @machdown/extension build` to type-check and bundle the extension.

## Registry components

`src/components/ui` holds shadcn registry output. Regenerate a file with
`pnpm dlx shadcn@latest add <name> --overwrite` from this folder, and do not edit
it by hand. The folder is excluded from oxlint and oxfmt, so a re-sync stays a
clean diff. Put each customization in a wrapper under `src/components`:
`StatusBadge.tsx` adds the warning and success tones to the registry badge, and
`Toaster.tsx` makes the registry toaster follow the extension's `.dark` class.

## First init

Initializing a fresh folder seeds its repository config with the extension's
categories, default category, and category suggestions setting. An existing
`.machdown/config.json` wins: its settings are kept and synchronized back to the
extension. The initialization toast confirms when local categories were saved.

## Page extraction

The popup tracks only the seven Markdown extraction settings when deciding to
extract again. Category synchronization, theme changes, and save history do not
restart extraction. Refresh still explicitly captures the current selection or page.
The content script installs one listener per document in the extension's isolated
world, so reopening the popup or clipping the same tab again does not multiply
Readability and Markdown conversion work. Navigation creates a new document and
therefore a new listener. The bundle regression test checks repeated injection and
registration in a new document.

## Batch extraction

The tabs page extracts up to three pages concurrently. Progress counts completed
attempts, including failures. Results are assembled in selection order, preserving
deterministic filename collision handling and per-tab errors. Successful repo
captures still use one save request and one Git commit. The batch tests force
out-of-order completion and a failed tab to verify the concurrency bound, result
ordering, continued processing, and progress counts.

## Bookmark batches

Bookmarks live outside the clip repository. The options page asks for a
bookmarks folder, and every bookmark is appended to one `bookmarks.md` in it,
under a `## YYYY-MM-DD` heading for the day. Lines look like
`- [Title](https://…) · example.com` and carry no categories. A link whose URL
is already in the file is skipped, so saving the same window twice adds
nothing.

The tabs page has a "Bookmarks only" mode next to full clips, and the popup has
"Bookmark only" for one page plus "Save N tabs" for the window. All of them send
one `bookmarks.append` request. No page is extracted and no host permission is
requested. Without a bookmarks folder the same selection downloads as a single
`bookmarks-<date>.md` link list built by `buildTabLinksMarkdown`, which the
markdown tests cover.

The daemon still serves `bookmarks.save`, which writes one stub document per
link and commits. Nothing in the extension calls it any more; it stays so a
repository written by an older version keeps working.

## ZIP exports

ZIP compression runs in a bundled module worker, keeping the tabs page responsive
while it displays “Compressing…”. Input and output buffers transfer ownership
between the page and worker instead of copying archive contents. The worker is
terminated after success or failure; failures appear with the export errors.
The worker is packaged locally by Vite and needs no remote script or runtime
code generation. Files and the compressed archive still reside in memory, so this
is not a streaming exporter. Tests run the built worker in a separate thread,
round-trip Unicode and empty files, verify buffer transfer, and check error cleanup.
