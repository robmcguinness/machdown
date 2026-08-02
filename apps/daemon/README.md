# @machdown/daemon

The companion daemon for the Machdown extension. A browser extension cannot run
`git` or index files on disk, so this process does: it owns a git-backed
repository of your clips, writes them as categorized Markdown, and searches them
with an embedded [qmd](https://github.com/tobi/qmd) index.

It binds to `127.0.0.1` only and refuses every request without a bearer token.

## Running it

```bash
pnpm daemon              # from the repo root
node src/main.ts         # or directly, from apps/daemon
```

Node 22 or newer. The daemon runs its own TypeScript unbuilt via native type
stripping, so there is no build step.

On Ctrl-C under `pnpm daemon` or `pnpm start`, pnpm exits before the daemon
does. fish then queries the terminal for its next prompt, and the replies can
land on the prompt as stray text such as `[20;1R[?62;22c`. The daemon continues
its shutdown in the background. For a clean prompt, run
`node --conditions=source apps/daemon/src/main.ts` from the repo root, or
`pnpm exec node --conditions=source apps/daemon/src/main.ts`.

On start it prints its address and a pairing code:

```
  Machdown daemon  http://127.0.0.1:41998
  API docs         http://127.0.0.1:41998/docs
  Repository       ~/Workspaces/kb

  Pairing code     K7QP-3M2X   (valid 10 minutes)
  Paired           1 extension(s)
```

### Pairing

1. Start the daemon and copy the pairing code.
2. Open the extension's options page → **Repository**.
3. Paste the code and press **Pair**.

The code is single use and expires after ten minutes. On macOS and Linux,
`pnpm daemon:pair` asks the running daemon for a fresh code, prints it, and exits.
For a nondefault port, use `pnpm daemon:pair --port <port>`. If no daemon is
running, the command starts one and stays up so pairing can complete. Issuing a
new code invalidates the previous one. The token the exchange returns is shown
once; only its SHA-256 is stored.

The local control socket lives at `~/.machdown/control/<port>.sock`, with mode
`0600` inside a `0700` directory. Both client and server check ownership and
permissions and reject symlinks. Code issuance is not exposed over HTTP. Stale
sockets from a stopped process are recovered on startup; live sockets are never
replaced. When upgrading an older running daemon, restart it once to enable this
control channel. Windows retains startup pairing; restart the daemon to obtain
a new code there.

### Pointing it at a repository

In options → **Repository**, enter a folder and press **Initialize**. The
daemon creates it if needed, runs `git init`, and scaffolds the layout below.

**Browse…** opens a folder picker. It has to run daemon-side: a Chrome
extension page cannot produce a real filesystem path, and it is rooted at your
home directory plus the configured repository. Set `MACHDOWN_BROWSE_ROOTS` (a
colon-separated list) to browse a knowledge base on another volume.

Tick **Adopt existing markdown files** to fold a pre-existing flat archive into
`clips/`, backfilling the frontmatter the daemon relies on while preserving each
file's original `title`, `url`, `site`, and `clipped`.

## Configuration

| Variable                | Default   | Purpose                                            |
| ----------------------- | --------- | -------------------------------------------------- |
| `MACHDOWN_PORT`         | `41998`   | Listen port. `--port` overrides it.                |
| `MACHDOWN_REPO`         | _(unset)_ | Repository path, overriding the stored one.        |
| `MACHDOWN_LOG_LEVEL`    | `info`    | pino level. See "Request logs" below.              |
| `MACHDOWN_BROWSE_ROOTS` | _(empty)_ | Colon-separated extra roots for the folder picker. |

Every variable is declared and validated at startup in `src/env.ts`. An
unusable `MACHDOWN_PORT` is reported as a config issue and falls back to the
stored port, so a typo never blocks startup.

`pnpm daemon`, `pnpm daemon:pair`, `dev` and `test` read `apps/daemon/.env`
when it exists; copy `apps/daemon/.env.example` to start one. An installed
`machdownd` reads the real environment instead.

### Request logs

Every request writes exactly one `info` line when the response completes — a
"wide event" that collects the route, the status, the duration and whatever
else the handlers attached on the way through. One line per request, whatever
the outcome: a matched procedure, `/health`, a 404, an auth rejection.

`MACHDOWN_LOG_LEVEL` sets the pino level for that line and everything else:

| Level              | What you get                                      |
| ------------------ | ------------------------------------------------- |
| `warn` and above   | Failures only; no wide event.                     |
| `info` _(default)_ | The one wide event per request.                   |
| `debug` / `trace`  | The wide event plus the mid-request detail lines. |
| `silent`           | Nothing. The `test` script sets this.             |

`authorization` and `cookie` headers, any `token` field, and the pairing
`code` are replaced with `[Redacted]` before the line is written. The list
lives in `REDACT_PATHS` in `src/server/app.ts`; a new field that carries a
secret goes there. The pairing code is listed path by path rather than as a
`*.code` wildcard, because a wildcard would also censor `err.code` — the one
stable name a failure has.

### Test hooks

Three more variables exist for the test suite and are not part of the
configuration above:

| Variable                | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `MACHDOWN_QMD_DB`       | Points the search index at another SQLite file.           |
| `MACHDOWN_QMD_DISABLED` | `1` makes every search call report the index unavailable. |
| `MACHDOWN_QMD_IT`       | `1` runs the qmd integration tests.                       |

The first two are read on every call, not captured at import, so a test may set
them after loading the search client.

Daemon state lives at `~/.machdown/daemon.json`, mode `0600`. It holds the
repository path and token hashes, and is deliberately **outside** the clip
repository so it is never committed or synced to another machine.

## Repository layout

```
<repo>/
  README.md                  generated table of contents — do not edit
  .machdown/
    config.json              categories and preferences (committed)
    readme-intro.md          optional hand-written preamble
  clips/
    otel-collector-pipelines.md
    staff-plus-archetypes.md
    zod-docs.md              a bookmark: same folder, `kind: bookmark`, no body
```

**Categories live in frontmatter, not in the directory tree.** One flat folder
holds clips and bookmarks alike, so a document can carry several categories at
once and renaming one never strands a file. A clip's `categories` list is the
only record of where it belongs; the README groups by it.

Bookmarks are stub documents rather than a JSON sidecar, which is what lets qmd
index them, search find them, and the category suggester learn from a link you
never fully clipped. Clipping a bookmarked page later upgrades that same file in
place instead of creating a second entry.

A repository created before this layout is upgraded automatically the first time
the daemon touches it: files move up out of their category folders as git
renames (so `git log --follow` still works), `bookmarks.json` becomes stub
files, and `layoutVersion` in `config.json` records that it is done. Flattening
can force a rename when two categories held the same title — `foo.md` and
`foo-2.md` — and those are reported back rather than applied silently.

Clip documents, repository JSON, and the generated README are written to unique
sibling temporary files, flushed, and renamed into place. Readers see a complete
old or new file; an interrupted replacement does not truncate the existing file.
A save across several files is not a filesystem transaction. If interrupted
between replacements, use **Rebuild README** to rebuild derived state. A hard process kill may leave harmless `*.tmp` files;
these are not indexed as clips and may be removed when the daemon is stopped.

`README.md` is entirely machine-owned and regenerated after every mutation.
A bounded in-memory cache retains frontmatter for up to 20,000 documents, never
page bodies. Each generation checks paths and file fingerprints; only changed or
new documents are reread. External edits, additions, moves, and deletions are
picked up on the next generation. Explicit README rebuilds and index
reconciliation bypass cached metadata.

To measure archive I/O on a disposable 5,000-document fixture (~66 KB per clip):

```bash
node --conditions=source apps/daemon/scripts/benchmark-readme.ts 5000
```

One local run took 870 ms cold (5,000 reads), 69 ms warm (zero body reads), and
74 ms after one edit (one read). These are README-generation timings, excluding
Git and QMD; filesystem checks and rendering still scale with document count.

Hand-written prose belongs in `.machdown/readme-intro.md`, which is prepended
verbatim. The URL index lives only in memory and is rebuilt from clip frontmatter.
The watcher-backed snapshot discovers manual renames, moves, and deletions.

Clips commit automatically. Each save commits its changed documents and
README only; unrelated staged files and edits to other clips remain yours.
Configuration updates and README rebuilds also commit only their own files. **Pushing never happens on its own** — use _Sync
now_ in options. After a successful pull, the daemon rebuilds repository metadata,
clears suggestions, and refreshes search in the background, even if pushing then
fails. Rebuilt derived files may remain as working-tree changes; reconciliation
does not create an extra commit.

## API

`GET /docs` renders the full API; `GET /openapi.json` is the spec. Both are
generated from the same contract the router implements, so they cannot drift.

Every route except `/v1/health` requires `Authorization: Bearer <token>`.

```bash
curl -s localhost:41998/v1/health | jq
curl -s -X POST localhost:41998/v1/search \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"q":"tracing spans","mode":"search","limit":10}' | jq
```

Errors are typed, so clients branch on a code rather than a message:
`UNAUTHORIZED`, `BAD_REQUEST`, `NO_REPO`, `QMD_UNAVAILABLE`, `GIT_FAILED`,
`PATH_REJECTED`, `CONFLICT`.

## Search

Search is [qmd](https://github.com/tobi/qmd) embedded as a library — nothing to
install separately. The index is a SQLite database at
`~/.machdown/qmd/index.sqlite`, daemon-owned rather than shared with a personal
`qmd` setup, and it runs in a worker thread: `better-sqlite3` is synchronous and
indexing can take minutes, which in the main process would stall every other
request for the duration.

`repo.init` and `config.update` point the index at `<repo>/clips` and re-scan
it. Saves trigger a debounced background re-index. Embeddings are slow and never
generated implicitly — run them from the search page or:

```bash
curl -s -X POST localhost:41998/v1/index/update \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"embed":true}'
```

If the index cannot be opened the daemon still works; only search is disabled,
and `health` reports `qmd.available: false` so the extension can say so. The
first vector or reranked search downloads a local model, which `health` reports
as `qmd.preparing: true` while it happens.

## Security model

The daemon writes files and runs `git` on your machine, so it is deliberately
hard to reach:

- **Loopback only.** It never binds `0.0.0.0`.
- **Bearer token on every route** except the health probe, enforced in an
  `onRequest` hook — _before_ schema validation, so an unauthenticated caller
  cannot probe request shapes by sending bad bodies.
- **CORS** accepts `chrome-extension://` origins and the Vite dev server. Any
  extension ID is allowed, because an unpacked extension's ID differs per
  machine; the token is the security boundary, not CORS.
- **Anti-CSRF.** A web page can reach loopback even though it cannot read the
  response. Three checks stop it: an unrecognized `Origin` is rejected,
  `Sec-Fetch-Site: cross-site` is rejected, and mutations must be
  `application/json` — which is not a CORS-simple content type and so forces a
  preflight the origin check fails.
- **Path containment.** Category names are validated as directory names, and
  every resolved path is checked lexically _and_ against the realpath of its
  nearest existing ancestor, so a symlink planted inside `clips/` cannot
  redirect a write out of the repository.
- **No shell.** Every `git` invocation uses `execFile` with an argv array, so no
  title or category can become command injection. Search never leaves the
  process at all: qmd runs as a library in a worker thread, so a query is an
  argument to a function rather than a word on a command line.

## Running at login (macOS)

There is no installer. To run it at login, adapt this into
`~/Library/LaunchAgents/com.machdown.daemon.plist` and
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.machdown.daemon</string>
    <key>ProgramArguments</key>
    <array>
      <string>/PATH/TO/node</string>
      <string>/PATH/TO/machdown/apps/daemon/src/main.ts</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/machdown-daemon.log</string>
    <key>StandardErrorPath</key><string>/tmp/machdown-daemon.log</string>
  </dict>
</plist>
```

Pairing codes are printed to stdout, so read them from the log file.

### Metadata snapshots during saves

Clip and bookmark saves reuse a metadata snapshot when rendering the README.
A warm unchanged archive requires no per-document filesystem probes. Daemon
writes explicitly mark their paths for refresh; a recursive filesystem watcher
tracks external edits, additions, and removals. Directory changes trigger a full
scan. Snapshot reuse is bounded to four repositories, with watchers closed on
eviction. Watcher failures fall back to scanning on each save.

A full fingerprint scan at least every 30 seconds **when saving** recovers missed
filesystem events. External edits can therefore briefly lag watcher delivery;
`readme.rebuild` forces immediate reconciliation. Pull/index rebuilds discard the
snapshot. Rendering and the README write remain inside the save transaction so
clips and their table of contents stay in one commit. The metadata-cache tests
cover zero file visits on warm saves, local writes, external edits/deletions, and
explicit repair.

### Batch category suggestions

Each suggestion request enumerates archive entries once to build global category
counts, path lookups, and normalized category counts by host. All tabs then share
these maps, including different URLs on the same host. Existing-URL shortcuts,
category ranking, semantic fallback, and response ordering remain unchanged.
The fifty-page regression test checks one archive enumeration and independent
recommendations for two hosts. Aggregates are request-local, so subsequent
requests use the current index without another cache invalidation mechanism.
