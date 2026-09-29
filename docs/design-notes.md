# Design notes

Why this plugin is built the way it is. The [README](../README.md) is for people who want to
install and use it; this file is for anyone changing it — every claim here was measured against a
running dsh, and the ones that cost real time are marked.

Most of this material lives in the repository because the alternative is rediscovering it: the
dsh internals it depends on are not part of any published contract, and two of them are
counter-intuitive enough that a reasonable implementation gets them backwards.

---

## 1. Resolving the task

### The chain

```
sessionId
  └─ cwd        ctx.sessions.get(id).header.cwd          (live session)
                ctx.workspaceRegistry.list()             (persisted session, canonical-cwd index)
  └─ pointer    <cwd>/.trellis/.runtime/sessions/dsh_<sessionId>.json  → current_task
  └─ count      <cwd>/.trellis/tasks/<dir>/task.json            → how many tasks there are
  └─ nothing
```

The pointer is the **only** source of a **task title**; there is no workspace scan behind it, by
decision — see [Why the workspace scan was removed](#why-the-workspace-scan-was-removed-2026-09-17).
A session the pointer does not name gets the workspace's activity **count** instead, never a title —
see [The workspace count](#the-workspace-count-2026-09-20).

Both cwd sources are synchronous, and both were confirmed in a live dsh process: for the same
session they returned the same workspace path. The registry matters because it also covers
sessions that are no longer live — a closed session still resolves to its workspace.

### Why the workspace scan was removed (2026-09-17)

An earlier version fell back to scanning `<cwd>/.trellis/tasks/<dir>/task.json` — `in_progress`
before `planning`, the lexicographically greatest `MM-DD-` name winning ties, and a required
`branch` to filter out `trellis init`'s scaffolding task. (`trellis init` creates
`Bootstrap Guidelines` at `status: in_progress` with `branch: null` and never moves it on; four of
five real workspaces on the development machine still carried exactly that task. `task.py start`
flips `planning → in_progress`, records the checked-out branch **and** writes the pointer, so a
recorded `branch` was a decent proxy for "some session started this task".)

That rule fixed the scaffolding false positive but could not answer the question the pill asks,
because a scan has no idea *which* session is working on what. In the reported incident one
workspace held three dsh sessions on three different tasks, and all three were shown the same
`in_progress` task — the only one with a branch — labelled 父任务. Two sessions saw a task that was
not theirs, and their own subtasks never appeared.

Trellis itself never scans `tasks/`: `resolve_active_task()` reads only the session pointer, and
`task.py current --source` answers `none` in exactly the states where the scan used to guess. The
plugin now does the same:

| Workspace state | Before | Now |
|---|---|---|
| a pointer naming a real task | that task | unchanged |
| pointer missing, other sessions' work present | the newest started running task (usually not this session's) | the workspace **count** |
| `trellis init` scaffolding only | nothing (the `branch` rule) | nothing (the count is 0) |
| pointer stale / escaping / naming a corrupt file | the scan's best guess | the workspace **count** |

The alternatives to the scan were rejected on purpose: reading the live session's event stream or
decoding the session log are heuristics over dsh internals, they only work within one process
lifetime, and they read conversation content. The pointer is the one trustworthy, risk-free source
(decision D1=(a) in task `09-16-statusline-session-identity`).

`tasks/archive` is skipped explicitly, mirroring `task_store.py`'s own
`candidate.name == DIR_ARCHIVE` check rather than relying on archived tasks happening to live a
directory deeper.

### The workspace count (2026-09-20)

A pill that shows nothing at all in a brand-new session turned out to be its own failure mode: the
workspace's work is invisible exactly where a user starts looking. The fix keeps the title rule and
adds the one thing a title-less session can honestly say — how many tasks the workspace holds
(decision D1 = A in task `09-20-new-session-workspace-task`):

- the reply grows a third shape, `{ status: 'workspace', activeTasks }`, which by construction
  carries **no** `task`/`title` field — that is what makes "another session's task shown as mine"
  impossible rather than merely unlikely;
- the count is the same number Claude Code's statusline prints as `N task(s)`; its
  `_count_active_tasks` (`.claude/hooks/statusline.py`) counts every non-`archive` directory that
  holds a `task.json`;
- two deliberate differences: this count requires that file to parse and carry a status, and it
  subtracts `trellis init`'s scaffolding task (`00-bootstrap-guidelines`, never started) — counted
  work should be work someone is doing. A task carrying the scaffold's name but *with* a recorded
  `branch` is real work and stays counted, so the rule cannot hide an in-progress task;
- `0` is not a count: it degrades to the old `none` reply and the cell draws nothing;
- the pill **leads with a glyph** (R6, user instruction 2026-09-20): an inline 14×14 list-checks svg on
  the platform's figma artboard (`stroke:currentColor`, `aria-hidden`, `focusable="false"`, fixed 14×14
  `flex:none` box). It is decoration: no handler, no tab stop, so the "not clickable, not a title"
  contract is intact. The sibling `ollama-usage` pill solves the same slot with a CSS dot
  (`14px` grid + `7px` `border-radius:50%` `i`); a dot was rejected here because a bare dot reads as a
  status light rather than as "tasks", while the stroke glyph carries the meaning and matches the
  official status glyphs' icon language.

Claude Code's statusline itself never names a task it does not own — a fresh session there shows
only the count — which is why this shape is the one the option list settled on.

---

## 2. The task tree

Roles are deliberately limited to two: the tree's **top ancestor** is the only 父任务, and every
other member — grandchildren included — is a 子任务. Depth therefore never changes the wording, and
the dropdown owns the actual structure.

The tree is derived from the **active** task set (skipping `archive`), with no status or branch
filter: a tree that hid its `completed` or never-started members would misrepresent the structure it
exists to show, and `task.py list` walks the same unfiltered set.

### Deriving links

Each node gets at most one parent, so the result is a forest and no outcome depends on traversal
order. The parent is chosen in three steps:

1. the node's own `parent`, when it names an active task;
2. otherwise the **one** active task that names it in `children`;
3. otherwise no parent.

Step 2 exists because Trellis' own bidirectional link can be left half-written — it prints
`Link is half-written: <parent> now lists '<child>' as a child, but the new task does not record
its parent` when the second write fails. Step 3 covers a dangling `parent` (target archived or
renamed), which is how `task.py list` renders orphans too.

`childNames` reads `children` **and** its legacy spelling `subtasks`, which `task_store.py`
rewrites precisely because older `task.json` files still carry it.

The upward walk is bounded (64 hops, visited set) so a hand-edited parent cycle terminates instead
of hanging the poll.

### Edge cases, all pinned by tests

| Case | Behaviour |
|---|---|
| a `completed`, or never-started, sibling | shows in the tree |
| a half-written link | still attached |
| a dangling `parent` | the task becomes its own root |
| archived children still named in `children` | left out; `children` is a historical list, and `task.py list` skips them too |
| the legacy `subtasks` spelling | still read |
| a parent cycle | terminates at the hop ceiling |
| a corrupt node | drops out with its subtree; its siblings still render |
| a tree that does not contain the task it describes | dropped, degrading to the plain pill |

### Titles

The pill truncates a title at 48 characters; tree rows do not. The pill is one line in a header
and has to stay short, while a dropdown row has room and relies on CSS ellipsis — cutting it at 48
would hide the part that tells two similar titles apart, in the one place the user opened to tell
them apart.

---

## 3. Seats, and the two traps in picking them

| Seat | When it shows | How it is placed |
|---|---|---|
| `conversation.session.header.actions` (id `trellis-statusline`, order 10) | an ordinary session | the header's title-adjacent action, laid out by the shell |
| `conversation.input.dock` (id `trellis-statusline-dock`, order 30) | a **blank** session — the new-session view | a flow row of the composer stack, directly above the input card |

### Trap 1: the header is hidden, not unmounted

In a new (blank) session the shell shows the Hero and applies
`.wSkVaW_headerHidden{display:none}` to the whole header block. The header cell therefore stays
**mounted** while invisible.

**Never detect the Hero with "is the header cell mounted?"** — a mount counter will conclude the
header is showing, forever. Read the flag the shell itself reads:

```js
useSessions((s) => s.byId[sessionId]?.blank)     // ConversationRoot's `summaryBlank`
```

Each selector must return a **primitive**: one that builds a fresh object defeats the store's
reference comparison on every read.

### Trap 2: read the render site, not the slot catalog

`conversation.composer.dock` is described in the slot catalog as "Ambient entries below the
composer card" — which reads as exactly the seat for a status line under the input. Its render
site gates it on `variant === "composer"`, and the Hero sets `variant === "hero"`, so it **never
renders there** (`dsh-client-ui-conversation/lib/client.js:16259`). An implementation that trusts
the description ships a feature that silently does nothing.

`conversation.input.dock` renders in both states (gated only on `input`/`sessionId`), which is why
the pill lives there — above the card rather than below it. The other candidates, for the record:
`conversation.input.left`/`right` are inside the card; `conversation.input.overlay` is an absolute
anchor, not a row; and `conversation.composer.bar`, `conversation.hero.brand.mark`,
`conversation.hero.workspace` and `conversation.hero.agentPreset` are `single` seats, so
occupying them replaces shipped UI.

### Why the seat left `shell.overlay` (2026-09-20)

The first version drew the new-session pill in the frame-wide `shell.overlay`, positioned by
measuring the composer card. It worked, but that layer is shared and **unmanaged**: the sibling
`dsh-plugin-ollama-usage` anchors its own hero pill there, and the two landed 13px apart — our gap
6 against its gap 8 plus a half-height offset — so they overlapped by ~40 % of a pill's height
instead of stacking. Nothing in the shell arranges overlay entries: `dsh-client-ui-layout` renders
them into a plain `overlayLayer` div and every cell owns its own coordinates. Coexistence would
have to be negotiated between plugins, or designed out.

It was designed out. A flow row cannot collide with anything, and the seat is conversation-scoped
by construction, so the old "do not float over Settings" `activePanelId` check is gone with it.
The cost is the position: above the card instead of below it.

### One line, not two (2026-09-20, later the same day)

Both surfaces moved into `conversation.input.dock`, and that seat's contract is "full-width
entries above the composer card" — each entry is a direct child of the composer's **column** stack,
because the seat anchor renders `<div data-slot="conversation.input.dock" style="display:contents">`
and a `list` seat's entries are a Fragment inside it. Two compact pills therefore landed on two
rows.

To share one line the anchor itself has to become the row:

```css
[data-slot="conversation.input.dock"]{display:flex !important;flex-flow:row wrap;justify-content:center;align-items:center;gap:var(--dsh-composer-stack-gap,6px)}
```

- **`!important` is not optional**: the shell sets `display:contents` *inline*, and an inline
  declaration beats any author rule that is not `!important`.
- It is safe for the seat's shipped occupants because they are full-width
  (`width:calc(100% - …)`): a full-width item wraps onto a line of its own, so the queue, todo and
  goal panels are unchanged, and the gap keeps the stack's own spacing variable.
- Both plugins inject this identical rule, so either one alone still lays out sensibly.

### A seat is a declaration *lifetime*, not a promise (2026-09-29)

The seats above belong to another bundle, so the plugin's registration is conditional on a
declaration that may never come, may collapse, and may come back. `ctx.slots.inject(key, callback)`
is the whole mechanism, and its contract is narrower than "wait for the seat":

- the callback runs **synchronously** when the declaration already exists, and **inside the
  declaring `register()`** when it arrives later;
- collapsing the declaration **disposes** what the callback returned, and a later declaration runs
  the callback again;
- `slots.register` **throws** for a slot nobody declared
  (`dsh-client-ui-slots/lib/index.js:163-165`).

Two consequences that a harness has to model, because both were once silently wrong here:

1. **The failure mode of a moved seat is an absent cell, and nothing else.** No error reaches the
   plugin, no cell renders, and a test that calls the callback immediately will report a healthy
   plugin. The three client-side harnesses therefore carry a slot registry that models the
   lifetime — declare, wait, collapse, re-declare — and the two assertions that would go red on a
   renamed seat are `every seat the plugin joins is a seat the shell declared` (client) and
   `the cell came from the header seat declaration` (integration). Both were checked by
   falsification: renaming `SEAT` in `lib/client.js` turns three harnesses red and leaves the
   Host harness green, which is the correct split.
2. **A cell is not a durable registration.** A plugin reload disposes the first fiber's cells
   before the second mounts, and the real registry refuses a duplicate `(name, id, priority)`, so
   a harness that mounts twice without unloading is modelling something that cannot happen — the
   client harness unloads explicitly and asserts both cells went with it.

### Traps that remain, for whoever touches this next

- **A blank bit is not an enable flag.** `useTaskPill(…, enabled)` stops polling without clearing
  its state, and the composer dock stays mounted when a blank session becomes active. Check the
  blank bit in the render path too, or a stale pill will sit beside the header pill the moment the
  first message is sent. `test/cell.test.mjs` pins exactly this.
- **The cell is session-scoped** — `sessionId` arrives from the standard kit, exactly as it does
  for the header seat — and it must **fail closed**: no `useSessions`, or a list state that does
  not know this session, means "draw nothing". A duplicate pill is worse than a missing one.

---

## 4. The routes, and the fence in front of them

The two halves talk over one route the Host half owns on the composition's `webServer`:

```jsonc
// GET /trellis-statusline/task/read?sessionId=session-<uuid>
// → 200 { "ok": true, "value": {
//      "status": "ok",
//      "task": { "id", "title", "status", "priority"? },       // pill projection, title capped at 48
//      "tree": {                                               // omitted when the task stands alone
//        "id", "title", "status", "priority"?, "current"?,     // the root = the only parent task
//        "children"?: [ … same shape, recursively … ]
//      }
//   } }
```

`current: true` marks only the session's own task; every other row omits the field rather than
sending `false`. The handler runs four steps, and the order is the design:

1. **The fence.** `ctx.connection.requestRejection(req)` owns the Host/Origin check (403) and the
   browser-session cookie gate (401); its answer is written verbatim and the handler stops. A
   composition without that seam gets `503` instead, because `webServer` itself carries no
   authentication (its documented contract) and a route that cannot authenticate must not serve
   workspace data.
2. **The method.** `GET` only; anything else is `405` with `Allow: GET`.
3. **The query.** `sessionId` must be a non-empty string of at most 128 characters; otherwise
   `400` in the same envelope, so the browser half's decode logic stays one shape.
4. **The read.** The session → cwd → pointer → tree chain above.

The envelope is deliberately the one the connection service used to carry, and every answer is
`cache-control: no-store` — a session's task is a live fact, not a cached one.

### The second route: the status surface another bundle reads

The management hub's status area has to answer "did this plugin resolve an active Trellis task?"
for a session it does not own, and it must do that **without importing this package** — so the
answer is a route, not an export:

```jsonc
// GET /trellis-statusline/status/read                      → 200 { ok: true, value: { plugin, status: "unscoped" } }
// GET /trellis-statusline/status/read?sessionId=session-<uuid>
// → 200 { "ok": true, "value": {
//      "plugin": "dsh-plugin-trellis-statusline",   // who answered — a 404 means nobody is home
//      "status": "ok" | "workspace" | "none" | "unscoped",
//      "active": true,                              // present only when a session was asked about
//      "taskId"?, "taskStatus"?,                    // status: "ok"
//      "activeTasks"?                               // status: "workspace", the pill's own count
//   } }
```

Three decisions in that shape are load-bearing:

- **A second endpoint, not a mode of the first.** The pill's reply exists to be rendered as a
  pill: it carries the task title and the whole tree. A status row is a *light*, and a surface
  that can never receive a title cannot render one by accident — so the "a session only ever sees
  the title its own pointer names" rule (prd.md R1/R2) cannot be weakened by a consumer this
  plugin does not control. The suite asserts the *bytes*, not the intent: the pointed-at title
  must not appear anywhere in a status reply.
- **Same chain, not a copy of it.** Both handlers call the same `readTask`, because a second
  implementation of "which task is this session on" is exactly the thing that would drift — and
  then the hub would disagree with the pill about the session the user is looking at. Two
  assertions pin the agreement (the `ok` case and the count case).
- **`sessionId` is optional here.** A Settings page has no session to report on (the
  `settings.section` owner props carry only `close`), and that is an answer, not an error:
  `unscoped` still proves the plugin is mounted and answering, which is the hub's other need. An
  *unusable* id is still refused — a typo must not read as "nothing to report" — and `active` is
  omitted rather than sent as `false`, the same convention the tree uses for `current`.

Both routes live behind the fence, both are `exact` (so a request for a path this plugin does not
own falls through to the shell's 404 seat instead of being interpreted), and each is registered in
its own `ctx.effect` with its own guard: a duplicate `(kind, path)` degrades **one** surface and
logs it, rather than silently taking the other down with it.

A browserless probe needs the browser's own cookie, because the fence runs first:

```bash
curl -s "http://127.0.0.1:3080/trellis-statusline/task/read?sessionId=session-<uuid>" \
  -H 'accept: application/json' -b "dsh=<cookie value>"
curl -s "http://127.0.0.1:3080/trellis-statusline/status/read" \
  -H 'accept: application/json' -b "dsh=<cookie value>"
```

The cookie is authority-bound and signed with a per-activation secret, so it has to come from
DevTools → Application → Cookies. From the browser console the same call is simply:

```js
await fetch('/trellis-statusline/task/read?sessionId=session-<uuid>', {
  headers: { accept: 'application/json' },
}).then((r) => r.json())
```

**Why not `connection.rpc.handle`.** That is the shape this plugin used first, and it works — but
it registers the physical route on the *connection row's* context, so the shipped row has to inject
`webServer` first: the bundle had to restate that row's whole `inject` list, and any later patch
layer writing a different list for the same row would take the channel away with no error at all
(the symptom is just an absent pill). `requestRejection` gives the identical fence without
borrowing a row that is not ours; the shipped `dsh-host-open-in-app` registers raw routes the same
way. The typed alternative — a Typert Remote — needs generated invocation descriptors, and this
plugin is deliberately dependency-free and buildless.

In practice the pill is its own proof: it is rendered from this route, so a visible pill means
session → cwd → pointer and the fence all worked.

---

## 5. Read-only, by construction

The Host half imports `node:fs/promises` for `readFile` and `readdir` and holds **no write path** at
all — it cannot modify Trellis data even by accident. The self-check asserts this twice: the source
is scanned for write APIs, and a before/after comparison of a workspace's `.trellis/` (file list,
mtime, size and content hash) proves that running the whole read path leaves it byte-identical.
That comparison runs against both a plain workspace and a tree workspace, since building a tree
reads every `task.json`.

The known bound: building a tree reads every active `task.json` on every 10 s poll. The largest
real workspace measured here holds 40 tasks, where that is negligible; a workspace with thousands
would want a node ceiling that skips tree building.

## 6. Verification

`npm test` runs four dependency-free harnesses — 254 assertions. `test/integration.test.mjs` is the
one worth keeping even if the others are trimmed: the two unit harnesses each assert against a
*hand-written* idea of the other half's shapes, so a field rename on one side passes both while the
pill quietly stops rendering. It reads a real `.trellis` tree with the real Host half and feeds
that exact reply to the real cell.

### A green suite is not evidence until it can go red (2026-09-29)

This package's suite was green while three sibling plugins in the same workspace were dead on the
runtime — the shared cause was harness fakes that were *more permissive than the real service*.
Two rules follow, and both are now enforced here:

- **A fake may not be kinder than the real thing.** The slot registry's callback is not invoked
  immediately, `register` refuses an undeclared seat, and a route handler is addressed by path
  rather than "the last one registered" — each of those was the exact gap that hid a real failure.
- **Every anti-false-green assertion gets a falsification run.** Measured, not asserted:

  | Broken on purpose | Observed |
  |---|---|
  | `SEAT` renamed in `lib/client.js` | `client.test.mjs` 4 named FAILs, `cell.test.mjs` 2, `integration.test.mjs` 1; exit 1 in all three |
  | a `title` added to the status value | `host.test.mjs` 3 FAILs, including `no title can travel on the status surface` |
  | the peer range changed to `^0.2.0` | `client.test.mjs` FAIL — and the real startup gate denies that range (`dsh-app-boot` `evaluatePluginCompatibility`) |

  The peer range itself was checked against that same real function: `^0.2.0-rc.1` is accepted on
  `0.2.0-rc.1`, while `^0.2.0`, `^0.1.5-rc.1` and an empty string are denied — prereleases only
  participate because the gate passes `includePrerelease: true`, so the caret *must* be written
  against the prerelease itself.

---

## 7. Packaging: the two manifest facts that fail silently

**The peer range is the upgrade guard, and writing it the obvious way disables the plugin.**
`@deepseek-ai/dsh-app-boot` evaluates every declared `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
peer against the *running* version and **denies the row** when a range does not satisfy it
(`lib/index.js:286-313`); a package with no `peerDependencies` at all is skipped early and never
checked — which is how a plugin can be "installed, enabled, and dead" with no diagnostic in the
UI. `semver.satisfies` runs with `includePrerelease: true`, so `0.2.0-rc.1` lies inside
`^0.2.0-rc.1` but **not** inside `^0.2.0`: the caret has to be written against the prerelease, and
that is not a style choice. One peer is enough — the runtime check compares versions, and
non-`@deepseek-ai` peers (the bundle's `react` baseline, for instance) are not gated at all. This
plugin imports no `@deepseek-ai/*` module, so `@deepseek-ai/dsh` is the only entry it declares.

**Display text lives in `locale/*.json`, not in a manifest `meta`.** The reader
(`dsh-app-boot/lib/index.js:1860-1999`) resolves `<pkg>/locale/en.json` **through Node's ESM
resolver** and reads `meta.title` / `meta.description` from every `*.json` beside it, using the
manifest's `name`/`description` only as the fallback — so:

- each locale file is `{ "meta": { "title": …, "description": … } }`, and the shell's own packages
  are the reference (`dsh-client-ui-schedule/locale/en.json`);
- `exports` must list `"./locale/*.json"`, because an unlisted subpath is unreachable, not merely
  undocumented — the localised title would silently fall back to the package name;
- `icon` is read straight from the manifest directory instead, so it needs no `exports` entry, but
  it must be relative, inside that directory, `.svg`/`.png`/`.jpg`/`.webp`, and at most 256 KiB;
- both belong in `files`, or a published tarball ships without them.

The failure mode of all of the above is a card with no title and the default artwork — never an
error, which is why the client harness asserts the shape, the exports entry and the `files` entry,
and the icon's size on disk.


