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

const SESSION = 'session-66d44746-abbf-4a3d-bd21-a9374eae2bd1'
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
let handler = null
const hostServices = {
  sessions: { get: (id) => (id === SESSION ? { header: { id, cwd: scratch } } : undefined) },
  workspaceRegistry: { list: () => [] },
  connection: { rpc: { handle: (channel, fn) => { handler = fn; return () => undefined } } },
  webServer: {},
}
host.apply({ ...hostServices, get: (key) => hostServices[key], effect: (fn) => fn() })

const reply = await handler('task/read', { sessionId: SESSION })
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
const clientServices = {
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => {
      caught.push({ options, component })
      return () => undefined
    },
  },
  locale: { getLocale: () => ({ active: 'zh' }), register: () => () => undefined },
  // The one line that matters: whatever the Host just produced is handed back verbatim.
  connection: { rpc: { call: async () => reply } },
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

function render() {
  active = Cell
  cursor = 0
  const store = storeOf(Cell)
  store.pending = []
  const tree = Cell({ sessionId: SESSION })
  for (const [index, effect] of store.pending) store.cleanups[index] = effect() ?? null
  return tree
}
async function settle(rounds = 12) {
  let tree = render()
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (!dirty) break
    dirty = false
    tree = render()
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
