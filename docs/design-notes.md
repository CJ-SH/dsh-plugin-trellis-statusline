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
  └─ nothing
```

The pointer is the **only** evidence. There is no workspace scan behind it, by decision — see
[Why the workspace scan was removed](#why-the-workspace-scan-was-removed-2026-09-17).

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
| pointer missing, other sessions' work present | the newest started running task (usually not this session's) | nothing |
| `trellis init` scaffolding only | nothing (the `branch` rule) | nothing |
| pointer stale / escaping / naming a corrupt file | the scan's best guess | nothing |

The alternatives to the scan were rejected on purpose: reading the live session's event stream or
decoding the session log are heuristics over dsh internals, they only work within one process
lifetime, and they read conversation content. The pointer is the one trustworthy, risk-free source
(decision D1=(a) in task `09-16-statusline-session-identity`).

`tasks/archive` is skipped explicitly, mirroring `task_store.py`'s own
`candidate.name == DIR_ARCHIVE` check rather than relying on archived tasks happening to live a
directory deeper.

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
| `shell.overlay` (id `trellis-statusline-hero`, order 1) | a **blank** session — the new-session view | measured and drawn centred just below the composer card |

### Trap 1: the header is hidden, not unmounted

In a new (blank) session the shell shows the Hero and applies
`.wSkVaW_headerHidden{display:none}` to the whole header block. The header cell therefore stays
**mounted** while invisible.

**Never detect the Hero with "is the header cell mounted?"** — a mount counter will conclude the
header is showing, forever. Read the flag the shell itself reads:

```js
useSessions((s) => s.byId[sessionId]?.blank)     // ConversationRoot's `summaryBlank`
```

A root-scoped seat has no `sessionId` prop, so it takes it from the same store
(`useSessions((s) => s.current)`). Each selector must return a **primitive**: one that builds a
fresh object defeats the store's reference comparison on every read.

Because the overlay is frame-wide, `blank` alone is not enough — a blank session stays blank while
Settings is open, and the pill would float over it. The second condition is
`usePanelInfo((s) => s.activePanelId) === null`, which is how `PanelInfo` spells "the Conversation
is displayed".

### Trap 2: read the render site, not the slot catalog

`conversation.composer.dock` is described in the slot catalog as "Ambient entries below the
composer card" — which reads as exactly the seat for a status line under the input. Its render
site gates it on `variant === "composer"`, and the Hero sets `variant === "hero"`, so it **never
renders there**. An implementation that trusts the description ships a feature that silently does
nothing. `conversation.input.dock` renders in both (gated only on `input`/`sessionId`).

The other candidates, for the record: `conversation.input.left`/`right` are inside the card;
`conversation.input.overlay` is an absolute anchor, not a row; and `conversation.composer.bar`,
`conversation.hero.brand.mark`, `conversation.hero.workspace` and `conversation.hero.agentPreset`
are `single` seats, so occupying them replaces shipped UI.

### Why the Hero pill is measured

The Hero's composer stack ends with the card:

```
composerStack            gap:8px; padding-bottom:32px; align-self:center
  ├─ HeroShell
  ├─ heroWorkspaceRow    (above the card)
  ├─ conversation.input.dock
  └─ inputBar = renderSlot("conversation.composer.bar")   ← the card is the last child
```

Nothing additive sits below the card, so the position has to be produced by measurement. The
technique is borrowed from the sibling `dsh-plugin-ollama-usage` (an unpublished companion plugin
in the same workspace, so the reference is provenance rather than a dependency):

- anchor with the **slot protocol's own marker**,
  `document.querySelector('[data-slot="conversation.composer.bar"]')`, never a product CSS class;
- a **zero-sized rect means a `display:contents` wrapper**, so keep descending a bounded depth
  instead of concluding "not found";
- measure relative to your own box — the overlay layer's origin is not the viewport;
- subtract the anchor's computed `padding-bottom` so the pill lands under the card's visible edge,
  not under a transparent band;
- centres on the card, which is that region's native alignment (the shipped ambient row under the
  composer is `align-items:center`);
- re-measure from a `ResizeObserver` on your parent and on the anchor, plus a viewport `resize`
  listener, and release them together.

**If the composer cannot be measured, nothing is drawn.** A reshaped composer should cost the Hero
pill, not misplace it.

One trap inside the trap: the wrapper cannot be measured before it exists, and its data arrives a
render later. An effect keyed only on "should this show" measures nothing on the first pass and
never tries again — the surface then stays hidden forever. Include "is there anything to draw" in
the dependencies.

### Click-through

`shell.overlay` is a click-through layer, so the entry keeps `pointer-events:none` and only the
child that draws opts back in with `pointer-events:auto`. A full-frame box there would swallow
every click in the application.

---

## 4. The route, and the fence in front of it

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

A browserless probe needs the browser's own cookie, because the fence runs first:

```bash
curl -s "http://127.0.0.1:3080/trellis-statusline/task/read?sessionId=session-<uuid>" \
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

`npm test` runs four dependency-free harnesses — 192 assertions. `test/integration.test.mjs` is the
one worth keeping even if the others are trimmed: the two unit harnesses each assert against a
*hand-written* idea of the other half's shapes, so a field rename on one side passes both while the
pill quietly stops rendering. It reads a real `.trellis` tree with the real Host half and feeds
that exact reply to the real cell.
