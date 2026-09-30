# dsh-plugin-trellis-statusline

[English](README.md) | 中文

Show the active [Trellis](https://github.com/mindfold-ai/Trellis) task of the current workspace in the [dsh](https://github.com/deepseek-ai/deepseek-harness) web chat — the job the Claude Code `statusline.py` hook does in a terminal, and a statusline dsh's web shell does not have.

## Features

- **Session header**: a persistent task pill to the right of the session-preset selector.
- **New-session view**: before the first message has been sent, the pill appears in the composer's dock line just above the input card, sharing that line with the usage pill.
- The pill reads `[priority] title · status`, and marks the task's role in the task tree (parent task / subtask).
- When the task belongs to a tree the pill is clickable; the dropdown shows the tree indented in its real shape and highlights the session's task.
- Read-only: it never writes to Trellis and never starts, switches or archives a task; when the workspace holds no task it shows nothing.
- A session without a task of its own shows the workspace's active-task **count** — never another session's task.

## Install

### From GitHub (recommended)

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-trellis-statusline
```

### From a local directory

```bash
git clone https://github.com/CJ-SH/dsh-plugin-trellis-statusline
dsh plugin --profile web add ./dsh-plugin-trellis-statusline
```

**Restart dsh** after installing — a plugin is loaded at boot, and the restart ends any running agent process, so run it yourself. No configuration is needed.

## Usage

The pill sits in the session header (right of the session-preset selector), or in the dock line just above the input card for a new session. Four shapes:

```
[P2] Add the importer · 进行中
[P1] Release 0.2 · 进行中 · 父任务
[P2] Wire the importer · 进行中 · 子任务
工作区 3 个活动任务
```

- Stand-alone task: `[P2] Title · 进行中` — no role, no click target, no tab stop.
- Root of the task tree: `[P1] Title · 进行中 · 父任务`; every other member of the tree, grandchildren included: `... · 子任务`.
- Session has no task of its own but the workspace does: `工作区 N 个活动任务`, led by a single list icon — no title, no role.

The display refreshes every 10 s, and immediately when you switch sessions, so `task.py start` / `task.py archive` shows up within one poll.

Configuration: none. The plugin reads the session it is rendered in and holds no settings.

## Uninstall

```bash
dsh plugin --profile web remove dsh-plugin-trellis-statusline
```

It stores nothing, so uninstalling needs no cleanup.

## Technical notes

- Needs dsh `0.2.0-rc.1` or a later `0.2.x`, with the `web` profile; on a version mismatch the row is denied at startup with a message, rather than loading a plugin whose seats have moved.
- Needs Node `^22.19.0 || >=24.0.0`.
- Needs a Trellis-managed workspace: run `trellis init --dsh` in it, and the session's working directory contains `.trellis/`, which is all this plugin reads.
- No Python and no `trellis` CLI at runtime — it only reads the JSON Trellis writes.
- The pill's title is truncated to 48 characters, while the rows in the task-tree dropdown are not; the seats it attaches to are dsh internals, so a dsh upgrade may move them.

## Further reading

Contracts, troubleshooting and internal structure live in [docs/design-notes.md](docs/design-notes.md).

## License

MIT © 2026 HenTaiCJN
