/**
 * Cross-half integration harness.
 *
 * The other three harnesses each check one half against a *hand-written* idea of the other
 * half's shapes: `host.test.mjs` asserts the reply the Host produces, `cell.test.mjs` renders
 * payloads it writes itself. Rename a field on one side and both still pass while the pill
 * quietly stops rendering — so this harness closes the loop instead: it points the real Host
 * half at a real `.trellis` tree on disk, then feeds that exact reply to the real cell.
 *
 *   node test/integration.test.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostUrl = new URL('../lib/index.js', import.meta.url)
const clientUrl = new URL('../lib/client.js', import.meta.url)

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}
/**
 * Print every result and set the exit code.
 *
 * A guard below calls this early: without the header cell there is no round trip to run, and a
 * missing seat must read as a *named* failure instead of a TypeError.
 */
function report() {
  const failed = results.filter((entry) => !entry.ok)
  for (const entry of results) {
    console.log(
      `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}` +
        (entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`),
    )
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exitCode = failed.length === 0 ? 0 : 1
  return failed.length
}

const SESSION = 'session-66d44746-abbf-4a3d-bd21-a9374eae2bd1'
// A session that never wrote a pointer: it must get the workspace count, never a title.
const OTHER_SESSION = 'session-4c1f5a2e-0000-4000-8000-000000000000'
const ROOT_DIR = '09-10-release'
const CHILD_DIR = '09-11-importer'

// --- Minimal hook runtime, one store per component ----------------------------------------
const stores = new WeakMap()
let active = null
let cursor = 0
let dirty = false
const storeOf = (component) => {
  let store = stores.get(component)
  if (store === undefined) {
    store = { states: [], deps: [], pending: [], cleanups: [], refs: [] }
    stores.set(component, store)
  }
  return store
}
const reactStub = {
  createElement: (type, props, ...children) => {
    const node = { type, props: props ?? {}, children: children.flat(Infinity) }
    const ref = node.props.ref
    if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = node
    return node
  },
  useState: (initial) => {
    const store = storeOf(active)
    const index = cursor
    cursor += 1
    if (!(index in store.states)) store.states[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(store.states[index]) : next
      if (Object.is(value, store.states[index])) return
      store.states[index] = value
      dirty = true
    }
    return [store.states[index], set]
  },
  useRef: (initial) => {
    const store = storeOf(active)
    const index = cursor
    cursor += 1
    if (!(index in store.refs)) store.refs[index] = { current: initial }
    return store.refs[index]
  },
  useEffect: (effect, list) => {
    const store = storeOf(active)
    const index = cursor
    cursor += 1
    const previous = store.deps[index]
    const changed =
      previous === undefined ||
      list === undefined ||
      list.length !== previous.length ||
      list.some((entry, at) => !Object.is(entry, previous[at]))
    if (!changed) return
    if (typeof store.cleanups[index] === 'function') store.cleanups[index]()
    store.cleanups[index] = null
    store.deps[index] = list
    store.pending.push([index, effect])
  },
  useLayoutEffect: (effect, list) => reactStub.useEffect(effect, list),
}

let factory = null
globalThis.window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { append: () => undefined },
  querySelector: () => null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
}

// --- A real workspace on disk --------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const scratch = join(here, '.tmp-integration')
await rm(scratch, { recursive: true, force: true })
const tasksRoot = join(scratch, '.trellis', 'tasks')

const task = (dirName, fields) => ({ id: dirName, name: dirName, branch: 'master', parent: null, ...fields })
await mkdir(join(tasksRoot, ROOT_DIR), { recursive: true })
await mkdir(join(tasksRoot, CHILD_DIR), { recursive: true })
await writeFile(
  join(tasksRoot, ROOT_DIR, 'task.json'),
  JSON.stringify(
    task(ROOT_DIR, {
      title: 'Release 0.2',
      status: 'in_progress',
      priority: 'P1',
      children: [CHILD_DIR],
    }),
  ),
)
await writeFile(
  join(tasksRoot, CHILD_DIR, 'task.json'),
  JSON.stringify(
    task(CHILD_DIR, {
      title: 'Wire the importer',
      status: 'in_progress',
      priority: 'P2',
      parent: ROOT_DIR,
    }),
  ),
)
await mkdir(join(scratch, '.trellis', '.runtime', 'sessions'), { recursive: true })
await writeFile(
  join(scratch, '.trellis', '.runtime', 'sessions', `dsh_${SESSION}.json`),
  JSON.stringify({ platform: 'dsh', current_task: `.trellis/tasks/${CHILD_DIR}` }),
)

// --- Run the real Host half over it --------------------------------------------------------
const host = await import(hostUrl.href)
// One entry per route: the Host half owns two now (the pill's read and the hub's status
// surface), and this harness drives the pill's, so it resolves by path rather than by whichever
// registration happened to land last.
const hostRoutes = new Map()
const hostServices = {
  sessions: {
    get: (id) => (id === SESSION || id === OTHER_SESSION ? { header: { id, cwd: scratch } } : undefined),
  },
  workspaceRegistry: { list: () => [] },
  connection: { requestRejection: () => undefined },
  webServer: {
    register(route) {
      hostRoutes.set(route.path, route)
      return () => undefined
    },
  },
}
host.apply({ ...hostServices, get: (key) => hostServices[key], effect: (fn) => fn() })

/** A response the route handler can own: it only calls `writeHead` and `end`. */
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
/** One real request straight into the registered route the browser half calls. */
async function askHost(sessionId, method = 'GET') {
  const res = makeRes()
  const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
  const path = '/trellis-statusline/task/read'
  const handler = hostRoutes.get(path)?.handler
  if (handler === undefined) throw new Error(`no route is registered at ${path}`)
  await handler({ method, url: `${path}${query}`, headers: {} }, res)
  return { status: res.status, body: res.body, parsed: res.body === undefined ? undefined : JSON.parse(res.body) }
}

const reply = (await askHost(SESSION)).parsed
check('the Host resolved the pointed-at child', reply.value.task.id, CHILD_DIR)
check('the Host attached the tree', reply.value.tree.id, ROOT_DIR)
check('the tree nests the child and marks it current', [
  reply.value.tree.children.length,
  reply.value.tree.children[0].current,
], [1, true])

// --- Feed that exact reply to the real cell -----------------------------------------------
await import(clientUrl.href)
const client = factory((request) => {
  if (request === 'react') return reactStub
  throw new Error(`unexpected require("${request}")`)
})

const caught = []
/**
 * The slot registry's contract, in miniature (`dsh-client-ui-renderer/lib/client.js:1343-1402`):
 * `register` refuses a seat nobody declared, and `inject` runs its callback only while a
 * declaration is live. A fake that called back immediately would hand this harness a cell the
 * shell never mounts, which is the false green prd.md R11 exists to remove.
 */
const seatsDeclared = new Set()
const seatWaiters = new Map()
function declareSeat(key) {
  if (seatsDeclared.has(key)) return
  seatsDeclared.add(key)
  for (const reconcile of [...(seatWaiters.get(key) ?? [])]) reconcile()
}
const slots = {
  inject(key, callback) {
    let contribution
    let live = true
    const reconcile = () => {
      if (!live) return
      if (!seatsDeclared.has(key)) {
        const dispose = contribution
        contribution = undefined
        if (typeof dispose === 'function') dispose()
        return
      }
      if (contribution === undefined) contribution = callback() ?? undefined
    }
    const watchers = seatWaiters.get(key) ?? new Set()
    watchers.add(reconcile)
    seatWaiters.set(key, watchers)
    reconcile()
    return () => {
      live = false
      watchers.delete(reconcile)
      const dispose = contribution
      contribution = undefined
      if (typeof dispose === 'function') dispose()
    }
  },
  register(options, component) {
    if (!seatsDeclared.has(options.name)) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
    caught.push({ options, component })
    return () => undefined
  },
}
// The shell's own client half declares both seats; this plugin's half loads against them.
declareSeat('conversation.session.header.actions')
declareSeat('conversation.input.dock')

// Requests the harness still owes an answer for; `settle` waits for them, because the host
// half below reads a real `.trellis` tree and one tick is not always enough.
let inFlight = 0
const clientServices = {
  slots,
  locale: { getLocale: () => ({ active: 'zh' }), register: () => () => undefined },
}

// The one line that matters: the browser's fetch is answered by the Host's real route, so the
// round trip below crosses the same boundary production uses.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  inFlight += 1
  try {
    const answered = await askHost(url.searchParams.get('sessionId'), init?.method ?? 'GET')
    return {
      ok: answered.status >= 200 && answered.status < 300,
      status: answered.status,
      json: async () => answered.parsed,
    }
  } finally {
    inFlight -= 1
  }
}
const ctx = {
  ...clientServices,
  get: (key) => clientServices[key],
  effect: (fn) => fn(),
  interval: () => () => undefined,
}
client.apply(ctx)

const Cell = caught[0]?.component
check('the client registered a cell to drive', typeof Cell, 'function')
// The seat is the whole reason a cell exists, so the cross-half round trip below is driven by a
// cell that a declaration produced — not by one a permissive fake invented (prd.md R11).
check('the cell came from the header seat declaration', caught[0]?.options.name, 'conversation.session.header.actions')

// Without the header cell there is no round trip to observe, and the checks above have already
// named the missing seat. Requiring the *header* seat specifically means the dock cell cannot
// stand in for it.
if (caught[0]?.options.name !== 'conversation.session.header.actions') {
  await rm(scratch, { recursive: true, force: true })
  report()
  process.exit(1)
}

function render(sessionId = SESSION) {
  active = Cell
  cursor = 0
  const store = storeOf(Cell)
  store.pending = []
  const tree = Cell({ sessionId })
  for (const [index, effect] of store.pending) store.cleanups[index] = effect() ?? null
  return tree
}
async function settle(rounds = 60, sessionId = SESSION) {
  let tree = render(sessionId)
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
    // A resolved request marks the tree dirty; an outstanding one must not be waited out.
    if (!dirty && inFlight === 0) break
    dirty = false
    tree = render(sessionId)
  }
  return tree
}
const flatten = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  return (node.children ?? []).map(flatten).join('')
}
const findByClass = (node, className) => {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found !== null) return found
    }
    return null
  }
  if (node.props?.className === className) return node
  return findByClass(node.children ?? [], className)
}

const pill = await settle()
// R10: the root's title no longer prefixes the pill; the role chip carries the relationship.
check('the Host reply renders a child pill end to end', flatten(pill), '[P2] Wire the importer · 进行中 · 子任务')
check('no root-title prefix survives the round trip', flatten(pill).includes('›'), false)
check('the reply drives the role attribute too', findByClass(pill, 'trellis-statusline')?.props?.['data-role'], 'child')
check('the reply makes the pill clickable', findByClass(pill, 'trellis-statusline-pill')?.type, 'button')

findByClass(pill, 'trellis-statusline-pill').props.onClick()
const opened = await settle()
check('the reply fills the dropdown', flatten(findByClass(opened, 'trellis-statusline-menu')), [
  '[P1] Release 0.2 · 进行中',
  '[P2] Wire the importer · 进行中',
].join(''))
check('and only the session task is highlighted', findByClass(opened, 'trellis-statusline-menu')?.children?.map(
  (row) => row.props['data-current'],
), ['false', 'true'])

check('no field of the reply was left unused', [
  reply.value.task.priority,
  reply.value.tree.priority,
  reply.value.tree.children[0].title,
], ['P2', 'P1', 'Wire the importer'])

// --- A session the pointer does not name: the workspace count, and no title anywhere -------
const unnamed = await askHost(OTHER_SESSION)
check('a session without a pointer gets the workspace count', unnamed.parsed.value, {
  status: 'workspace',
  activeTasks: 2,
})
check('and that reply carries no task at all', Object.hasOwn(unnamed.parsed.value, 'task'), false)

const countPill = await settle(60, OTHER_SESSION)
check('the count renders as the workspace sentence', flatten(countPill), '工作区 2 个活动任务')
check('the count pill is a plain span with no role chip', [
  findByClass(countPill, 'trellis-statusline-pill')?.type,
  findByClass(countPill, 'trellis-statusline-role'),
], ['span', null])
// The outer box is what pins the pill's font metrics (`font:inherit` resolves against
// `.trellis-statusline`); a count pill rendered without it inherits the host's font size and
// looks oversized next to the task pill — which is exactly what shipped once.
check('the count pill keeps the same wrapper the task pill uses', [
  findByClass(countPill, 'trellis-statusline')?.props?.className,
  findByClass(countPill, 'trellis-statusline')?.props?.['data-role'],
], ['trellis-statusline', 'none'])
check('and it opens no menu when clicked', findByClass(countPill, 'trellis-statusline-pill')?.props?.onClick, undefined)
// The glyph is decoration: one inline 14x14 svg, outside the accessibility tree and unreachable by
// keyboard, while the pill itself stays the plain non-interactive span R2 describes.
check('the count pill leads with a decoration-only glyph', (() => {
  const glyph = findByClass(countPill, 'trellis-statusline-glyph')
  return [glyph?.type, glyph?.props?.['aria-hidden'], glyph?.props?.focusable, glyph?.props?.viewBox, glyph?.props?.tabIndex, glyph?.props?.onClick]
})(), ['svg', 'true', 'false', '0 0 14 14', undefined, undefined])
check('the glyph sits left of the sentence, which is unchanged', [
  findByClass(countPill, 'trellis-statusline-pill')?.children?.[0]?.props?.className,
  findByClass(countPill, 'trellis-statusline-pill')?.children?.[1]?.props?.className,
], ['trellis-statusline-glyph', 'trellis-statusline-count'])

// A session the Host knows nothing about: no task and no count, so the cell draws nothing.
const blankPill = await settle(60, 'session-00000000-0000-4000-8000-000000000000')
check('no task and no count renders nothing at all', [blankPill, flatten(blankPill)], [null, ''])

await rm(scratch, { recursive: true, force: true })

report()
