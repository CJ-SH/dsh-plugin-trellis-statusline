/**
 * dsh-plugin-trellis-statusline — Host half.
 *
 * Answers exactly one question for the browser half: *which Trellis task is the session
 * `<sessionId>` working on?* The chain is session → workspace cwd → task, and every step is
 * decided in `design.md` §2.1/§2.2 against measurements taken on this machine:
 *
 * 1. `sessionId` is `session-<uuid>` — the same string as the on-disk session directory and
 *    as `DSH_SESSION_ID`, which is what `task.py start` used to name the runtime pointer.
 * 2. The cwd comes from the live session's immutable header, else from the workspace
 *    registry's canonical-cwd index (which also covers sessions that are no longer live).
 * 3. `<cwd>/.trellis/.runtime/sessions/dsh_<sessionId>.json` wins when it names a real task;
 *    otherwise every `<cwd>/.trellis/tasks/<dir>/task.json` is scanned for a running task.
 *
 * Read-only by construction: the only filesystem calls are `readFile` and `readdir`, so the
 * plugin cannot modify Trellis data even if it wanted to.
 *
 * Deliberately dependency-free: it imports no `@deepseek-ai/*` module.
 *
 * @module dsh-plugin-trellis-statusline
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

/** Stable plugin name (also the loader row's module id). */
export const name = 'dsh-plugin-trellis-statusline'

/** Private RPC channel between this half and the browser half. */
const CHANNEL = '/trellis-statusline'

/** The one endpoint the browser half calls. */
const ENDPOINT_READ = 'task/read'

/** Running statuses, best first — the order `.trellis/scripts/task.py` moves a task through. */
const RUNNING_STATUSES = ['in_progress', 'planning']

const TITLE_MAX = 48

const WORKFLOW_DIR = '.trellis'
const TASKS_DIR = 'tasks'
const RUNTIME_DIR = '.runtime'
const SESSIONS_DIR = 'sessions'

/**
 * `DIR_ARCHIVE` from `.trellis/scripts/common/task_store.py`, which skips this directory when
 * it walks tasks. Archived tasks also live one level deeper
 * (`tasks/archive/<month>/<task>`), so a scan that reads only the immediate children of
 * `tasks` already misses them — this makes the intent explicit instead of depending on that
 * directory layout.
 */
const ARCHIVE_DIR = 'archive'

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')

function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error'
  const message = error.message
  if (typeof message === 'string' && message.length > 0) return message
  return String(error)
}

/** `-1` for a status that is not running; otherwise its rank, best first. */
const statusRank = (status) => RUNNING_STATUSES.indexOf(status)

/**
 * `_sanitize_key` from `.trellis/scripts/common/active_task.py`, mirrored so this half builds
 * the same runtime key Trellis wrote: `[^A-Za-z0-9._-]` collapses to `_`, then the ends are
 * stripped of `._-` and the result is capped at 160 characters.
 *
 * A dsh `SessionId` is `session-<uuid>`, which survives this unchanged — the capped and
 * degenerate branches exist only to stay faithful to the original.
 */
function sanitizeKey(raw) {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, 160)
}

/**
 * The Trellis runtime context key for one dsh session.
 *
 * `dsh` is the platform name Trellis resolves for this harness, so the file is
 * `dsh_<sessionId>.json`. A key that sanitizes to nothing cannot match a pointer, and the
 * workspace scan then takes over — no hashing fallback is needed for ids dsh can mint.
 */
const contextKey = (sessionId) => `dsh_${sanitizeKey(sessionId)}`

/** Read one JSON object. Absent, unreadable and malformed all mean "nothing there". */
async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Directory names under `path`, or none when it is missing or unreadable. Sorted, so every
 * traversal built on it is deterministic. */
async function listDirectories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Narrow one `task.json` into the wire shape, or `undefined` when it carries no usable status.
 *
 * `id` is the *directory* name: that is what the session pointer addresses, what the scan's
 * tie-break orders by, and what a future click-through would open — `task.json`'s own `id`
 * is only the slug.
 */
function parseTask(dirName, source) {
  if (!isRecord(source)) return undefined
  const status = text(source.status)
  if (status.length === 0) return undefined
  const title = text(source.title) || dirName
  const priority = text(source.priority)
  return {
    id: dirName,
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title,
    status,
    // Omitted rather than empty: an absent field keeps the JSON comparing equal across the
    // wire, and the browser half decides what a missing priority looks like.
    ...(priority.length === 0 ? {} : { priority }),
  }
}

/** Read an optional service without letting a partially mounted tree throw at the caller. */
function readService(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

/**
 * The working directory this session belongs to, or `''`.
 *
 * Two synchronous host-side paths were measured and both are used, in order of how directly
 * they answer the question — the browser half never has to know its own cwd.
 */
function resolveCwd(ctx, sessionId) {
  // 1. A live session carries its immutable header, and the header carries the cwd.
  const sessions = readService(ctx, 'sessions')
  if (sessions !== undefined && typeof sessions.get === 'function') {
    try {
      const cwd = text(sessions.get(sessionId)?.header?.cwd)
      if (cwd.length > 0) return cwd
    } catch {
      // A store that cannot answer is not an error: the registry below still can.
    }
  }

  // 2. The workspace registry keeps one canonical-cwd header index over *persisted* session
  //    headers, so a session that is no longer live still resolves to its workspace.
  const registry = readService(ctx, 'workspaceRegistry')
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list() ?? []) {
        if (!isRecord(workspace) || !Array.isArray(workspace.sessionIds)) continue
        if (!workspace.sessionIds.includes(sessionId)) continue
        const path = text(workspace.path)
        if (path.length > 0) return path
      }
    } catch {
      // Same reasoning: a registry that cannot answer contributes nothing.
    }
  }

  // A session that is neither live nor accounted for by a workspace has no directory to read,
  // and inventing one — from a path slug, or from a hint the caller supplied — would risk
  // reporting some *other* repository's task. The empty result is the honest answer.
  return ''
}

/**
 * The task the session pointer names, or `undefined` when it names nothing usable.
 *
 * A pointer is advisory state written by `task.py start`, so it is validated the same way
 * Trellis validates it (`resolve_task_ref`): the target must stay inside `<cwd>/.trellis`,
 * and a stale, corrupt or escaping reference simply loses to the scan.
 */
async function readPointedTask(cwd, sessionId) {
  const workflowRoot = join(cwd, WORKFLOW_DIR)
  const pointer = await readJson(join(workflowRoot, RUNTIME_DIR, SESSIONS_DIR, `${contextKey(sessionId)}.json`))
  const ref = text(pointer?.current_task)
  if (ref.length === 0) return undefined

  // `current_task` is relative to the repository root, not to `.trellis`.
  const target = resolve(cwd, ref)
  if (target !== workflowRoot && !target.startsWith(`${workflowRoot}${sep}`)) return undefined

  return parseTask(basename(target), await readJson(join(target, 'task.json')))
}

/**
 * The best running task under `<cwd>/.trellis/tasks`, or `undefined`.
 *
 * Ranking is `in_progress` before `planning`; among equals the lexicographically greatest
 * directory name wins, which is the newest `MM-DD-` prefixed task (design.md §2.2, step 3).
 *
 * A candidate must also have been **started at least once**, which is what a recorded
 * `branch` proves: `task.py start` is the command that both records the checked-out branch
 * and writes the runtime pointer this half prefers, while `trellis init` leaves a scaffolding
 * task at `status: in_progress` with `branch: null` forever. Without that check every fresh
 * Trellis project reports "Bootstrap Guidelines · in progress" as its active task, which no
 * session is actually working on. The pointer path above is deliberately *not* filtered this
 * way: a pointer is direct evidence that a session already started the task, and it still
 * resolves in a workspace that is not a git repository, where no branch gets recorded.
 */
async function scanTasks(cwd) {
  const tasksRoot = join(cwd, WORKFLOW_DIR, TASKS_DIR)
  let best
  let bestRank = Number.POSITIVE_INFINITY
  for (const dirName of await listDirectories(tasksRoot)) {
    if (dirName === ARCHIVE_DIR) continue
    const source = await readJson(join(tasksRoot, dirName, 'task.json'))
    const task = parseTask(dirName, source)
    if (task === undefined) continue
    const rank = statusRank(task.status)
    if (rank === -1) continue
    if (text(source.branch).length === 0) continue
    if (rank < bestRank || (rank === bestRank && dirName > best.id)) {
      best = task
      bestRank = rank
    }
  }
  return best
}

/**
 * A link-chain ceiling. A hand-edited or corrupted `parent` chain could otherwise make the
 * upward walk spin forever; reaching the ceiling simply stops the walk where it is.
 */
const NODE_LINK_MAX_HOPS = 64

/**
 * Every active task under `<cwd>/.trellis/tasks`, keyed by directory name.
 *
 * The tree deliberately ignores the scan's status and branch filters (design.md §2.2.1): a tree
 * that hid its `completed` or never-started members would misrepresent the structure it exists
 * to show, and `task.py list` walks the same unfiltered set.
 *
 * `childNames` is `children` plus its legacy spelling `subtasks` — `task_store.py` rewrites both
 * because older `task.json` files still carry the latter.
 */
async function readActiveNodes(cwd) {
  const tasksRoot = join(cwd, WORKFLOW_DIR, TASKS_DIR)
  const nodes = new Map()
  for (const dirName of await listDirectories(tasksRoot)) {
    if (dirName === ARCHIVE_DIR) continue
    const source = await readJson(join(tasksRoot, dirName, 'task.json'))
    if (!isRecord(source)) continue
    const status = text(source.status)
    if (status.length === 0) continue

    const childNames = []
    for (const field of [source.children, source.subtasks]) {
      if (!Array.isArray(field)) continue
      for (const name of field) {
        const childId = text(name)
        if (childId.length > 0 && childId !== dirName) childNames.push(childId)
      }
    }

    nodes.set(dirName, {
      id: dirName,
      title: text(source.title) || dirName,
      status,
      priority: text(source.priority),
      parent: text(source.parent),
      childNames,
    })
  }
  return nodes
}

/**
 * The parent each node actually hangs from, as a `Map<id, parentId>` — `''` for a root.
 *
 * Three levels of judgement, because Trellis' own bidirectional link can be left half-written:
 * it warns `Link is half-written: <parent> now lists '<child>' as a child, but the new task does
 * not record its parent` when the second write fails. Preferring the node's own `parent` field
 * and falling back to the single active task that claims it as a child keeps such a task inside
 * its tree instead of orphaning it. A dangling `parent` (its target archived or renamed) means
 * "no parent", which is how `task.py list` renders orphans too.
 *
 * The result is a function — one parent per node at most — so the graph is a forest and no
 * outcome can depend on traversal order.
 */
function linkParents(nodes) {
  const claimants = new Map()
  for (const node of nodes.values()) {
    for (const childId of node.childNames) {
      if (!nodes.has(childId)) continue
      const owners = claimants.get(childId) ?? []
      owners.push(node.id)
      claimants.set(childId, owners)
    }
  }

  const parents = new Map()
  for (const node of nodes.values()) {
    if (node.parent.length > 0 && node.parent !== node.id && nodes.has(node.parent)) {
      parents.set(node.id, node.parent)
      continue
    }
    const owners = claimants.get(node.id) ?? []
    parents.set(node.id, owners.length === 1 ? owners[0] : '')
  }
  return parents
}

/** Walk up to the top ancestor, stopping at a root, a cycle, or the hop ceiling. */
function rootOf(id, parents) {
  let current = id
  const seen = new Set([id])
  for (let hop = 0; hop < NODE_LINK_MAX_HOPS; hop += 1) {
    const parent = parents.get(current) ?? ''
    if (parent.length === 0 || seen.has(parent)) return current
    seen.add(parent)
    current = parent
  }
  return current
}

/** `Map<parentId, [childId]>` from {@link linkParents}; siblings in directory-name order, which
 * for the `MM-DD-` prefix is chronological. */
function indexChildren(parents) {
  const index = new Map()
  for (const [id, parent] of parents) {
    if (parent.length === 0) continue
    const siblings = index.get(parent) ?? []
    siblings.push(id)
    index.set(parent, siblings)
  }
  for (const siblings of index.values()) siblings.sort()
  return index
}

/**
 * One wire node, recursively.
 *
 * `title` is deliberately **not** truncated the way the pill's is. The pill is a single line in
 * the header and has to stay short; a dropdown row has room and relies on CSS ellipsis, and
 * cutting it at 48 characters would hide exactly the part that tells two similar titles apart —
 * in the one place the user opened to tell them apart.
 */
function toTreeNode(id, currentId, nodes, index, seen) {
  const node = nodes.get(id)
  const wire = { id: node.id, title: node.title, status: node.status }
  if (node.priority.length > 0) wire.priority = node.priority
  if (node.id === currentId) wire.current = true

  const children = []
  for (const childId of index.get(node.id) ?? []) {
    if (seen.has(childId)) continue
    seen.add(childId)
    children.push(toTreeNode(childId, currentId, nodes, index, seen))
  }
  if (children.length > 0) wire.children = children
  return wire
}

/**
 * The active task tree `currentId` belongs to, or `undefined` when it stands alone.
 *
 * Standing alone means it is the root **and** has no descendants — a task with a parent, or one
 * with children, is a structure worth showing. Every other outcome (an unreadable directory, a
 * corrupt node, a circular link) also degrades to `undefined`, which just means "the pill, with
 * no tree and nothing to click".
 */
async function buildTree(cwd, currentId) {
  try {
    const nodes = await readActiveNodes(cwd)
    if (!nodes.has(currentId)) return undefined

    const parents = linkParents(nodes)
    const index = indexChildren(parents)
    const rootId = rootOf(currentId, parents)
    if (rootId === currentId && (index.get(currentId) ?? []).length === 0) return undefined

    return toTreeNode(rootId, currentId, nodes, index, new Set([rootId]))
  } catch {
    return undefined
  }
}

/**
 * @returns `{ status: 'ok', task }`, or `{ status: 'none' }` for every other outcome — no
 *   session, no cwd, no `.trellis`, no running task, a corrupt file. The surface has nothing
 *   useful to say about any of them, and the browser half renders nothing for `none`.
 *
 *   `tree` is present only when the task belongs to a parent/child structure (design.md §3.2);
 *   a task that stands alone gets exactly the reply it got before the feature existed.
 */
async function readTask(ctx, input) {
  const sessionId = text(input.sessionId)
  if (sessionId.length === 0) return { status: 'none' }

  const cwd = resolveCwd(ctx, sessionId)
  if (cwd.length === 0) return { status: 'none' }

  const task = (await readPointedTask(cwd, sessionId)) ?? (await scanTasks(cwd))
  if (task === undefined) return { status: 'none' }

  const tree = await buildTree(cwd, task.id)
  return tree === undefined ? { status: 'ok', task } : { status: 'ok', task, tree }
}

const ok = (value) => ({ ok: true, value })
const fail = (code, message) => ({ ok: false, error: { code, message } })
/**
 * One request from this plugin's browser half. The envelope is the connection service's:
 * `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
 */
async function handleRequest(ctx, endpoint, payload) {
  const input = isRecord(payload) ? payload : {}
  switch (endpoint) {
    case ENDPOINT_READ:
      return ok(await readTask(ctx, input))
    default:
      return fail('unknown-endpoint', `unknown trellis-statusline endpoint: ${String(endpoint)}`)
  }
}

/**
 * Required services.
 *
 * `inject` is not decoration: the framework hands a plugin a capability-scoped context
 * proxy, and reading a service this module did not declare is *denied* — `ctx.sessions`
 * throws, `ctx.get('sessions')` silently yields `undefined`.
 *
 * `sessions` carries the live session's `cwd`. `webServer` is here for an indirect reason:
 * `connection.rpc.handle` is documented as "scoped to the Context reading this service" and
 * implements each channel as a web route registered on *that* context, so without
 * `webServer` injected, registering the channel throws.
 *
 * `workspaceRegistry` is deliberately *not* declared: it is a fallback, and a plugin that
 * waits for an optional service would silently register nothing on a profile without it.
 */
export const inject = ['sessions', 'connection', 'webServer']

/** Mount the private RPC channel. */
export function apply(ctx) {
  // A plugin row that throws in `apply` fails the *whole* plugin tree, so a channel that
  // cannot register must degrade to "no UI surface" instead of blocking the boot.
  try {
    ctx.effect(
      () => ctx.connection.rpc.handle(CHANNEL, (endpoint, payload) => handleRequest(ctx, endpoint, payload)),
      'trellis-statusline: RPC channel',
    )
  } catch (error) {
    console.error(`[trellis-statusline] RPC channel unavailable: ${errorMessage(error)}`)
  }
}
