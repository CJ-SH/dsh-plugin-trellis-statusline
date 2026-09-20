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
 * 3. `<cwd>/.trellis/.runtime/sessions/dsh_<sessionId>.json` is the *only* source of a task
 *    title, and it must name a real task: a stale or escaping reference, a corrupt file, or no
 *    pointer at all yields no title — a workspace-wide scan of `tasks/<dir>/task.json` was
 *    removed deliberately (commit 27b5b39), because a scan cannot tell one session's task from
 *    another's and reporting the wrong task is worse than reporting none. What a title-less
 *    session gets instead is the workspace's activity **count**
 *    (`{ status: 'workspace', activeTasks }`), the Claude Code statusline behaviour
 *    (`_count_active_tasks`) minus the `trellis init` scaffold.
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

/** Named-route prefix this half owns on the composition's `webServer`. */
const ROUTE_PREFIX = '/trellis-statusline'

/** The one endpoint the browser half calls. */
const ENDPOINT_READ = 'task/read'

/** The one named route this half registers: exact match, `GET` only. */
const ROUTE_PATH = `${ROUTE_PREFIX}/${ENDPOINT_READ}`

/** Longest `sessionId` accepted from the wire; a real one is `session-<uuid>`. */
const SESSION_ID_MAX = 128

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
 * `dsh_<sessionId>.json`. A key that sanitizes to nothing cannot match a pointer, and there is
 * no second source to fall back to — the half reports nothing rather than guessing. No hashing
 * fallback is needed for ids dsh can mint.
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
 * `id` is the *directory* name: that is what the session pointer addresses and what a future
 * click-through would open — `task.json`'s own `id` is only the slug.
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
 * A pointer is advisory state written by `task.py create|start`, so it is validated the same
 * way Trellis validates it (`resolve_task_ref`): the target must stay inside `<cwd>/.trellis`.
 * A stale, corrupt or escaping reference is treated as *no evidence at all* — the session has
 * no task to show, and it is never replaced by a guess.
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
 * A link-chain ceiling. A hand-edited or corrupted `parent` chain could otherwise make the
 * upward walk spin forever; reaching the ceiling simply stops the walk where it is.
 */
const NODE_LINK_MAX_HOPS = 64

/**
 * Every active task under `<cwd>/.trellis/tasks`, keyed by directory name.
 *
 * The tree deliberately ignores status and branch: a tree that hid its `completed` or
 * never-started members would misrepresent the structure it exists to show, and `task.py list`
 * walks the same unfiltered set.
 *
 * `childNames` is `children` plus its legacy spelling `subtasks` — `task_store.py` rewrites both
 * because older `task.json` files still carry the latter.
 */
/**
 * The scaffolding task `trellis init` seeds once per project: `00-bootstrap-guidelines`,
 * `status: in_progress`, never started — and therefore never the task a session pointer names.
 * Matching ignores the `MM-DD-` directory prefix and accepts the `task.json` slug as well.
 */
const SCAFFOLD_TASK_NAME = /(^|-)bootstrap-guidelines$/i

/**
 * Whether one task directory is that never-started scaffold rather than real work.
 *
 * The name alone is not enough: a task that carries it but *has* been started (branch recorded)
 * is real work and stays counted, so the rule cannot hide anything a user is actually doing.
 */
function isScaffoldTask(dirName, source) {
  const slug = text(source?.id) || text(source?.name)
  if (!SCAFFOLD_TASK_NAME.test(dirName) && !SCAFFOLD_TASK_NAME.test(slug)) return false
  return text(source?.branch).length === 0
}

/**
 * How many tasks the workspace currently holds: every non-archived `<cwd>/.trellis/tasks/<dir>`
 * whose `task.json` parses to an object carrying a status, minus that scaffold.
 *
 * This is the whole answer for a session the pointer does not name (prd.md R1-R3, D1 = A): the
 * pill shows a count and never a title, so no other session's task can be mistaken for this
 * one's. Claude Code's statusline counts a directory for the mere presence of `task.json` and
 * includes the scaffold; this count requires a readable status and skips the scaffold, which is
 * the only deliberate difference.
 *
 * @returns the number of real work items, `0` when the workspace has none or is unreadable.
 */
async function countActiveTasks(cwd) {
  const tasksRoot = join(cwd, WORKFLOW_DIR, TASKS_DIR)
  let count = 0
  for (const dirName of await listDirectories(tasksRoot)) {
    if (dirName === ARCHIVE_DIR) continue
    const source = await readJson(join(tasksRoot, dirName, 'task.json'))
    if (!isRecord(source) || text(source.status).length === 0) continue
    if (isScaffoldTask(dirName, source)) continue
    count += 1
  }
  return count
}

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
 * The session pointer is the only source of a task title (prd.md R1); there is no workspace scan
 * behind it, because a scan can never attribute a task to one session.
 *
 * @returns one of exactly three shapes:
 *   - `{ status: 'ok', task, tree? }` — the pointer named a usable task. `tree` is present only
 *     when that task belongs to a parent/child structure (design.md §3.2); a task that stands
 *     alone gets exactly the reply it got before the feature existed.
 *   - `{ status: 'workspace', activeTasks }` — no pointer for this session, but the workspace
 *     holds at least one real task. **No title**, by construction (prd.md R1/R2); the browser
 *     half renders the count.
 *   - `{ status: 'none' }` — no session, no cwd, no `.trellis`, a pointer naming nothing usable,
 *     or a workspace with no real task. The browser half renders nothing.
 */
async function readTask(ctx, input) {
  const sessionId = text(input.sessionId)
  if (sessionId.length === 0) return { status: 'none' }

  const cwd = resolveCwd(ctx, sessionId)
  if (cwd.length === 0) return { status: 'none' }

  const task = await readPointedTask(cwd, sessionId)
  if (task === undefined) {
    const activeTasks = await countActiveTasks(cwd)
    return activeTasks > 0 ? { status: 'workspace', activeTasks } : { status: 'none' }
  }

  const tree = await buildTree(cwd, task.id)
  return tree === undefined ? { status: 'ok', task } : { status: 'ok', task, tree }
}

const ok = (value) => ({ ok: true, value })
const fail = (code, message) => ({ ok: false, error: { code, message } })

/**
 * Write one JSON response. Never cached: a session's task is a live fact.
 *
 * @param res - the route's response, owned completely by this handler.
 * @param status - HTTP status to send.
 * @param body - value serialized as the response body.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Apply the composition's trust fence before anything else, exactly as the shipped
 * `dsh-host-open-in-app` routes do: `connection.requestRejection` owns the Host/Origin
 * check (403) and the browser-session cookie gate (401).
 *
 * Fails *closed*: a composition without that seam answers 503, so this route can never
 * serve workspace data unauthenticated.
 *
 * @param ctx - plugin context; `connection` is injected by this row.
 * @param req - the incoming request (only its headers are read).
 * @param res - response owned here when the request is rejected.
 * @returns true when a rejection was written and the handler must stop.
 */
function rejected(ctx, req, res) {
  const connection = ctx.connection
  if (typeof connection.requestRejection !== 'function') {
    console.error('[trellis-statusline] trust fence unavailable: refusing to serve')
    res.writeHead(503)
    res.end('trust fence unavailable')
    return true
  }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection)
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

/**
 * The route's request shape: `?sessionId=<session-…>`. Anything else is a bad request,
 * answered 400 rather than guessed at.
 *
 * @param req - the incoming request.
 * @returns the trimmed session id, or an empty string when the parameter is unusable.
 */
function querySessionId(req) {
  try {
    const sessionId = text(new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId'))
    return sessionId.length > SESSION_ID_MAX ? '' : sessionId
  } catch {
    return ''
  }
}

/**
 * The one route handler: fence first, then method, then the query, then the read.
 *
 * The reply keeps the envelope the connection service used to carry —
 * `{ ok: true, value }` / `{ ok: false, error: { code, message } }` — so the browser half's
 * decode logic and both harnesses stay shaped the same.
 *
 * @param ctx - plugin context.
 * @param req - the incoming request.
 * @param res - response owned by this handler.
 */
async function routeHandler(ctx, req, res) {
  if (rejected(ctx, req, res)) return
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  const sessionId = querySessionId(req)
  if (sessionId.length === 0) {
    sendJson(res, 400, fail('bad-request', 'sessionId query parameter must be a session id'))
    return
  }
  sendJson(res, 200, ok(await readTask(ctx, { sessionId })))
}

/**
 * Required services.
 *
 * `inject` is not decoration: the framework hands a plugin a capability-scoped context
 * proxy, and reading a service this module did not declare is *denied* — `ctx.sessions`
 * throws, `ctx.get('sessions')` silently yields `undefined`.
 *
 * `sessions` carries the live session's `cwd`. `webServer` is this half's route carrier
 * (`register`), and `connection` is the trust fence the route asks first
 * (`requestRejection`) — the same two services the shipped `dsh-host-open-in-app` row
 * injects. Registering through `connection.rpc.handle` instead would put the physical route
 * on the *connection row's* context, which is exactly why that older shape needed the
 * shipped row widened by a bundle patch; owning the route removes the coupling
 * (`research/webserver-official-usage.md`).
 *
 * `workspaceRegistry` is deliberately *not* declared: it is a fallback, and a plugin that
 * waits for an optional service would silently register nothing on a profile without it.
 */
export const inject = ['sessions', 'connection', 'webServer']

/** Register this half's one route on the composition's web server. */
export function apply(ctx) {
  // A plugin row that throws in `apply` fails the *whole* plugin tree, so a route that
  // cannot register must degrade to "no UI surface" instead of blocking the boot:
  // `register` throws on a duplicate (kind, path), a composition misconfiguration.
  try {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => routeHandler(ctx, req, res),
      }),
      'trellis-statusline: task/read route',
    )
  } catch (error) {
    console.error(`[trellis-statusline] route unavailable: ${errorMessage(error)}`)
  }
}
