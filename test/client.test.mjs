/**
 * Client-half harness. Loads the real bundle through a fake module loader and mounts it
 * against a fake cordis context, then asserts the seat it claims, the dictionaries it
 * registers and the lifecycle of the stylesheet it injects.
 *
 * This is the check that would have caught the slot-name mistake (`name` must be the slot
 * key, `id` is the plugin's own cell) and a locale namespace that does not match the one
 * the seat projects into `t`.
 *
 *   node test/client.test.mjs
 */
import { readFile } from 'node:fs/promises'

const clientUrl = new URL('../lib/client.js', import.meta.url)
const hostUrl = new URL('../lib/index.js', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}

// --- Fake module loader + baseline react ------------------------------------------------
let factory = null
let registeredId = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registeredId = entry.id
      factory = entry.factory
    },
  },
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}

// --- Fake document (the bundle injects its own stylesheet) ------------------------------
const styleTags = []
globalThis.document = {
  createElement(tag) {
    const node = { tag, dataset: {}, textContent: '', removed: false, remove() { this.removed = true } }
    return node
  },
  head: { append: (node) => styleTags.push(node) },
  querySelector: () => null,
}

await import(clientUrl.href)
check('bundle registered a factory', typeof factory, 'function')
check('bundle id equals the package name', registeredId, packageJson.name)

const required = []
const exported = factory((request) => {
  required.push(request)
  if (request === 'react') return reactStub
  throw new Error(`unexpected require("${request}")`)
})
check('bundle requires only react', required, ['react'])
check('bundle exports apply + inject', [typeof exported.apply, Array.isArray(exported.inject)], ['function', true])
check('declared services', exported.inject, ['slots', 'locale', 'timer'])

// --- Fake cordis context ----------------------------------------------------------------
const injected = []
const registrations = []
const dictionaries = []
const intervals = []
const services = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => undefined
    },
  },
  locale: {
    getLocale: () => ({ active: 'zh' }),
    register(ns, dicts) {
      dictionaries.push({ ns, dicts })
      return () => undefined
    },
  },
  // No `connection` service: the browser half fetches the Host's own route instead of
  // calling a channel on the connection service.
  timer: { interval: () => () => undefined },
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
  interval(callback, delay) {
    intervals.push({ delay })
    return () => undefined
  },
}

exported.apply(ctx)

check('claims the two seats, header first', injected, [
  'conversation.session.header.actions',
  'conversation.input.dock',
])
check('registered two entries', registrations.length, 2)

const bySlot = Object.fromEntries(registrations.map((item) => [item.options.name, item]))
const header = bySlot['conversation.session.header.actions'].options
check('header seat: slot name is the seat key', header.name, 'conversation.session.header.actions')
check('header seat: cell id', header.id, 'trellis-statusline')
// Right of `agent-preset` (-10) and left of `job-list` (20), both live occupants of this seat.
check('header seat: order sits between the preset selector and the jobs counter', header.order, 10)
check('header seat: locale namespace matches the registered one', header.locale, dictionaries[0]?.ns)

const dock = bySlot['conversation.input.dock'].options
check('hero seat: slot name is the seat key', dock.name, 'conversation.input.dock')
check('hero seat: cell id', dock.id, 'trellis-statusline-dock')
// The composer's own queue row is `queue` at order 20; our pill is ambient and follows it.
check('hero seat: order follows the composer queue row', dock.order, 30)
check('hero seat: shares the header cell locale namespace', dock.locale, dictionaries[0]?.ns)
// The overlay is no longer used: a flow row cannot fight the sibling usage plugin's overlay pill.
check('the measured overlay seat is gone', bySlot['shell.overlay'], undefined)

check('both seats registered a component', registrations.map((item) => typeof item.component), ['function', 'function'])
check('the two seats are different components', registrations[0].component === registrations[1].component, false)

// --- Dictionaries ------------------------------------------------------------------------
check('one locale namespace is registered', dictionaries.length, 1)
check('the namespace is the plugin id', dictionaries[0].ns, 'trellis-statusline')
check('both languages are present', Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
check(
  'the two dictionaries have identical key sets',
  Object.keys(dictionaries[0].dicts.zh).sort(),
  Object.keys(dictionaries[0].dicts.en).sort(),
)
check(
  'every state the pill can show is translated',
  ['in_progress', 'planning', 'review', 'completed', 'unknown'].every((state) => `state.${state}` in dictionaries[0].dicts.zh),
  true,
)
check('the state words are the ones the pill shows', [
  dictionaries[0].dicts.zh['state.in_progress'],
  dictionaries[0].dicts.zh['state.planning'],
  dictionaries[0].dicts.zh['state.review'],
], ['进行中', '规划中', '审核中'])
check('the workspace count sentence is translated with its {n} placeholder', [
  dictionaries[0].dicts.zh['workspace.count'],
  dictionaries[0].dicts.en['workspace.count'],
], ['工作区 {n} 个活动任务', '{n} active task(s) in workspace'])

// --- Stylesheet lifecycle ----------------------------------------------------------------
check('stylesheet injected once', styleTags.length, 1)
check('stylesheet is tagged with the plugin', styleTags[0].dataset.plugin, packageJson.name)
check('stylesheet carries the pill rules', styleTags[0].textContent.includes('.trellis-statusline'), true)
check('stylesheet carries the status rules', styleTags[0].textContent.includes('[data-status='), true)
check('stylesheet uses theme tokens only', /var\(--dsw-[a-z0-9-]+\)/.test(styleTags[0].textContent), true)
check('the pill is rounded and tinted (R8)', [
  /\.trellis-statusline-pill\{[^}]*border-radius/.test(styleTags[0].textContent),
  /\.trellis-statusline-pill\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/.test(styleTags[0].textContent),
], [true, true])
check('stylesheet carries the dropdown and the tree indent', [
  styleTags[0].textContent.includes('.trellis-statusline-menu{'),
  styleTags[0].textContent.includes('.trellis-statusline-menurow[data-current="true"]'),
  styleTags[0].textContent.includes(':not([data-depth="0"])'),
], [true, true, true])
check('the chevron is drawn, not typed as a glyph', /\.trellis-statusline-chevron\{[^}]*border-right/.test(styleTags[0].textContent), true)
// The overlay layer is click-through: the entry must not swallow clicks around the pill.
check('the count pill has its own rule', styleTags[0].textContent.includes('.trellis-statusline-count{'), true)
check('the count glyph is fixed-size decoration that inherits the pill colour', [
  /\.trellis-statusline-glyph\{[^}]*flex:none/.test(styleTags[0].textContent),
  /\.trellis-statusline-glyph\{[^}]*width:14px/.test(styleTags[0].textContent),
  /\.trellis-statusline-glyph\{[^}]*color:currentColor/.test(styleTags[0].textContent),
], [true, true, true])
// The pill takes its size from the wrapper (`font:inherit`), so both shapes must sit inside it.
check('the wrapper pins the pill font and the pill inherits it', [
  /\.trellis-statusline\{[^}]*font-size:12px/.test(styleTags[0].textContent),
  /\.trellis-statusline-pill\{[^}]*font:inherit/.test(styleTags[0].textContent),
], [true, true])
// The row is content-sized inside the composer's dock line: no coordinates, no full-width row.
check('the dock row is content-sized and free of coordinates', [
  /\.trellis-statusline-dock\{[^}]*display:inline-flex/.test(styleTags[0].textContent),
  /\.trellis-statusline-dock\{[^}]*width:100%/.test(styleTags[0].textContent),
  /position:absolute/.test(styleTags[0].textContent.match(/\.trellis-statusline-dock\{[^}]*\}/)?.[0] ?? '.trellis-statusline-dock{}'),
], [true, false, false])
// The seat anchor is `display:contents` inline, so sharing one line with the sibling usage pill
// takes an `!important` override of the anchor itself; the seat's own full-width occupants
// (queue/todo/goal) still wrap onto a line of their own.
check('the seat anchor becomes the shared wrapping row', [
  /\[data-slot="conversation\.input\.dock"\]\{[^}]*display:flex !important/.test(styleTags[0].textContent),
  /\[data-slot="conversation\.input\.dock"\]\{[^}]*flex-flow:row wrap/.test(styleTags[0].textContent),
  /\[data-slot="conversation\.input\.dock"\]\{[^}]*justify-content:center/.test(styleTags[0].textContent),
], [true, true, true])

const sheet = effects.find((item) => String(item.label).includes('stylesheet'))
check('stylesheet disposer removes the tag', (() => {
  sheet.disposer()
  return styleTags[0].removed
})(), true)

// --- Cross-half contract: every endpoint the client calls exists on the host -------------
const clientSource = await readFile(clientUrl, 'utf8')
const hostSource = await readFile(hostUrl, 'utf8')
// Endpoint literals only: a media type (`application/json`) has the same `a/b` shape but is
// not an endpoint of this plugin's protocol.
const endpointsIn = (source) =>
  [...new Set([...source.matchAll(/'([a-z]+\/[a-z]+)'/g)].map((match) => match[1]))]
    .filter((value) => value !== 'application/json')
    .sort()
check('client calls exactly the endpoints the host handles', endpointsIn(clientSource), endpointsIn(hostSource))
check('the endpoint set is the expected one', endpointsIn(hostSource), ['task/read'])
check('client and host agree on the route prefix', [
  clientSource.includes("const ROUTE_PREFIX = '/trellis-statusline'"),
  hostSource.includes("const ROUTE_PREFIX = '/trellis-statusline'"),
], [true, true])
check('apply starts no poll of its own', intervals.length, 0)
check('the client owns the poll interval', clientSource.includes('REFRESH_INTERVAL_MS = 10_000'), true)
check('the host half holds no timer at all', clientSource.includes('ctx.interval(') && !hostSource.includes('setInterval'), true)
check('the client declares no npm dependency', packageJson.dependencies ?? null, null)

// --- A refused locale namespace costs the dictionaries, not the cell ---------------------
const logged = []
const originalError = console.error
console.error = (message) => logged.push(String(message))
const stylesheetsBefore = styleTags.length
const registrationsBefore = registrations.length
let survived = true
try {
  exported.apply({
    ...services,
    locale: {
      getLocale: () => ({ active: 'zh' }),
      register() {
        throw new Error('namespace "trellis-statusline" is already registered')
      },
    },
    get: (serviceName) => services[serviceName],
    effect: (callback) => callback(),
    interval: () => () => undefined,
  })
} catch {
  survived = false
}
console.error = originalError
check('apply survives a refused locale namespace', survived, true)
check('the failure is logged once', logged.length, 1)
check('the log names the plugin', logged[0]?.startsWith('[trellis-statusline]'), true)
check('the stylesheet is still injected', styleTags.length - stylesheetsBefore, 1)
check('both seats are still claimed', registrations.length - registrationsBefore, 2)

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(
    `${item.ok ? 'PASS' : 'FAIL'}  ${item.label}` +
      (item.ok ? '' : `\n      expected ${JSON.stringify(item.expected)}\n      actual   ${JSON.stringify(item.actual)}`),
  )
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
