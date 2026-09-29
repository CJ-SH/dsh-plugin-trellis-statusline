/**
 * Host-half harness. Mounts the real Host half against a fake cordis context and a
 * throwaway workspace on disk, so the whole resolution chain — session → cwd → session
 * pointer → none (or nothing at all) — is observable without dsh running.
 *
 *   node test/host.test.mjs
 *
 * The fixture workspace lives in `test/.tmp/` and is removed again before the process
 * exits, so a run leaves nothing behind.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostUrl = new URL('../lib/index.js', import.meta.url)
const clientUrl = new URL('../lib/client.js', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}

const SESSION = 'session-66d44746-abbf-4a3d-bd21-a9374eae2bd1'
const OTHER_SESSION = 'session-3724610a-d67b-4d50-97ab-e7856427ab12'

/** The two exact routes this half owns: the pill's, and the status surface another bundle reads. */
const PILL_PATH = '/trellis-statusline/task/read'
const STATUS_PATH = '/trellis-statusline/status/read'

// --- Fake cordis context ----------------------------------------------------------------
let liveSessions = {}
let workspaces = []
const seen = { routes: new Map(), disposed: 0 }

const services = {
  sessions: { get: (id) => liveSessions[id] },
  workspaceRegistry: { list: () => workspaces },
  // The trust fence: the route asks it first and serves only when it answers `undefined`.
  connection: { requestRejection: () => undefined },
  webServer: {
    register(route) {
      seen.routes.set(route.path, route)
      return () => {
        seen.disposed += 1
      }
    },
  },
}
const effects = []
const ctx = {
  ...services,
  get: (serviceName) => services[serviceName],
  effect(callback, label) {
    const disposer = callback()
    effects.push({ label, disposer })
    return disposer
  },
}

const { apply, inject, name } = await import(hostUrl.href)
apply(ctx)

/** A response the handler can own: it only calls `writeHead` and `end`. */
function makeRes() {
  const res = { status: 0, headers: {}, body: undefined }
  res.writeHead = (status, headers) => {
    res.status = status
    Object.assign(res.headers, headers ?? {})
  }
  res.end = (body) => {
    res.body = body
  }
  return res
}

const parseBody = (body) => {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * One request through one registered route handler.
 *
 * @param options.sessionId - query value; `undefined` omits the parameter entirely.
 * @param options.method - HTTP method, `GET` unless the case is about the method.
 * @param options.rejection - what the composition's fence answers for this one call.
 * @param options.at - the route path to drive, the pill's by default.
 * @returns the status, the headers, the raw body and the parsed envelope.
 */
async function callRoute({ sessionId, method = 'GET', rejection, at = PILL_PATH } = {}) {
  const previous = services.connection.requestRejection
  if (rejection !== undefined) services.connection.requestRejection = rejection
  const res = makeRes()
  const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
  const handler = seen.routes.get(at)?.handler
  // A missing route must fail loudly here rather than throw a TypeError two frames down: this
  // harness exists to say *what* is wrong when a route moves.
  if (handler === undefined) throw new Error(`no route is registered at ${at}`)
  await handler({ method, url: `${at}${query}`, headers: {} }, res)
  services.connection.requestRejection = previous
  return { status: res.status, headers: res.headers, body: res.body, parsed: parseBody(res.body) }
}

/** Run one call with the composition's fence seam missing entirely, then put it back. */
async function withoutFence(run) {
  const fence = services.connection.requestRejection
  delete services.connection.requestRejection
  try {
    return await run()
  } finally {
    services.connection.requestRejection = fence
  }
}

/** The envelope of one read: the shape every task assertion below consumes. */
const read = async (sessionId) => (await callRoute({ sessionId })).parsed

// --- Fixture workspaces -----------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const scratch = join(here, '.tmp')
await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true })

// `branch` is what `task.py start` records; a task without one was never started. Fixtures
// carry it so they look like real work, though the resolution below never reads it.
const taskJson = (title, status, priority = 'P2', branch = 'master') => ({
  id: title,
  name: title,
  title,
  status,
  priority,
  branch,
})

async function makeWorkspace(label) {
  const root = join(scratch, label)
  await mkdir(join(root, '.trellis', 'tasks'), { recursive: true })
  return root
}
async function writeTask(root, dirName, task) {
  const dir = join(root, '.trellis', 'tasks', dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'task.json'), JSON.stringify(task, null, 2))
}
async function writePointer(root, sessionId, taskRef) {
  const dir = join(root, '.trellis', '.runtime', 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `dsh_${sessionId}.json`),
    JSON.stringify({ platform: 'dsh', last_seen_at: '2026-09-15T05:30:12Z', current_task: taskRef, current_run: null }),
  )
}
const pointAt = (cwd) => {
  liveSessions = { [SESSION]: { header: { id: SESSION, cwd } } }
}

// --- Packaging contract -----------------------------------------------------------------
check('plugin name is the package name', name, packageJson.name)
check('inject declares the three required services', inject, ['sessions', 'connection', 'webServer'])
check('the pill route is registered at the plugin path', (() => {
  const route = seen.routes.get(PILL_PATH)
  return [route?.kind, route?.path]
})(), ['exact', PILL_PATH])
check('the route registration is wrapped in an effect', typeof effects[0]?.disposer, 'function')

// A row that throws in `apply` fails the whole plugin tree, so a route that cannot register
// (a duplicate (kind, path) is the one way `register` throws) must degrade to "one surface
// fewer" instead of blocking the boot — and each route must degrade on its own.
const logged = []
const originalError = console.error
console.error = (message) => logged.push(String(message))
const throwingCtx = {
  get: () => undefined,
  effect: (callback) => callback(),
  connection: { requestRejection: () => undefined },
  webServer: {
    register() {
      throw new Error('duplicate route')
    },
  },
}
let survived = true
try {
  apply(throwingCtx)
} catch {
  survived = false
}
console.error = originalError
check('apply survives an unavailable route', survived, true)
check('each route degrades on its own, and each degradation is logged', logged.length, 2)
check('the log names the plugin', logged[0]?.startsWith('[trellis-statusline]'), true)

// The realistic collision: one path is already taken, the other is not. The surviving route is
// the load-bearing assertion — a shared guard would silently drop both.
const partlyLogged = []
console.error = (message) => partlyLogged.push(String(message))
const partialRoutes = new Map()
let partialSurvived = true
try {
  apply({
    get: () => undefined,
    effect: (callback) => callback(),
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        if (route.path === STATUS_PATH) throw new Error(`duplicate route ${route.path}`)
        partialRoutes.set(route.path, route)
        return () => undefined
      },
    },
  })
} catch {
  partialSurvived = false
}
console.error = originalError
check('a collision on one route leaves the other registered', [partialSurvived, [...partialRoutes.keys()]], [
  true,
  [PILL_PATH],
])
check('only the colliding route is reported', partlyLogged.length, 1)

// --- cwd resolution (design.md §2.1, conclusions A and B) --------------------------------
// The cwd is observable *through* the pointer: the pointer file only exists under the cwd this
// half resolved, so a resolved task proves the cwd came from the intended place.
const wsLive = await makeWorkspace('live')
await writeTask(wsLive, '09-15-alpha', taskJson('Alpha task', 'in_progress', 'P1'))
await writePointer(wsLive, SESSION, '.trellis/tasks/09-15-alpha')

pointAt(wsLive)
check('cwd comes from the live session header', (await read(SESSION)).value.task.id, '09-15-alpha')

liveSessions = {}
workspaces = [{ id: 'ws-1', path: wsLive, sessionIds: [SESSION] }]
check('cwd falls back to the workspace registry', (await read(SESSION)).value.task.id, '09-15-alpha')

workspaces = []
check('no cwd anywhere is an empty state', await read(SESSION), { ok: true, value: { status: 'none' } })
check('a blank sessionId is a bad request', (await callRoute({ sessionId: '' })).status, 400)
check('an unknown session does not borrow another session\'s workspace', await (async () => {
  workspaces = [{ id: 'ws-1', path: wsLive, sessionIds: [OTHER_SESSION] }]
  const reply = await read(SESSION)
  workspaces = []
  return reply
})(), { ok: true, value: { status: 'none' } })

// --- The session pointer is the only source of a title (prd.md R1-R2, D1 = A) -------------
const wsPointer = await makeWorkspace('pointer')
pointAt(wsPointer)
// A running, started task that no pointer names is not this session's task, so it is never
// named. Since D1 = A the reply carries the workspace's activity count instead — and no title.
await writeTask(wsPointer, '09-16-newer', taskJson('Newer in-progress task', 'in_progress', 'P1'))
check('no pointer means no title, only the workspace count', await read(SESSION), {
  ok: true,
  value: { status: 'workspace', activeTasks: 1 },
})
check('the count reply carries no task fields at all', Object.keys((await read(SESSION)).value).sort(), [
  'activeTasks',
  'status',
])

// A pointer is direct evidence that this session started the task, so what it names is shown
// unfiltered: even a never-started (`branch: null`) planning task beats every heuristic the
// scan had, and the scan's status/branch ranking plays no part anymore.
await writeTask(wsPointer, '09-15-older', { ...taskJson('Older planning task', 'planning', 'P3'), branch: null })
await writePointer(wsPointer, SESSION, '.trellis/tasks/09-15-older')
check('an explicit session pointer names the task', (await read(SESSION)).value.task, {
  id: '09-15-older',
  title: 'Older planning task',
  status: 'planning',
  priority: 'P3',
})

// A pointer that names something unusable is still no evidence about *this* session: it falls
// back to the workspace count, never to a guess at which task this session might be on.
// `wsPointer` now holds two tasks: 09-16-newer (in_progress) and 09-15-older (planning).
await writePointer(wsPointer, SESSION, '.trellis/tasks/does-not-exist')
check('a stale pointer falls back to the workspace count', await read(SESSION), {
  ok: true,
  value: { status: 'workspace', activeTasks: 2 },
})
await writePointer(wsPointer, SESSION, '../../../../etc/passwd')
check('a pointer escaping .trellis is refused', await read(SESSION), {
  ok: true,
  value: { status: 'workspace', activeTasks: 2 },
})
await writePointer(wsPointer, SESSION, '.trellis/tasks/09-16-newer')
await writeFile(join(wsPointer, '.trellis', 'tasks', '09-16-newer', 'task.json'), '{ not json')
check('a corrupt pointed-at task.json is not counted either', await read(SESSION), {
  ok: true,
  value: { status: 'workspace', activeTasks: 1 },
})

// --- The task tree (design.md §3.3, R6-R9) -----------------------------------------------
// Every case from the §3.5 table, driven through the real handler against real files.
const wsTree = await makeWorkspace('tree')
const writeNode = (dirName, fields = {}) =>
  writeTask(wsTree, dirName, {
    id: dirName,
    name: dirName,
    title: fields.title ?? dirName,
    status: fields.status ?? 'in_progress',
    priority: fields.priority ?? 'P2',
    branch: fields.branch === undefined ? 'master' : fields.branch,
    parent: fields.parent ?? null,
    ...(fields.children === undefined ? {} : { children: fields.children }),
    ...(fields.subtasks === undefined ? {} : { subtasks: fields.subtasks }),
  })
/** Point the session at one node and return the whole `value` the browser half would receive. */
const atTask = async (dirName) => {
  pointAt(wsTree)
  await writePointer(wsTree, SESSION, `.trellis/tasks/${dirName}`)
  return (await read(SESSION)).value
}
const treeAt = async (dirName) => (await atTask(dirName)).tree

// A stand-alone task sends no tree at all (R6), so its reply is byte-identical to the old one.
await writeNode('09-15-solo')
check('a stand-alone task carries no tree', await atTask('09-15-solo'), {
  status: 'ok',
  task: { id: '09-15-solo', title: '09-15-solo', status: 'in_progress', priority: 'P2' },
})

await writeNode('09-10-root', { children: ['09-11-alpha', '09-12-beta'] })
await writeNode('09-11-alpha', { parent: '09-10-root', status: 'completed', priority: 'P3' })
await writeNode('09-12-beta', { parent: '09-10-root', children: ['09-13-grand'] })
await writeNode('09-13-grand', { parent: '09-12-beta' })

check('the tree is rooted at the session task when that is the root', await treeAt('09-10-root'), {
  id: '09-10-root',
  title: '09-10-root',
  status: 'in_progress',
  priority: 'P2',
  current: true,
  children: [
    // A `completed` sibling is a member of the structure, so it appears — status and branch
    // deliberately do not filter a tree.
    { id: '09-11-alpha', title: '09-11-alpha', status: 'completed', priority: 'P3' },
    {
      id: '09-12-beta',
      title: '09-12-beta',
      status: 'in_progress',
      priority: 'P2',
      children: [{ id: '09-13-grand', title: '09-13-grand', status: 'in_progress', priority: 'P2' }],
    },
  ],
})

await writeNode('09-16-nopriority', { parent: '09-10-root', priority: '' })
check(
  'a tree node with no priority omits the field, like the pill does',
  (await treeAt('09-10-root')).children.map((child) => 'priority' in child),
  [true, true, false],
)

const grandTree = await treeAt('09-13-grand')
check('a grandchild keeps the real nesting', [grandTree.id, grandTree.children.length], ['09-10-root', 3])
check('only the session task is marked current', [
  grandTree.current,
  grandTree.children[1].children[0].current,
], [undefined, true])

// Trellis' own link can be left half-written: the parent lists the child, the child never
// records the parent (it prints "Link is half-written" when that second write fails).
await writeNode('09-20-parent', { children: ['09-21-half'] })
await writeNode('09-21-half')
check('a half-written link still attaches the child', (await treeAt('09-21-half')).id, '09-20-parent')

// Older task.json files carry the legacy `subtasks` spelling instead of `children`.
await writeNode('09-30-legacy', { subtasks: ['09-31-old'] })
await writeNode('09-31-old')
check('the legacy subtasks spelling still attaches', (await treeAt('09-31-old')).id, '09-30-legacy')

// A parent that is gone (archived, renamed) makes its child a root, as `task.py list` does.
await writeNode('09-40-orphan', { parent: '09-99-missing', children: ['09-41-kid'] })
await writeNode('09-41-kid', { parent: '09-40-orphan' })
check('a dangling parent makes the task its own root', (await treeAt('09-40-orphan')).id, '09-40-orphan')

// `children` is a historical list: archived children keep their name in it forever.
await writeNode('09-50-parent', { children: ['09-51-here', '09-52-archived'] })
await writeNode('09-51-here', { parent: '09-50-parent' })
check('an archived child name stays out of the tree', (await treeAt('09-50-parent')).children.map((n) => n.id), [
  '09-51-here',
])

// A never-started member is still part of the structure.
await writeNode('09-90-parent', { children: ['09-91-never'] })
await writeNode('09-91-never', { parent: '09-90-parent', branch: null })
check('a never-started member still appears in the tree', (await treeAt('09-90-parent')).children.map((n) => n.id), [
  '09-91-never',
])

// A corrupt node drops out of the tree without taking its siblings with it.
await writeNode('09-80-parent', { children: ['09-81-broken', '09-82-ok'] })
await writeNode('09-82-ok', { parent: '09-80-parent' })
await writeTask(wsTree, '09-81-broken', { not: 'a task' })
check('an unreadable node is skipped, not fatal', (await treeAt('09-80-parent')).children.map((n) => n.id), [
  '09-82-ok',
])

// A parent cycle must terminate rather than hang the handler.
await writeNode('09-60-a', { parent: '09-61-b' })
await writeNode('09-61-b', { parent: '09-60-a' })
const cyclic = await treeAt('09-60-a')
check('a parent cycle terminates and still renders', [cyclic.id, cyclic.children.map((n) => n.id)], [
  '09-61-b',
  ['09-60-a'],
])

// The pill truncates at 48 because the header is one line; a dropdown row has room, and
// hiding the rest of a long title there would defeat the point of opening it.
await writeNode('09-70-long', { title: 'y'.repeat(80), parent: '09-71-parent' })
await writeNode('09-71-parent', { children: ['09-70-long'] })
check('tree titles are not truncated the way the pill title is', [
  (await treeAt('09-70-long')).children[0].title.length,
  (await atTask('09-70-long')).task.title.length,
], [80, 48])

// --- Empty states -----------------------------------------------------------------------
const wsEmpty = await makeWorkspace('empty')
pointAt(wsEmpty)
check('a workspace with no tasks is an empty state', await read(SESSION), { ok: true, value: { status: 'none' } })

// --- The reported false positive: another session's work is not this session's work -------
// `trellis init` leaves a scaffolding task at `status: in_progress` with `branch: null`
// forever, and a started task looks the same to a scan whether or not *this* session is the one
// working on it. Neither is evidence about this session, so neither is reported.
const wsScaffold = await makeWorkspace('scaffold')
pointAt(wsScaffold)
const scaffold = {
  id: '00-bootstrap-guidelines',
  name: '00-bootstrap-guidelines',
  title: 'Bootstrap Guidelines',
  status: 'in_progress',
  priority: 'P1',
  branch: null,
  base_branch: null,
  notes: 'First-time setup task created by trellis init (fullstack project)',
}
await writeTask(wsScaffold, '00-bootstrap-guidelines', scaffold)
check('a never-started scaffolding task is neither named nor counted', await read(SESSION), {
  ok: true,
  value: { status: 'none' },
})

// The same file, differing only in the one field `task.py start` writes: started. It is still
// not this session's task, so it is never named — but a *started* task is real work, so it is
// counted. The scaffold rule exists to hide a never-started artefact, not to hide work.
await writeTask(wsScaffold, '00-bootstrap-guidelines', { ...scaffold, branch: 'master' })
check('a started task named like the scaffold is still counted', await read(SESSION), {
  ok: true,
  value: { status: 'workspace', activeTasks: 1 },
})

// The pointer is the one thing that reports it — status and branch stay irrelevant.
await writePointer(wsScaffold, SESSION, '.trellis/tasks/00-bootstrap-guidelines')
check('a pointer reports the scaffolding task it names', (await read(SESSION)).value.task, {
  id: '00-bootstrap-guidelines',
  title: 'Bootstrap Guidelines',
  status: 'in_progress',
  priority: 'P1',
})

// --- The count itself (prd.md R2/R3) -----------------------------------------------------
const wsCount = await makeWorkspace('count')
pointAt(wsCount)
await writeTask(wsCount, '09-15-first', taskJson('First planning task', 'planning', 'P2'))
await writeTask(wsCount, '09-16-second', taskJson('Second started task', 'in_progress', 'P1'))
await writeTask(wsCount, '09-17-third', taskJson('Third completed task', 'completed', 'P3'))
// A directory named `archive` is Trellis' park-and-forget month bucket, whatever is inside it.
await writeTask(wsCount, 'archive', taskJson('Parked task', 'in_progress', 'P1'))
check('every non-archived task counts, whatever its status', (await read(SESSION)).value.activeTasks, 3)
await writeTask(wsCount, '00-bootstrap-guidelines', {
  id: '00-bootstrap-guidelines',
  name: '00-bootstrap-guidelines',
  title: 'Bootstrap Guidelines',
  status: 'in_progress',
  branch: null,
})
check('the scaffold is subtracted from that count', (await read(SESSION)).value.activeTasks, 3)

// Trellis' own walk skips the `archive` directory (`task_store.py`: `candidate.name ==
// DIR_ARCHIVE`), and so does the tree: a hand-moved child parked under `tasks/archive/` is not
// a member of the structure its parent claims — the parent stays stand-alone.
const wsArchivedDir = await makeWorkspace('archived-dir')
pointAt(wsArchivedDir)
await writeTask(wsArchivedDir, '09-80-parent', {
  ...taskJson('Parent task', 'in_progress'),
  children: ['09-15-done'],
})
await writeTask(wsArchivedDir, join('archive', '2026-09', '09-15-done'), taskJson('Archived by hand', 'in_progress'))
await writePointer(wsArchivedDir, SESSION, '.trellis/tasks/09-80-parent')
check('a task under tasks/archive is not part of the tree', await read(SESSION), {
  ok: true,
  value: { status: 'ok', task: { id: '09-80-parent', title: 'Parent task', status: 'in_progress', priority: 'P2' } },
})

const wsNoTrellis = join(scratch, 'no-trellis')
await mkdir(wsNoTrellis, { recursive: true })
pointAt(wsNoTrellis)
check('a workspace without .trellis is an empty state', await read(SESSION), { ok: true, value: { status: 'none' } })

pointAt(join(scratch, 'does-not-exist'))
check('a cwd that does not exist is an empty state', await read(SESSION), { ok: true, value: { status: 'none' } })

const wsBroken = await makeWorkspace('broken')
pointAt(wsBroken)
await writeTask(wsBroken, '09-15-broken', taskJson('Broken', 'in_progress'))
await writeFile(join(wsBroken, '.trellis', 'tasks', '09-15-broken', 'task.json'), '{ not json')
check('a workspace whose only task.json is corrupt is an empty state', await read(SESSION), { ok: true, value: { status: 'none' } })

// --- Field discipline -------------------------------------------------------------------
const wsFields = await makeWorkspace('fields')
pointAt(wsFields)
// The pointer is what makes this session's task readable at all; these cases are about how one
// `task.json` is narrowed into the wire shape, not about which task is picked.
await writePointer(wsFields, SESSION, '.trellis/tasks/09-15-fields')
await writeTask(wsFields, '09-15-fields', { title: '  Spaced title  ', status: 'in_progress', priority: '', branch: 'master' })
check('a blank priority is omitted, not defaulted', (await read(SESSION)).value.task, {
  id: '09-15-fields',
  title: 'Spaced title',
  status: 'in_progress',
})
await writeTask(wsFields, '09-15-fields', { status: 'in_progress', title: '', branch: 'master' })
check('a missing title falls back to the directory name', (await read(SESSION)).value.task.title, '09-15-fields')
await writeTask(wsFields, '09-15-fields', { title: 'x'.repeat(80), status: 'in_progress', branch: 'master' })
const long = (await read(SESSION)).value.task.title
check('a long title is truncated to 48 characters', [long.length, long.endsWith('…')], [48, true])

// --- Protocol: fence first, then the method, then the query ------------------------------
const fenced = await callRoute({ sessionId: SESSION, rejection: () => 401 })
const forbidden = await callRoute({ sessionId: SESSION, rejection: () => 403 })
const fenceless = await withoutFence(() => callRoute({ sessionId: SESSION }))
const realGet = services.sessions.get
let touched = false
services.sessions.get = () => {
  touched = true
  return undefined
}
const shortCircuited = await callRoute({ sessionId: SESSION, rejection: () => 401 })
services.sessions.get = realGet
check('401 from the fence is answered verbatim', [fenced.status, fenced.body], [401, 'unauthorized'])
check('403 from the fence is answered verbatim', [forbidden.status, forbidden.body], [403, 'forbidden'])
check('a composition without the fence fails closed', [fenceless.status, fenceless.body], [503, 'trust fence unavailable'])
check('the fence runs before any session is read', [shortCircuited.status, touched], [401, false])

const wrongMethod = await callRoute({ sessionId: SESSION, method: 'POST' })
check('a non-GET method is refused with the method it allows', [wrongMethod.status, wrongMethod.headers.allow], [405, 'GET'])
const missing = await callRoute({})
check('a missing sessionId is a bad request', [missing.status, missing.parsed.error.code], [400, 'bad-request'])
check('an oversized sessionId is a bad request', (await callRoute({ sessionId: 'x'.repeat(129) })).status, 400)

const answered = await callRoute({ sessionId: SESSION })
check('a good read is 200 JSON in the client envelope', [
  answered.status,
  answered.headers['content-type'],
  answered.parsed.ok,
], [200, 'application/json; charset=utf-8', true])
check('the answer is never cached', answered.headers['cache-control'], 'no-store')

// --- The status surface (design.md §2.4): what another bundle reads -----------------------
// The management hub's status row asks one question — is this session on a Trellis task — and
// must be able to ask it without importing this package. The answer runs the *same* chain the
// pill runs and drops everything the pill needs and a status row must not have: no title, no
// tree, no priority. A second implementation of "which task is this session on" is exactly what
// would drift, so the agreement between the two surfaces is asserted, not assumed.
const wsStatus = await makeWorkspace('status')
pointAt(wsStatus)
await writeTask(wsStatus, '09-29-hub', taskJson('Hub status surface', 'in_progress', 'P1'))
await writePointer(wsStatus, SESSION, '.trellis/tasks/09-29-hub')

/** The status surface's envelope, driven through its own registered handler. */
const statusOf = (options = {}) => callRoute({ ...options, at: STATUS_PATH }).then((answer) => answer.parsed)

const statusRoute = seen.routes.get(STATUS_PATH)
check('the status route is registered at its own exact path', [statusRoute?.kind, statusRoute?.path], [
  'exact',
  STATUS_PATH,
])
check('each route got its own effect', effects.map((item) => typeof item.disposer), ['function', 'function'])
check('the status surface reports the session verdict', await statusOf({ sessionId: SESSION }), {
  ok: true,
  value: {
    plugin: packageJson.name,
    status: 'ok',
    active: true,
    taskId: '09-29-hub',
    taskStatus: 'in_progress',
  },
})
check('the status value is the whole documented key set', Object.keys((await statusOf({ sessionId: SESSION })).value).sort(), [
  'active',
  'plugin',
  'status',
  'taskId',
  'taskStatus',
])
// The structural guarantee, asserted on the bytes rather than on the shape: the pill's reply
// carries the title, and this one must not be able to — a future field would fail here.
check(
  'no title can travel on the status surface',
  JSON.stringify(await statusOf({ sessionId: SESSION })).includes('Hub status surface'),
  false,
)
check('both surfaces agree about the session', [
  (await statusOf({ sessionId: SESSION })).value.active,
  (await read(SESSION)).value.status,
], [true, 'ok'])

await writePointer(wsStatus, SESSION, '.trellis/tasks/does-not-exist')
check('a session without a pointer reports the workspace count and no task', await statusOf({ sessionId: SESSION }), {
  ok: true,
  value: { plugin: packageJson.name, status: 'workspace', active: false, activeTasks: 1 },
})
check('both surfaces agree about a pointer-less session', [
  (await statusOf({ sessionId: SESSION })).value.activeTasks,
  (await read(SESSION)).value.activeTasks,
], [1, 1])

pointAt(join(scratch, 'no-trellis-at-all'))
check('a session outside any workspace reports nothing to show', await statusOf({ sessionId: SESSION }), {
  ok: true,
  value: { plugin: packageJson.name, status: 'none', active: false },
})
check('an unknown session is a verdict, not an error', [
  (await callRoute({ sessionId: OTHER_SESSION, at: STATUS_PATH })).status,
  (await statusOf({ sessionId: OTHER_SESSION })).value.status,
], [200, 'none'])

// A Settings page has no session to report on. That is a legitimate question with an honest
// answer — and the answer still proves this plugin is mounted, which is the hub's other need.
check('a session-less question is answered, not refused', await statusOf(), {
  ok: true,
  value: { plugin: packageJson.name, status: 'unscoped' },
})
check('an unscoped answer carries no `active` at all', 'active' in (await statusOf()).value, false)
check('a blank sessionId is still unscoped rather than an error', [
  (await callRoute({ sessionId: '   ', at: STATUS_PATH })).status,
  (await statusOf({ sessionId: '   ' })).value.status,
], [200, 'unscoped'])
check('an oversized sessionId is refused on the status route too', (await statusOf({ sessionId: 'x'.repeat(129) })).error.code, 'bad-request')

const statusFenced = await callRoute({ sessionId: SESSION, at: STATUS_PATH, rejection: () => 401 })
const statusFenceless = await withoutFence(() => callRoute({ sessionId: SESSION, at: STATUS_PATH }))
const statusWrongMethod = await callRoute({ sessionId: SESSION, at: STATUS_PATH, method: 'POST' })
check('the status route asks the same fence first', [statusFenced.status, statusFenced.body], [401, 'unauthorized'])
check('the status route fails closed without the fence', [statusFenceless.status, statusFenceless.body], [503, 'trust fence unavailable'])
check('the status route allows GET only', [statusWrongMethod.status, statusWrongMethod.headers.allow], [405, 'GET'])
check('the status answer is never cached', (await callRoute({ sessionId: SESSION, at: STATUS_PATH })).headers['cache-control'], 'no-store')

// --- AC6: the read path never writes ----------------------------------------------------
async function snapshot(root) {
  const rows = []
  const walk = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      const info = await stat(full)
      const digest = createHash('sha256').update(await readFile(full)).digest('hex').slice(0, 16)
      rows.push([full.slice(root.length), info.mtimeMs, info.size, digest])
    }
  }
  await walk(root)
  return rows
}
// A plain pointer workspace and a tree workspace: building a tree reads every task.json, so it
// is the wider read path and deserves its own proof that reading never writes.
for (const root of [wsLive, wsTree]) {
  pointAt(root)
  const before = await snapshot(join(root, '.trellis'))
  for (const sessionId of [SESSION, OTHER_SESSION, '']) await read(sessionId)
  const after = await snapshot(join(root, '.trellis'))
  check(`reading ${basename(root)} leaves its .trellis byte-identical`, after, before)
}

const hostSource = await readFile(hostUrl, 'utf8')
check('host half imports nothing from the harness', /from\s+['"]@deepseek-ai\//.test(hostSource), false)
check('host half imports only node: builtins and relative paths', [...hostSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]).sort(), ['node:fs/promises', 'node:path'])
check(
  'host half contains no write API',
  // `\btruncate\b` rather than a bare `truncate`: the plain word also appears in prose
  // ("a long title is truncated"), and this assertion is about API calls, not vocabulary.
  /writeFile|appendFile|rename\(|unlink|rmdir|\bmkdir\b|\brm\(|createWriteStream|\btruncate\b/.test(hostSource),
  false,
)

// --- Cross-half contract ----------------------------------------------------------------
const clientSource = await readFile(clientUrl, 'utf8')
// Endpoint literals only: a media type (`application/json`) has the same `a/b` shape but is
// not an endpoint of this plugin's protocol.
const endpointsIn = (source) =>
  [...new Set([...source.matchAll(/'([a-z]+\/[a-z]+)'/g)].map((match) => match[1]))]
    .filter((value) => value !== 'application/json')
    .sort()
check('both halves agree on the route prefix', [
  hostSource.includes("const ROUTE_PREFIX = '/trellis-statusline'"),
  clientSource.includes("const ROUTE_PREFIX = '/trellis-statusline'"),
], [true, true])
// The host is a superset on purpose: `status/read` belongs to the hub, which is not this
// bundle. The pill still calls exactly one endpoint, and the host handles exactly the two it
// documents — so neither a stray literal nor a missing handler can pass here.
check('the host handles the two documented endpoints', endpointsIn(hostSource), ['status/read', 'task/read'])
check('the pill calls exactly the endpoint it needs', endpointsIn(clientSource), ['task/read'])
check(
  'every endpoint the pill calls is one the host handles',
  endpointsIn(clientSource).every((endpoint) => endpointsIn(hostSource).includes(endpoint)),
  true,
)

await rm(scratch, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}` +
      (entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`),
  )
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
