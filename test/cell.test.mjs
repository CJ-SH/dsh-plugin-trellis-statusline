/**
 * Cell harness. Drives the real header cell with a minimal hook runtime, so the rendering
 * rules and the polling lifecycle are observable without a browser:
 * "ok renders [P1] title · state", "none renders nothing", "sessionId re-requests",
 * "unmount disposes the interval".
 *
 *   node test/cell.test.mjs
 */
import { readFile } from 'node:fs/promises'

const clientUrl = new URL('../lib/client.js', import.meta.url)

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}
/**
 * Print every result and set the exit code.
 *
 * A guard below calls this early: a cell that was never mounted cannot be driven, and that must
 * be a *named* failure rather than a TypeError further down.
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
    // React assigns a `ref` prop to its holder during commit; the cell relies on that to tell
    // an inside click from an outside one.
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
    // React disposes the previous effect before running the replacement — the same rule
    // that makes "switching session" observable here rather than only on unmount.
    if (typeof store.cleanups[index] === 'function') store.cleanups[index]()
    store.cleanups[index] = null
    store.deps[index] = list
    store.pending.push([index, effect])
  },
  useLayoutEffect: (effect, list) => reactStub.useEffect(effect, list),
}

let factory = null
globalThis.window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }

// The cell registers its dismissal listeners on `document` while the menu is open, so the stub
// has to own them: that is how a test can prove they are removed again.
const documentListeners = new Map()
const listenerCount = () => [...documentListeners.values()].reduce((total, set) => total + set.size, 0)
const fireDocument = (type, event) => {
  for (const handler of [...(documentListeners.get(type) ?? [])]) handler(event)
}
// The dock cell positions nothing, so there is no layout to feed it — the viewport stub exists
// only so the test can prove no resize listener is ever attached.
const viewListeners = new Map()
const viewListenerCount = () => [...viewListeners.values()].reduce((total, set) => total + set.size, 0)
const viewStub = {
  addEventListener(type, handler) {
    const set = viewListeners.get(type) ?? new Set()
    set.add(handler)
    viewListeners.set(type, set)
  },
  removeEventListener(type, handler) {
    viewListeners.get(type)?.delete(handler)
  },
}
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { append: () => undefined },
  defaultView: viewStub,
  addEventListener(type, handler) {
    const set = documentListeners.get(type) ?? new Set()
    set.add(handler)
    documentListeners.set(type, set)
  },
  removeEventListener(type, handler) {
    documentListeners.get(type)?.delete(handler)
  },
}

await import(clientUrl.href)
const exported = factory((request) => {
  if (request === 'react') return reactStub
  throw new Error(`unexpected require("${request}")`)
})

const SESSION = 'session-66d44746-abbf-4a3d-bbf1-a9374eae2bd1'
const OTHER = 'session-3724610a-d67b-4d50-97ab-e7856427ab12'
const TASK = { id: '09-15-trellis-statusline', title: 'Trellis statusline plugin for dsh web', status: 'in_progress', priority: 'P1' }

const calls = []
const intervals = []
const disposed = []
let reply = { ok: true, value: { status: 'ok', task: TASK } }
let rejectNext = false

const caught = []
/**
 * The slot registry's contract, in miniature (`dsh-client-ui-renderer/lib/client.js:1343-1402`,
 * `dsh-client-ui-slots/lib/index.js:163-165`): `register` refuses a seat nobody declared, and
 * `inject` runs its callback only while a declaration is live — synchronously when it already
 * exists, at declaration time otherwise, and disposed again when the declaration collapses.
 *
 * Calling the callback immediately is the fake that would keep this harness green after the
 * header seat was renamed, with `caught` full of cells no shell would ever render (prd.md R11).
 */
function makeSlots() {
  const declared = new Set()
  const waiting = new Map()
  const announce = (key) => {
    for (const reconcile of [...(waiting.get(key) ?? [])]) reconcile()
  }
  return {
    declare(key) {
      if (declared.has(key)) return
      declared.add(key)
      announce(key)
    },
    inject(key, callback) {
      let contribution
      let live = true
      const reconcile = () => {
        if (!live) return
        if (!declared.has(key)) {
          const dispose = contribution
          contribution = undefined
          if (typeof dispose === 'function') dispose()
          return
        }
        if (contribution === undefined) contribution = callback() ?? undefined
      }
      const watchers = waiting.get(key) ?? new Set()
      watchers.add(reconcile)
      waiting.set(key, watchers)
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
      if (!declared.has(options.name)) {
        throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
      }
      caught.push({ options, component })
      return () => undefined
    },
  }
}

const slots = makeSlots()
// The shell declares the two seats this plugin joins, and only then does its client half load.
slots.declare('conversation.session.header.actions')
slots.declare('conversation.input.dock')

const services = {
  slots,
  locale: {
    getLocale: () => ({ active: 'zh' }),
    register: () => () => undefined,
  },
}

// The browser half fetches the Host's own route; the harness answers every request from
// `reply`, so the assertions below keep driving one envelope.
const askedSession = (call) => new URL(call.url).searchParams.get('sessionId')
globalThis.fetch = async (input, init) => {
  calls.push({ url: String(input), init })
  if (rejectNext) {
    rejectNext = false
    throw new Error('socket closed')
  }
  return { ok: true, status: 200, json: async () => reply }
}
const ctx = {
  ...services,
  get: (serviceName) => services[serviceName],
  effect: (callback) => callback(),
  interval(callback, delay) {
    intervals.push({ delay, callback })
    return () => disposed.push(delay)
  },
}

exported.apply(ctx)
const Cell = caught[0]?.component
const DockCell = caught[1]?.component
check('captured the header cell', typeof Cell, 'function')
check('captured the dock cell', typeof DockCell, 'function')
// A cell is only ever captured *because* its seat was declared: rename the seat in the client
// half and this check turns red, where an immediately-invoked `inject` fake stayed green
// (prd.md R11 / AC9).
check('both cells came from a declared seat', caught.map((item) => item.options.name), [
  'conversation.session.header.actions',
  'conversation.input.dock',
])
check('apply itself starts no interval', intervals.length, 0)

// Nothing below can be about the pill if the header cell never arrived; the checks above have
// already said which seat is missing. (Both cells are required, so a dock cell standing in for
// the header one cannot be mistaken for a plugin that works.)
if (caught.length !== 2) {
  report()
  process.exit(1)
}

// --- Hook runtime driver ------------------------------------------------------------------
/** Drives any cell this bundle registered, not just the header one. */
function renderWith(component, props) {
  active = component
  cursor = 0
  const store = storeOf(component)
  store.pending = []
  const tree = component(props)
  for (const [index, effect] of store.pending) store.cleanups[index] = effect() ?? null
  return tree
}
async function settleWith(component, props, rounds = 12) {
  let tree = renderWith(component, props)
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (!dirty) break
    dirty = false
    tree = renderWith(component, props)
  }
  return tree
}
function render(props) {
  return renderWith(Cell, props)
}
async function settle(props, rounds = 12) {
  return settleWith(Cell, props, rounds)
}
const flatten = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  return (node.children ?? []).map(flatten).join('')
}
const findRoot = (node) => {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null
  return node.props?.className === 'trellis-statusline' ? node : null
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
/** The clickable pill, or the plain one — the difference is the element type. */
const pillOf = (tree) => findByClass(tree, 'trellis-statusline-pill')
const menuOf = (tree) => findByClass(tree, 'trellis-statusline-menu')
const rowIds = (menu) => (menu?.children ?? []).map((row) => row.props.key)
const rowDepths = (menu) => (menu?.children ?? []).map((row) => row.props['data-depth'])
const currentRows = (menu) => (menu?.children ?? []).filter((row) => row.props['data-current'] === 'true').map((row) => row.props.key)

// --- 1. A task is active ------------------------------------------------------------------
const tree = await settle({ sessionId: SESSION })
check('the cell requested this session over the plugin route', calls[0]?.url, `http://dsh.internal/trellis-statusline/task/read?sessionId=${SESSION}`)
check('the request is a GET accepting JSON', [calls[0]?.init?.method ?? 'GET', calls[0]?.init?.headers?.accept], ['GET', 'application/json'])
check('the pill reads [P1] title · state', flatten(tree), '[P1] Trellis statusline plugin for dsh web · 进行中')
check('the pill is one root element', findRoot(tree) !== null, true)
check('the root carries the state for styling', findRoot(tree)?.props?.['data-status'], 'in_progress')
check('the root carries the untruncated title', findRoot(tree)?.props?.title, TASK.title)
check('it polls on the designed cadence', intervals.map((entry) => entry.delay), [10_000])

// --- 2. Polling refreshes the pill --------------------------------------------------------
reply = { ok: true, value: { status: 'ok', task: { ...TASK, status: 'planning', priority: 'P2' } } }
intervals[0].callback()
check('the poll asks again', calls.length, 2)
check('the pill follows the new state', flatten(await settle({ sessionId: SESSION })), '[P2] Trellis statusline plugin for dsh web · 规划中')

// --- 3. No active task: the row must disappear, not go blank ------------------------------
reply = { ok: true, value: { status: 'none' } }
intervals[0].callback()
check('an empty state renders nothing at all', await settle({ sessionId: SESSION }), null)

// --- 4. Every failure mode is the same empty state ----------------------------------------
for (const [label, answer] of [
  ['a rejection', null],
  ['a malformed envelope', { ok: 'yes' }],
  ['a failed envelope', { ok: false, error: { code: 'unknown-endpoint', message: 'nope' } }],
  ['an unknown payload shape', { ok: true, value: { status: 'ok' } }],
]) {
  reply = answer
  intervals[0].callback()
  const settled = await settle({ sessionId: SESSION })
  check(`${label} renders nothing`, settled, null)
  reply = { ok: true, value: { status: 'ok', task: TASK } }
}
check('a rejected call is caught, not thrown', await (async () => {
  rejectNext = true
  intervals[0].callback()
  await new Promise((resolve) => setTimeout(resolve, 2))
  return (await settle({ sessionId: SESSION })) === null
})(), true)

// --- 5. An unknown task status still shows the task ---------------------------------------
reply = { ok: true, value: { status: 'ok', task: { ...TASK, status: 'archived' } } }
intervals[0].callback()
check('an unknown status falls back to a generic word', flatten(await settle({ sessionId: SESSION })), '[P1] Trellis statusline plugin for dsh web · 未知状态')

// `review` is a real Trellis status, reachable through the authoritative (and unfiltered)
// session-pointer path even though the scan never proposes it.
reply = { ok: true, value: { status: 'ok', task: { ...TASK, status: 'review' } } }
intervals[0].callback()
check('a review task gets its own word, not the generic one', flatten(await settle({ sessionId: SESSION })), '[P1] Trellis statusline plugin for dsh web · 审核中')

reply = { ok: true, value: { status: 'ok', task: { id: 'x', title: 'No priority', status: 'planning' } } }
intervals[0].callback()
check('a task without a priority drops the bracket', flatten(await settle({ sessionId: SESSION })), 'No priority · 规划中')

// --- 6. Switching session re-requests immediately -----------------------------------------
reply = { ok: true, value: { status: 'ok', task: TASK } }
const before = calls.length
await settle({ sessionId: OTHER })
check('a new sessionId triggers its own request', [calls.length - before, askedSession(calls.at(-1))], [1, OTHER])
check('a new sessionId starts its own interval', intervals.length, 2)
check('a new sessionId disposes the previous interval', disposed, [10_000])

// --- 7. Unmount disposes the interval -----------------------------------------------------
const store = storeOf(Cell)
for (const cleanup of store.cleanups) if (typeof cleanup === 'function') cleanup()
check('unmount disposed the remaining interval', disposed, [10_000, 10_000])

// --- 8. The cell survives a seat that does not project `t` --------------------------------
const plain = await settle({ sessionId: SESSION })
check('a missing translator still renders localized text', flatten(plain).endsWith('进行中'), true)

// --- 9. A stand-alone task stays inert (R6/AC7) -------------------------------------------
const lone = await settle({ sessionId: SESSION })
check('a stand-alone task renders no role', findByClass(lone, 'trellis-statusline-role'), null)
check('a stand-alone task renders no chevron', findByClass(lone, 'trellis-statusline-chevron'), null)
check('a stand-alone pill is not a button', pillOf(lone)?.type, 'span')
check('a stand-alone pill has no click handler', pillOf(lone)?.props?.onClick, undefined)
check('a stand-alone task opens no menu', menuOf(lone), null)
check('the root reports no role', findRoot(lone)?.props?.['data-role'], 'none')
check('a stand-alone task starts no document listener', listenerCount(), 0)

// --- 10. A task tree: roles, the root prefix and the dropdown -----------------------------
// `intervals.at(-1)` is the poll owned by the *live* effect: an earlier one was disposed when
// the session switched, and its closure ignores every later reply.
const refresh = () => intervals.at(-1).callback()

const ROOT = { id: '09-10-parent', title: 'Parent system', status: 'planning', priority: 'P1' }
const SIBLING = { id: '09-11-alpha', title: 'Alpha child', status: 'completed', priority: 'P3' }
const CHILD = { id: '09-12-beta', title: 'Beta child', status: 'in_progress', priority: 'P2' }
const GRAND = { id: '09-13-grand', title: 'Grand child', status: 'planning', priority: 'P4' }

/** The tree as the Host would send it, with `current` on whichever task the session is on. */
const treeFor = (currentId, nodes) => {
  const mark = (node) => {
    const wire = { id: node.id, title: node.title, status: node.status, priority: node.priority }
    if (node.id === currentId) wire.current = true
    const children = (node.children ?? []).map(mark)
    if (children.length > 0) wire.children = children
    return wire
  }
  return mark(nodes)
}
const nestedTree = { ...ROOT, children: [SIBLING, { ...CHILD, children: [GRAND] }] }
const readAs = (task, tree) => ({ ok: true, value: { status: 'ok', task, tree } })

// 10a. The session's task is the tree's root: the one and only parent task.
reply = readAs(ROOT, treeFor(ROOT.id, nestedTree))
refresh()
const asRoot = await settle({ sessionId: SESSION })
check('the root gets the parent-task role', flatten(asRoot), '[P1] Parent system · 规划中 · 父任务')
check('the root carries its role for styling', findRoot(asRoot)?.props?.['data-role'], 'root')
check('a task with a tree is a button', pillOf(asRoot)?.type, 'button')
check('the trigger advertises the popup', [
  pillOf(asRoot)?.props?.['aria-haspopup'],
  pillOf(asRoot)?.props?.['aria-expanded'],
], ['true', 'false'])

// 10b. A child shows only its own task: the relationship lives in the role chip and the
// dropdown, because R10 removed the `root › ` prefix.
reply = readAs(CHILD, treeFor(CHILD.id, nestedTree))
refresh()
const asChild = await settle({ sessionId: SESSION })
check('a child shows just its own task and the subtask role', flatten(asChild), '[P2] Beta child · 进行中 · 子任务')

// 10c. A grandchild is a subtask too — the label vocabulary has no third level (R7/AC8).
reply = readAs(GRAND, treeFor(GRAND.id, nestedTree))
refresh()
const asGrand = await settle({ sessionId: SESSION })
check('a grandchild is labelled a subtask', flatten(asGrand), '[P4] Grand child · 规划中 · 子任务')

// R10/AC11: no pill form carries a `›`, and the prefix element is gone from the tree entirely.
check('no pill form renders a root-title prefix', [
  findByClass(asGrand, 'trellis-statusline-parent'),
  [flatten(asRoot), flatten(asChild), flatten(asGrand)].some((text) => text.includes('›')),
], [null, false])

// --- 11. The dropdown --------------------------------------------------------------------
const openMenu = async () => {
  const settled = await settle({ sessionId: SESSION })
  if (menuOf(settled) === null) pillOf(settled).props.onClick()
  return settle({ sessionId: SESSION })
}

check('the menu is closed to begin with', menuOf(asGrand), null)
pillOf(asGrand).props.onClick()
const opened = await settle({ sessionId: SESSION })
check('clicking opens the menu', menuOf(opened) !== null, true)
check('the trigger now reports itself expanded', pillOf(opened)?.props?.['aria-expanded'], 'true')
check('the menu lists every member of the tree, root first', rowIds(menuOf(opened)), [
  ROOT.id,
  SIBLING.id,
  CHILD.id,
  GRAND.id,
])
check('each row carries its real depth', rowDepths(menuOf(opened)), ['0', '1', '1', '2'])
check('only the session task is highlighted', currentRows(menuOf(opened)), [GRAND.id])
check('rows are indented by depth', menuOf(opened)?.children?.map((row) => row.props.style.marginLeft), [
  '0px',
  '14px',
  '14px',
  '28px',
])
check(
  'menu rows show each task and its state',
  flatten(menuOf(opened)),
  '[P1] Parent system · 规划中[P3] Alpha child · 已完成[P2] Beta child · 进行中[P4] Grand child · 规划中',
)
check('opening registers the two dismissal listeners', listenerCount(), 2)

pillOf(await openMenu()).props.onClick()
check('clicking the trigger again closes it', menuOf(await settle({ sessionId: SESSION })), null)
check('closing removes the dismissal listeners', listenerCount(), 0)

await openMenu()
fireDocument('keydown', { key: 'Escape' })
check('Escape closes it', menuOf(await settle({ sessionId: SESSION })), null)

const outside = await openMenu()
const rootNode = findRoot(outside)
rootNode.contains = (target) => target === rootNode
fireDocument('pointerdown', { target: rootNode })
check('a click inside the cell keeps it open', menuOf(await settle({ sessionId: SESSION })) !== null, true)
fireDocument('pointerdown', { target: { tag: 'somewhere-else' } })
check('a click outside closes it', menuOf(await settle({ sessionId: SESSION })), null)
check('the outside click removed both listeners too', listenerCount(), 0)

// --- 12. Switching session closes an open menu and keeps listeners balanced ---------------
check('menu is open before the session switch', menuOf(await openMenu()) !== null, true)
const switched = await settle({ sessionId: OTHER })
check('switching session closes the menu', menuOf(switched), null)
check('switching session leaves no listener behind', listenerCount(), 0)

// --- 13. A tree the browser half cannot trust is dropped, not half-rendered ---------------
reply = readAs({ ...TASK, id: 'not-in-the-tree' }, treeFor(ROOT.id, nestedTree))
refresh()
const orphaned = await settle({ sessionId: OTHER })
check('a tree without the task itself degrades to a plain pill', [
  flatten(orphaned),
  findByClass(orphaned, 'trellis-statusline-role'),
], ['[P1] Trellis statusline plugin for dsh web · 进行中', null])

reply = { ok: true, value: { status: 'ok', task: TASK, tree: 'nonsense' } }
refresh()
check('a malformed tree is ignored', findByClass(await settle({ sessionId: OTHER }), 'trellis-statusline-role'), null)

// --- 14. Unmount releases the listeners it still owns --------------------------------------
reply = readAs(CHILD, treeFor(CHILD.id, nestedTree))
refresh()
const reopenLast = await settle({ sessionId: OTHER })
pillOf(reopenLast).props.onClick()
const stillOpen = await settle({ sessionId: OTHER })
check('the last menu is open before unmounting', menuOf(stillOpen) !== null, true)
check('and it holds document listeners', listenerCount(), 2)
for (const cleanup of storeOf(Cell).cleanups) if (typeof cleanup === 'function') cleanup()
check('unmount releases every document listener', listenerCount(), 0)

// --- 15. The new-session seat: the composer's input dock (R11, moved 2026-09-20) ----------
/**
 * A stand-in for the `useSessions` standard prop. The dock cell is session-scoped (it receives
 * `sessionId`) and reads that session's `blank` bit from the same store the shell uses to pick
 * the Hero — `SessionListState.byId[id].blank`, which `ConversationRoot` reads as `summaryBlank`.
 */
const sessionsWith = (blank, current = SESSION) => (selector) =>
  selector({ current, byId: current === undefined ? {} : { [current]: { blank } } })
const dockProps = (blank, sessionId = SESSION) => ({
  sessionId,
  ...(blank === undefined ? {} : { useSessions: sessionsWith(blank, sessionId) }),
})
const dockOf = (tree) => findByClass(tree, 'trellis-statusline-dock')

reply = readAs(ROOT, treeFor(ROOT.id, nestedTree))
const beforeDock = calls.length
const dock = await settleWith(DockCell, dockProps(true))
check('a blank session draws the dock row', dockOf(dock) !== null, true)
check('the dock pill reads the same task', flatten(dock), '[P1] Parent system · 规划中 · 父任务')
check('the dock pill requests this session', [calls.length - beforeDock, askedSession(calls.at(-1))], [1, SESSION])
check('the dock pill is the same clickable shape', pillOf(dock)?.type, 'button')
// The point of the move: a flow row is laid out by the composer, so nothing is measured and no
// listener is attached — the collision the measured overlay entry had cannot happen here.
check('the dock row measures nothing and listens to nothing', viewListenerCount(), 0)

const dockOpen = await (async () => {
  pillOf(dock).props.onClick()
  return settleWith(DockCell, dockProps(true))
})()
check('the dock dropdown opens', menuOf(dockOpen) !== null, true)
check('no seat needs a dropdown-direction flag', findByClass(menuOf(dockOpen), 'trellis-statusline-menu')?.props?.['data-placement'], undefined)

// The workspace-count reply renders in the dock too — the reason this seat grew a pill at all.
// A different session id is what re-triggers the request: the hook re-fetches only on a change.
reply = { ok: true, value: { status: 'workspace', activeTasks: 3 } }
const dockCount = await settleWith(DockCell, dockProps(true, OTHER))
check('the dock renders the workspace count', flatten(dockCount), '工作区 3 个活动任务')
// Same rule as the header form: the glyph is decoration, the pill stays a span with no tab stop.
check('the dock count pill is a span carrying one hidden glyph', (() => {
  const glyph = findByClass(dockCount, 'trellis-statusline-glyph')
  return [pillOf(dockCount)?.type, pillOf(dockCount)?.props?.tabIndex, glyph?.type, glyph?.props?.['aria-hidden']]
})(), ['span', undefined, 'svg', 'true'])
reply = readAs(ROOT, treeFor(ROOT.id, nestedTree))

// An ordinary conversation already carries the header pill: this one must stay empty — and free.
const beforeQuiet = calls.length
const intervalsBefore = intervals.length
check('a non-blank session renders nothing', await settleWith(DockCell, dockProps(false)), null)
check('and makes no request while hidden', [calls.length - beforeQuiet, intervals.length - intervalsBefore], [0, 0])

// Fail-closed edges: no session id, a list state that does not know this session, no store at all.
check('no sessionId renders nothing', await settleWith(DockCell, { useSessions: sessionsWith(true, undefined) }), null)
check('a list state without this session renders nothing', await settleWith(DockCell, dockProps(undefined)), null)
check('a seat without useSessions degrades instead of throwing', await settleWith(DockCell, { sessionId: SESSION }), null)

report()
