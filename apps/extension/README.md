# Extension development

Run `pnpm --filter @machdown/extension test` for regression tests and
`pnpm --filter @machdown/extension build` to type-check and bundle the extension.

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

## ZIP exports

ZIP compression runs in a bundled module worker, keeping the tabs page responsive
while it displays “Compressing…”. Input and output buffers transfer ownership
between the page and worker instead of copying archive contents. The worker is
terminated after success or failure; failures appear with the export errors.
The worker is packaged locally by Vite and needs no remote script or runtime
code generation. Files and the compressed archive still reside in memory, so this
is not a streaming exporter. Tests run the built worker in a separate thread,
round-trip Unicode and empty files, verify buffer transfer, and check error cleanup.
