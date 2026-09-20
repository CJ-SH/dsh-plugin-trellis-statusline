# dsh-plugin-trellis-statusline

Show the active [Trellis](https://github.com/mindfold-ai/Trellis) task of the current workspace in
the [dsh](https://github.com/deepseek-ai/deepseek-harness) web chat — the job the Claude Code
`statusline.py` hook does in a terminal, and a statusline dsh's web shell does not have.

This one is a *statusline*: a single compact pill, always visible, in the chat you are already
looking at.

```
[P2] Add the importer · 进行中
[P1] Release 0.2 · 进行中 · 父任务
[P2] Wire the importer · 进行中 · 子任务
工作区 3 个活动任务
```

<!-- A screenshot is the single most valuable thing this README is missing. Drop one in and
     uncomment:
![The pill in the session header, and the task tree dropdown](docs/pill.png)
-->

## What it is

Trellis keeps each piece of work as a **task** under `.trellis/tasks/` and records which one a
session is on. dsh's web shell shows the workspace and the model, but not the task — so you have to
switch back to a terminal, or ask the agent, to find out what you are actually working on.

This plugin puts that fact in the chat:

- **the session header**, right of the session-preset selector, as a compact pill;
- **the new-session view**, for a session whose first message has not been sent yet — in the
  composer's dock line just above the input card, sharing that line with the usage pill.

It is a pure read: it never writes to Trellis, starts or archives nothing, and shows nothing at all
when the workspace holds no task. A session that has no Trellis task of its own shows the
workspace's activity **count** instead — never another session's task.

## Requirements

| | |
|---|---|
| **dsh** | with the `web` profile. Verified against `0.1.5-rc.2`; the seats it attaches to are internal, so a dsh upgrade may move them — see [Troubleshooting](#troubleshooting) |
| **Node** | `^22.19.0 \|\| >=24.0.0` |
| **A Trellis-managed workspace** | dsh is Trellis' 22nd supported platform — run `trellis init --dsh` in the workspace ([Trellis docs](https://docs.trytrellis.app/advanced/multi-platform)). The session's working directory then contains `.trellis/`, which is all this plugin reads |

It needs **no Python and no `trellis` CLI at runtime**. Unlike plugins that drive `task.py`, this one
only reads the JSON Trellis writes.

## Install

This package is a dsh **bundle**: it declares `dsh.bundle` with a `cordis.patch.yml`, and installing
it appends the bundle to the profile and applies its patch layer
([official guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)).

From npm — **not published yet**, this is the command once it is:

```bash
dsh plugin --profile web add dsh-plugin-trellis-statusline
```

Today, install straight from the repository. Either a clone:

```bash
git clone https://github.com/CJ-SH/dsh-plugin-trellis-statusline
dsh plugin --profile web add ./dsh-plugin-trellis-statusline
```

…or the git URL, which needs no clone of your own:

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-trellis-statusline
```

The git route works here without the usual `prepare` script and `allowBuilds` allowance, because
there is nothing to build: `lib/` is plain JavaScript committed to the repository, so a git install
already fetches runnable artifacts. A plugin written in TypeScript would need both, and the
allowance is permission to run its code on your machine at install time — see
[the official note](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish).

Then check the row landed and **restart dsh** — loading a plugin happens at boot, and the restart
ends any agent process, so run it yourself:

```bash
dsh --profile web --dump-config | grep trellis-statusline
```

A working install needs no configuration: the plugin reads the session it is rendered in and holds
no settings.

### Uninstall

```bash
dsh plugin --profile web remove dsh-plugin-trellis-statusline
```

It stores nothing, so uninstalling needs no cleanup.

### No other bundle's row is touched

The patch inserts one loader row and nothing else. The Host half registers its own route on the
composition's `webServer` and asks `connection` for the trust fence before every answer
(`requestRejection` → `401`/`403`, and `503` when that seam is missing) — the same shape the
shipped `dsh-host-open-in-app` uses.

An earlier version widened the shipped `connection` row's `inject` instead. That is what
`connection.rpc.handle` needs — it registers its physical route on *that* row's context — and it
made this plugin's availability depend on a piece of another bundle's configuration and on layer
order. Owning the route removes the coupling: nothing here can be silently taken away by a patch
collision.

## What you will see

The pill reads `[priority] title · status`. Four shapes:

| The session | The pill reads |
|---|---|
| is on a stand-alone task | `[P2] Title · 进行中` — no role, no click target, no tab stop |
| is on the tree's root | `[P1] Title · 进行中 · 父任务` |
| is on any other member of the tree | `[P2] Title · 进行中 · 子任务` |
| has no task of its own, but the workspace does | `工作区 3 个活动任务` led by a 14×14 list-checks glyph — no title, no role, no click target | |

**Only two roles exist.** The tree's top ancestor is the one and only 父任务; every other member —
grandchildren included — is a 子任务. Depth never changes the wording, so a deep tree stays
readable.

**When the task is in a tree the pill becomes clickable.** The dropdown shows the real structure
(one indent level per depth, with a guide line) and highlights the session's task. A stand-alone
task is not clickable at all — no button, no focus ring, no tab stop.

The display refreshes every 10 s, and immediately when the header switches to another session, so a
`task.py start` or `task.py archive` shows up within one poll.

## Where the task comes from

1. **The session's working directory** — from the live session's own header, or from the workspace
   registry, which also covers sessions that are no longer live.
2. **The session pointer** — `.trellis/.runtime/sessions/dsh_<sessionId>.json`, which
   `task.py create` / `task.py start` writes. It is the **only** source of a title, and what it
   names is shown whatever its status or branch.
3. **The workspace count** — when no pointer names a task, every non-`archive`
   `.trellis/tasks/<dir>/task.json` is counted (minus `trellis init`'s never-started
   `00-bootstrap-guidelines` scaffolding task). The reply carries **no title**, and the pill says
   `工作区 N 个活动任务`. This is the same number Claude Code's statusline prints as `N task(s)`;
   it is the only honest thing to say about a session that has not started a task yet. A count of 0
   shows nothing.

It does not fall back to scanning `.trellis/tasks/` for a *title*: a scan cannot tell which session
is working on which task. In the reported bug one workspace held three dsh sessions, each on a
different task, and all three were shown the same task as 父任务. It does not infer a task from the
conversation or from the session log either. See
[design notes](./docs/design-notes.md#1-resolving-the-task).

## What it does not do

- **It never writes.** The Host half imports `node:fs/promises` for `readFile` and `readdir` and
  holds no write path at all; the self-check proves a full read leaves `.trellis/` byte-identical.
- It does not start, switch or archive tasks — that stays `task.py`'s job. The dropdown is a view,
  not a control: its rows are not clickable.
- It does not repeat what dsh already shows (model, tokens, elapsed time).
- It does not guess. A session without a pointer gets no task name at all — only the
  workspace count — and no placeholder or "best effort" title ever appears — see
  [Where the task comes from](#where-the-task-comes-from).

## Troubleshooting

**Nothing appears at all.** In order of likelihood: the workspace has no `.trellis/` or holds no
task; no `dsh_<sessionId>.json` pointer was written for *this* session, which `task.py create` /
`task.py start` writes — in that case you should be seeing the workspace **count** instead (see
[Where the task comes from](#where-the-task-comes-from)); another bundle claims the exact route
`/trellis-statusline/task/read` (the Host logs `[trellis-statusline] route unavailable` at boot);
or a dsh upgrade moved the seats. The plugin never shows a placeholder and never reports an error —
an absent pill *is* the failure mode, by design.

**It shows the wrong task.** Both sides read the same pointer, so start with
`python ./.trellis/scripts/task.py current --source`: the pill shows the task that file names. If
the file itself names the wrong task (next entry), that is Trellis state to fix, not the plugin's.

**A session that is working on a task shows only the count.** The session has no pointer. The
usual cause:
dsh was launched from inside another Trellis session — a Claude Code or Codex window, say — and
Trellis 0.6.15 inherited that session's `TRELLIS_CONTEXT_ID` and wrote the runtime pointer under the
*outer* context key (the general case is tracked upstream,
[`mindfold-ai/Trellis#549`](https://github.com/mindfold-ai/Trellis/issues/549); 0.6.15 fixed it for
dsh specifically). Unset `TRELLIS_CONTEXT_ID` before starting dsh, or run
`python ./.trellis/scripts/task.py start .trellis/tasks/<dir>` in the dsh session itself. A session
without a pointer shows the workspace count rather than another session's task.

**It appears in one session but not another.** That is the design: each session reports its own
working directory, so parallel sessions in different workspaces show different tasks.

## Development

No dependencies and no build step: the browser half is written directly in the form the shell
consumes, the Host half imports nothing beyond `node:` builtins, and the suite asserts both.

```bash
node --check lib/index.js && node --check lib/client.js   # both halves parse
npm test                                                  # 209 assertions, four harnesses
```

The harnesses live in the repository, not in the published tarball — `files` ships only `lib`, the
patch, the README, the design notes and the licence — so run `npm test` from a checkout.

| Harness | Covers |
|---|---|
| `test/host.test.mjs` | resolving the task against throwaway workspaces: the pointer as the only title, the workspace count for a session it does not name (scaffold subtracted, `archive` skipped, `0` degrading to `none`), every unusable-pointer state (missing, stale, escaping, corrupt), every tree case, and a before/after hash proof that a read never writes |
| `test/client.test.mjs` | the bundle contract: id, the `react`-only require, both seats (slot key vs cell id vs order), locale namespace, stylesheet lifecycle, cross-half constants |
| `test/cell.test.mjs` | the real cells under a minimal hook runtime: all three task pill shapes, the dropdown and its dismissal routes, the dock cell's blank-session gating (including the stale-state trap the move uncovered), the workspace-count pill, and listener/interval cleanup |
| `test/integration.test.mjs` | the two halves against each other — the real Host half reads a real `.trellis` tree and that exact reply is fed to the real cell, for both a pointed-at task and a pointer-less session (count pill with its decoration glyph, no role, no click target, nothing at all when the count is 0), so a wire-shape drift cannot pass unnoticed |

| File | Role |
|---|---|
| `lib/index.js` | Host half — session → cwd → task, and the `/trellis-statusline/task/read` route |
| `lib/client.js` | Browser half — the module-loader bundle, the seat registrations, the cell |
| `cordis.patch.yml` | the loader row; no other bundle's row is patched |
| `docs/design-notes.md` | why it works this way: the seats, the measurement, the derivation rules |

## License

[MIT](./LICENSE) © 2026 HenTaiCJN

[Trellis](https://github.com/mindfold-ai/Trellis) is a separate project by Mindfold LLC, licensed
AGPL-3.0-only. This plugin is not affiliated with it, and neither bundles nor derives from its
code: it reads the `.trellis/` files Trellis writes.
