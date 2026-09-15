# dsh-plugin-trellis-statusline

The active Trellis task of the current session's workspace, shown in the dsh web session
header.

```
[P2] Trellis statusline plugin for dsh web · 进行中
[P1] Release 0.2 · 进行中 · 父任务
[P2] Wire the importer · 进行中 · 子任务
```

It shows in **two** places: the session header, and — for a new session that has no messages yet —
above the composer, where the shell hides the whole header.

---

## What it shows

One cell in the **session header** (`conversation.session.header.actions` — the title-adjacent
actions row, immediately right of the session-preset selector), reading `[priority] title ·
status` for the Trellis task the session's working directory is on — the same information the
Claude Code `statusline.py` hook puts in a terminal, which dsh's web shell had no equivalent for.

It resolves, in this order:

1. **The session's working directory.** `ctx.sessions.get(sessionId).header.cwd` for a live
   session; otherwise the workspace registry's canonical-cwd index
   (`ctx.workspaceRegistry.list()`), which also covers sessions that are no longer live.
2. **`<cwd>/.trellis/.runtime/sessions/dsh_<sessionId>.json`** — the pointer `task.py start`
   writes. It wins whenever it names a real task directory inside `.trellis`.
3. **A scan of `<cwd>/.trellis/tasks/<dir>/task.json`** — `in_progress` before `planning`, and
   among equals the lexicographically greatest directory name (the newest `MM-DD-` task). A
   scanned task must also have been **started at least once**, which is what a recorded
   `branch` proves (`task.py start` is what records it; step 2's pointer is not filtered this
   way, because a pointer is itself evidence that a session started the task).

That last clause matters more than it looks. `trellis init` leaves a scaffolding task —
`Bootstrap Guidelines` — at `status: in_progress` with `branch: null` and never touches it
again. Without the check, **every** fresh Trellis project reports that task as its active work
even though no session has ever opened it. Verified across five real workspaces here: four of
them have exactly that stale task, and all four correctly render nothing.

With no dsh session, no working directory, no `.trellis`, no started task or a corrupt file,
the cell renders **nothing at all**. No placeholder, no blank row, no error: an ordinary
conversation must not grow a control for a capability it is not using.

The display refreshes every 10 s, and immediately when the header switches to another
session, so a `task.py start` or `task.py archive` shows up within one poll.

## Task trees

When the task belongs to a parent/child structure, the pill says so and becomes clickable.

| The session's task is | The pill reads |
|---|---|
| standing alone | `[P2] Title · 进行中` — no role, no click target, no tab stop |
| the tree's root | `[P1] Title · 进行中 · 父任务` |
| anywhere else in the tree | `[P2] Title · 进行中 · 子任务` |

Two rules keep this readable on a tree of any shape:

- **There are only two roles.** The tree's *top ancestor* is the one and only 父任务; every other
  member — grandchildren included — is a 子任务. No third label exists, so depth never changes the
  wording.
- **Clicking opens the real structure.** The dropdown keeps the true nesting — one indent level
  per depth, with a guide line — and highlights the session's task. The pill itself deliberately
  does not repeat the root's title: the role chip says *that* there is a tree, and the dropdown
  says *what* it is.

The tree is derived from the active task set, and the awkward cases are all pinned by tests:

| Case | What happens |
|---|---|
| a `completed`, or never-started, sibling | shows in the tree; the scan's status/branch filters deliberately do not apply to structure |
| a half-written link (parent lists the child, child records no parent) | still attached — Trellis prints `Link is half-written` when that second write fails |
| a dangling `parent` (target archived or renamed) | the task becomes its own root, as `task.py list` renders orphans |
| archived children still named in `children` | left out; `children` is a historical list, and `task.py list` skips them too |
| the legacy `subtasks` spelling | still read |
| a parent cycle | terminates at a hop ceiling instead of hanging |
| a corrupt node | drops out with its subtree; its siblings still render |
| a tree not containing the task it describes | dropped, degrading to the plain pill |

## Where it appears

| Seat | When it shows | How it is placed |
|---|---|---|
| `conversation.session.header.actions` (id `trellis-statusline`, order 10) | an ordinary session | the header's title-adjacent action, laid out by the shell |
| `shell.overlay` (id `trellis-statusline-hero`, order 1) | a **blank** session — the new-session view, where the shell hides the entire header | measured and drawn centred just **below the composer card** |

Three facts make the second seat work, and all three came from the live shell's **render sites**
rather than from the slot catalog's descriptions:

- **A blank session exists.** `ConversationRoot` computes
  `hero = sessionId === undefined || shellPhase === "blank" && …`, so a new session is a real
  session with a real id. Two conditions pick it: the same `blank` bit the shell reads
  (`useSessions((s) => s.byId[id]?.blank)`), and the Conversation actually being on screen
  (`usePanelInfo((s) => s.activePanelId) === null`) — the overlay is frame-wide, and a blank
  session stays blank while Settings is open, so `blank` alone would float the pill over it.
  Being root-scoped, the cell takes the session id from `useSessions((s) => s.current)`.
- **The header is hidden, not unmounted.** The Hero applies
  `.wSkVaW_headerHidden{display:none}` to the header block, so the header cell stays mounted
  while invisible — which is why "show this where the header pill is not" cannot work.
- **Nothing additive sits below the card.** The Hero's composer stack is
  `HeroShell → heroWorkspaceRow → conversation.input.dock → inputBar`, so the card is its last
  child and the room under it is the stack's own bottom padding. (The seat that *looks* right
  from its description, `conversation.composer.dock`, is gated to `variant === "composer"` and so
  never renders in the Hero at all.) That rules out a seat, and is why this one is positioned by
  measurement.

The measurement borrows the technique the sibling `dsh-plugin-ollama-usage` already uses: the
anchor is the **slot protocol's own marker** —
`document.querySelector('[data-slot="conversation.composer.bar"]')` — not a product CSS class. A
zero-sized rect there means a `display:contents` wrapper, so it keeps looking inside; coordinates
are taken relative to the overlay entry's own box, because the overlay layer's origin is not the
viewport; and re-measurement rides a `ResizeObserver` plus a viewport `resize` listener.
**If the composer cannot be measured, nothing is drawn at all** — a reshaped composer costs the
hero pill, never a misplaced one.

The overlay layer is click-through, so the entry keeps `pointer-events:none` and only its slot opts
back in: the pill is clickable and everything around it passes clicks through. The cell renders
`null` for any non-blank session, so an ordinary conversation never grows a second pill — and it
does not even poll while hidden.

## What it does not do

- **It never writes.** The Host half imports `node:fs/promises` for `readFile` and `readdir`
  and holds no write path — Trellis data cannot be modified by this plugin, and the self-check
  asserts it, including a before/after hash comparison of a workspace's `.trellis/`.
- It does not start, switch or archive tasks; that stays `task.py`'s job. The dropdown is a view,
  not a control — its rows are not clickable.
- It only *scans* for `in_progress` and `planning` tasks, so a task sitting in `review` is not
  proposed by the workspace scan — widen `RUNNING_STATUSES` in `lib/index.js` if that state should
  count. The session pointer is authoritative and unfiltered, so a pointed-at `review` task does
  display, with its own word (`审核中` / `in review`).
- It shows nothing in the new-session view if the composer's geometry cannot be measured (see
  [Where it appears](#where-it-appears)) — a reshape of that layout costs the hero pill rather
  than drawing it in the wrong place.
- It does not repeat what dsh already shows (model, tokens, elapsed time).

## Install

```bash
dsh plugin --profile web add <path-to-this-directory>
dsh --profile web --dump-config | grep trellis-statusline
```

Restart dsh to load it. The bundle patch widens the shipped `connection` row's `inject` to
`[webRuntime, webServer]` — without `webServer`, `connection.rpc.handle` cannot register the
channel as a web route and throws. That override is the same value
`dsh-plugin-ollama-usage` writes, so installing both stays idempotent.

Remove it with:

```bash
dsh plugin --profile web remove dsh-plugin-trellis-statusline
```

The plugin stores nothing and has nothing to configure, so uninstalling needs no cleanup.

## Verify

```bash
node --check lib/index.js && node --check lib/client.js   # both halves parse
npm test                                                  # 192 assertions, four harnesses
```

The harnesses live in the repository, not in the published npm tarball — `files` ships only
`lib`, the patch, this README and the licence — so run `npm test` from a checkout.

| Harness | Covers |
|---|---|
| `test/host.test.mjs` | the four-step resolution against throwaway workspaces — pointer first (and unfiltered), scan fallback, rank and tie-break, "never started ⇒ not a candidate" with an A/B on the single `branch` field, `tasks/archive` skipped — plus **every row of the tree table above**, an exact-shape assertion on the tree payload, and a before/after hash comparison (on both a plain and a tree workspace) proving a read leaves `.trellis/` byte-identical |
| `test/client.test.mjs` | bundle id = package name, only `react` required, **both** seats (slot key vs cell id vs order, for header and dock), the locale namespace handed to both, stylesheet lifecycle and its rounded/tinted/dock/dropdown rules, a refused locale namespace degrading to the local dictionaries, cross-half channel/endpoint agreement |
| `test/cell.test.mjs` | the real cells under a minimal hook runtime — all three pill forms with no `›` anywhere, a stand-alone task rendering no button/role/chevron, the dropdown's rows, depths, indentation and single highlight, all three dismissal routes (re-click, Escape, outside pointer), session switch closing it, untrusted trees degrading to the plain pill, the Hero cell appearing only for a blank session (and not polling when hidden), its measured position under the composer with the pill hidden until the layout can be measured, viewport-listener release on unmount, a seat without `useSessions` degrading instead of throwing, and unmount releasing both the interval and the document listeners |
| `test/integration.test.mjs` | the two halves **against each other**: the real Host half reads a real `.trellis` tree on disk and that exact reply is fed to the real cell, so a wire-shape drift fails here even while both unit harnesses still pass |

To see a task tree without inventing much, hang the task you are on under a throwaway parent.
The pill picks it up within one poll, so this needs no restart:

```bash
python ./.trellis/scripts/task.py create "Tree demo" --slug tree-demo --no-start
python ./.trellis/scripts/task.py add-subtask tree-demo <your-task-dir-name>
# the pill now reads:  [P2] <your task> · 进行中 · 子任务   (the role chip says it is in a tree)
# undo:
python ./.trellis/scripts/task.py remove-subtask tree-demo <your-task-dir-name>
python ./.trellis/scripts/task.py archive tree-demo --skip-branch-validation
```

Both the parent and the child argument accept a **bare task name**: `tree-demo` resolves to the
`MM-DD-tree-demo` directory by suffix match, and an ambiguous suffix is a hard error rather than a
coin flip (`task_utils.py:59`). That matters because the obvious alternative — a glob such as
`$(ls -d .trellis/tasks/*tree-demo)` — is shell-specific and breaks in PowerShell, where `ls` is
`Get-ChildItem`, `-d` prefix-binds to `-Depth`, and the glob is then parsed as an integer.

`--no-start` keeps `task.py create` from claiming the session pointer, so the demo parent never
becomes the active task; `--skip-branch-validation` is needed at archive time because a task that
was never started has no `branch` recorded.

Without a browser, the channel answers at `POST {channel}/{endpoint}`:

```bash
curl -s -X POST http://127.0.0.1:3080/trellis-statusline/task/read \
  -H 'content-type: application/json' -b "dsh=<cookie value>" \
  -d '{"type":"client-request","rpcId":"1","method":"task/read","payload":{"sessionId":"session-<uuid>"}}'
# {"type":"server-response","rpcId":"1","result":{"ok":true,"value":{"status":"ok","task":{…}}}}
```

Two things to know about that call. The cookie is the authority-bound session cookie the browser
received when it opened the URL `dsh web` printed, so `-b` has to carry the real value from
DevTools → Application → Cookies — the route rejects an unauthenticated request with 401 before it
reaches the plugin. And `result` is the envelope; `unknown-endpoint` for a wrong `method` is the
plugin's only loud protocol error.

In practice the pill itself is the proof: it is rendered from this channel, so a visible
`[P2] … · 进行中` in the header means session → cwd → pointer → scan and the RPC round trip all
worked. From the browser console the same call is simply:

```js
await fetch('/trellis-statusline/task/read', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: '1', method: 'task/read', payload: { sessionId: 'session-<uuid>' } }),
}).then((r) => r.json())
```

## Layout

| File | Role |
|---|---|
| `lib/index.js` | Host half — session → cwd → task, and the `/trellis-statusline` RPC channel |
| `lib/client.js` | Browser half — the module-loader bundle, the seat registration, the cell |
| `cordis.patch.yml` | the loader row, plus the `connection` inject widening |
| `package.json` | manifest: entry points, `dsh.bundle.patch`, `dsh.client` |
| `test/*.test.mjs` | the three dependency-free self-check harnesses |

No dependencies and no build step: the browser half is written directly in the form the shell
consumes, the Host half imports nothing beyond `node:` builtins, and `npm test` asserts both.
