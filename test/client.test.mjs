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
import { readFile, stat } from 'node:fs/promises'

const clientUrl = new URL('../lib/client.js', import.meta.url)
const hostUrl = new URL('../lib/index.js', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}
/**
 * Print every result and set the exit code.
 *
 * A guard below calls this early, because a plugin whose seat is gone cannot be driven any
 * further: that case must be a *named* failure, not a TypeError forty lines down the file.
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
/** The slice of `document` the bundle touches: it appends one `<style>` and never reads one back. */
function makeDocument() {
  const tags = []
  return {
    tags,
    createElement(tag) {
      const node = { tag, dataset: {}, textContent: '', removed: false, remove() { this.removed = true } }
      return node
    },
    head: { append: (node) => tags.push(node) },
    querySelector: () => null,
  }
}
const page = makeDocument()
const styleTags = page.tags
globalThis.document = page

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
/**
 * The slot registry, modelled on the real one rather than on convenience
 * (`dsh-client-ui-renderer/lib/client.js:1343-1402`, `dsh-client-ui-slots/lib/index.js:163-165`):
 *
 * - `register` **throws** for a slot nobody declared — a renamed or removed seat is a hard
 *   error, not a cell that quietly does not exist;
 * - `inject` runs its callback only **while a declaration is live**: synchronously when the
 *   declaration already exists, otherwise at declaration time, and collapsing the declaration
 *   disposes the contribution and arms the wait again.
 *
 * The callback used to be invoked immediately, which is exactly the fake that would keep a
 * client half whose seat had been renamed green (prd.md R11 / AC9).
 *
 * @returns the fake service plus the shell's own side of the contract: `declare`, `unload`.
 */
function makeSlotRegistry() {
  const declared = new Set()
  const waiting = new Map()
  const mounted = []
  const injections = []

  const announce = (key) => {
    for (const reconcile of [...(waiting.get(key) ?? [])]) reconcile()
  }
  const register = (options, component) => {
    if (!declared.has(options.name)) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
    const entry = { options, component }
    mounted.push(entry)
    let held = true
    return () => {
      if (!held) return
      held = false
      const at = mounted.indexOf(entry)
      if (at >= 0) mounted.splice(at, 1)
    }
  }

  return {
    mounted,
    declared,
    register,
    inject(key, callback) {
      let contribution
      let live = true
      const reconcile = () => {
        if (!live) return
        if (declared.has(key)) {
          if (contribution === undefined) contribution = callback() ?? undefined
          return
        }
        const dispose = contribution
        contribution = undefined
        if (typeof dispose === 'function') dispose()
      }
      const watchers = waiting.get(key) ?? new Set()
      watchers.add(reconcile)
      waiting.set(key, watchers)
      reconcile()
      const release = () => {
        if (!live) return
        live = false
        watchers.delete(reconcile)
        const dispose = contribution
        contribution = undefined
        if (typeof dispose === 'function') dispose()
      }
      injections.push(release)
      return release
    },
    /** The shell declaring one of its seats; the returned function collapses it again. */
    declare(key) {
      if (declared.has(key)) return () => undefined
      declared.add(key)
      announce(key)
      return () => {
        if (!declared.has(key)) return
        declared.delete(key)
        announce(key)
      }
    },
    /** Unloading this plugin's fiber: every `inject` disposer runs, cells and all. */
    unload() {
      for (const release of [...injections]) release()
    },
  }
}

const registry = makeSlotRegistry()
const injected = []
const dictionaries = []
const intervals = []
const services = {
  slots: {
    inject(key, callback) {
      injected.push(key)
      return registry.inject(key, callback)
    },
    register: (options, component) => registry.register(options, component),
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
const registrations = registry.mounted
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

// The shell declares both seats, and *then* the plugin half loads — the ordinary order. The
// other order (plugin first) is exercised below.
registry.declare('conversation.session.header.actions')
registry.declare('conversation.input.dock')
exported.apply(ctx)

check('claims the two seats, header first', injected, [
  'conversation.session.header.actions',
  'conversation.input.dock',
])
check('registered two entries', registrations.length, 2)
// A cell only exists because its seat was declared: these two assertions are the ones that turn
// red when the header seat is renamed, instead of the suite staying green (prd.md R11 / AC9).
check('every seat the plugin joins is a seat the shell declared', injected.every((key) => registry.declared.has(key)), true)
check('the seats it joins are the two catalog keys', injected.slice().sort(), [
  'conversation.input.dock',
  'conversation.session.header.actions',
])

// Everything below inspects the two cells; without them there is nothing to inspect, and the
// failure that matters has already been reported above.
if (registrations.length !== 2) {
  report()
  process.exit(1)
}

const bySlot = Object.fromEntries(registrations.map((item) => [item.options.name, item]))
// `?? {}` rather than a bare `.options`: a seat that was renamed leaves this empty and every
// check below fails *with its own name*, instead of the harness dying on a TypeError.
const header = bySlot['conversation.session.header.actions']?.options ?? {}
check('header seat: slot name is the seat key', header.name, 'conversation.session.header.actions')
check('header seat: cell id', header.id, 'trellis-statusline')
// Right of `agent-preset` (-10) and left of `job-list` (20), both live occupants of this seat.
check('header seat: order sits between the preset selector and the jobs counter', header.order, 10)
check('header seat: locale namespace matches the registered one', header.locale, dictionaries[0]?.ns)

const dock = bySlot['conversation.input.dock']?.options ?? {}
check('hero seat: slot name is the seat key', dock.name, 'conversation.input.dock')
check('hero seat: cell id', dock.id, 'trellis-statusline-dock')
// The composer's own queue row is `queue` at order 20; our pill is ambient and follows it.
check('hero seat: order follows the composer queue row', dock.order, 30)
check('hero seat: shares the header cell locale namespace', dock.locale, dictionaries[0]?.ns)
// The overlay is no longer used: a flow row cannot fight the sibling usage plugin's overlay pill.
check('the measured overlay seat is gone', bySlot['shell.overlay'], undefined)

check('both seats registered a component', registrations.map((item) => typeof item.component), ['function', 'function'])
check('the two seats are different components', registrations[0].component === registrations[1].component, false)

// --- The declaration lifetime *is* the seat contract (prd.md R11 / AC9) --------------------
// The header seat belongs to another bundle. It can be renamed by a dsh upgrade, or simply not
// be declared on a composition that mounts a different shell — and in both cases this plugin
// must end up with *no* cell, never with a cell nobody can see. Each case below is driven
// through the real `apply`, so the plugin's own use of `slots.inject` is what is under test.

/** One mount of the client half over its own registry, with only the slots service wired up. */
function mountOver(mountRegistry) {
  const seenEffects = []
  const seenKeys = []
  const mountServices = {
    slots: {
      inject(key, callback) {
        seenKeys.push(key)
        return mountRegistry.inject(key, callback)
      },
      register: (options, component) => mountRegistry.register(options, component),
    },
    locale: { getLocale: () => ({ active: 'zh' }), register: () => () => undefined },
    timer: { interval: () => () => undefined },
  }
  // Its own page: the stylesheet ledger below belongs to the first mount, and a second mount
  // must not be able to add tags to it (that is the difference between counting one injection
  // and counting every mount this harness happens to make).
  const previousDocument = globalThis.document
  globalThis.document = makeDocument()
  try {
    exported.apply({
      ...mountServices,
      get: (serviceName) => mountServices[serviceName],
      effect: (callback, label) => {
        const disposer = callback()
        seenEffects.push({ label, disposer })
        return disposer
      },
      interval: () => () => undefined,
    })
  } finally {
    globalThis.document = previousDocument
  }
  return { registry: mountRegistry, keys: seenKeys, effects: seenEffects }
}

// (1) The plugin loads first and registers nothing yet — a seat that is not declared is a wait,
// not a registration, and not an error.
const early = mountOver(makeSlotRegistry())
check('a plugin that loads before the shell registers nothing yet', early.registry.mounted.length, 0)
check('and it waits on both seat keys rather than guessing', early.keys, [
  'conversation.session.header.actions',
  'conversation.input.dock',
])
check('waiting costs no error', early.effects.some((item) => String(item.label).includes('stylesheet')), true)

// (2) The declaration arrives later, exactly as `slots.inject` documents: the callback runs
// inside the declaring `register()`.
const declareHeader = early.registry.declare('conversation.session.header.actions')
check('the header declaration mounts the header cell', early.registry.mounted.map((item) => item.options.id), [
  'trellis-statusline',
])
const declareDock = early.registry.declare('conversation.input.dock')
check('the dock declaration mounts the dock cell', early.registry.mounted.map((item) => item.options.id), [
  'trellis-statusline',
  'trellis-statusline-dock',
])

// (3) Collapsing the declaration takes the cell with it — this is the direction a fake that
// called back immediately could never show, and the reason a removed seat is visible here.
declareHeader()
check('collapsing the header seat unmounts only its cell', early.registry.mounted.map((item) => item.options.id), [
  'trellis-statusline-dock',
])
early.registry.declare('conversation.session.header.actions')
check('a later declaration runs the callback again', early.registry.mounted.map((item) => item.options.id), [
  'trellis-statusline-dock',
  'trellis-statusline',
])

// (4) A seat that never arrives leaves the plugin with nothing registered and nothing thrown:
// the failure mode is an absent pill, which is why the two assertions above are the ones that
// must be red when the seat name moves.
const never = mountOver(makeSlotRegistry())
check('a shell that never declares the seats leaves no cell behind', never.registry.mounted.length, 0)
check('and unmounting such a plugin is harmless', (() => {
  never.registry.unload()
  return never.registry.mounted.length
})(), 0)

// (5) The registry itself is only as good as its refusal: registering into an undeclared seat
// must throw, since that is the real service's rule and the one this harness relies on.
check('the harness refuses a registration into an undeclared seat', (() => {
  try {
    makeSlotRegistry().register({ name: 'conversation.session.header.actions', id: 'x' }, () => null)
    return 'accepted'
  } catch (error) {
    return error.message
  }
})().startsWith('slot "conversation.session.header.actions" is not declared'), true)

declareDock()
check('collapsing the dock seat leaves the header cell alone', early.registry.mounted.map((item) => item.options.id), [
  'trellis-statusline',
])
check('unloading the fiber releases the last cell too', (() => {
  early.registry.unload()
  return early.registry.mounted.length
})(), 0)

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
// The host answers two endpoints on purpose: the second is the hub's status surface, which this
// bundle does not call (design.md §2.4). The pill's side of the contract is that it calls one,
// and that the host has it.
check('the pill calls exactly one endpoint', endpointsIn(clientSource), ['task/read'])
check('the host handles that endpoint and the hub status surface', endpointsIn(hostSource), ['status/read', 'task/read'])
check('client and host agree on the route prefix', [
  clientSource.includes("const ROUTE_PREFIX = '/trellis-statusline'"),
  hostSource.includes("const ROUTE_PREFIX = '/trellis-statusline'"),
], [true, true])
check('apply starts no poll of its own', intervals.length, 0)
check('the client owns the poll interval', clientSource.includes('REFRESH_INTERVAL_MS = 10_000'), true)
check('the host half holds no timer at all', clientSource.includes('ctx.interval(') && !hostSource.includes('setInterval'), true)
check('the client declares no npm dependency', packageJson.dependencies ?? null, null)

// --- Packaging metadata the shell reads without activating the plugin --------------------
// Verified against the shipped reader (`dsh-app-boot/lib/index.js:1860-1999`): title and
// description come from `<pkg>/locale/<lang>.json` (`meta.title` / `meta.description`, read from
// every `*.json` beside the English file) and are reached **through the `exports` map**, where an
// unlisted subpath is unreachable rather than merely undocumented; the icon is read straight off
// the manifest directory instead, so `exports` has no say in it.
check('the manifest declares a dsh peer, so an incompatible runtime denies the row', packageJson.peerDependencies, {
  '@deepseek-ai/dsh': '^0.2.0-rc.1',
})
check('the manifest declares a relative icon', [
  typeof packageJson.icon,
  packageJson.icon?.startsWith('/') ?? true,
], ['string', false])
// The icon is read straight off the manifest path, so `exports` has no say in it — but it must
// be a real file inside the manifest directory, and small enough for the reader's 256 KiB cap.
const iconBytes = (await stat(new URL(`../${packageJson.icon.replace(/^\.\//, '')}`, import.meta.url))).size
check('the icon is a shipped, small SVG file', [
  packageJson.files.includes('icon.svg'),
  packageJson.icon.endsWith('.svg'),
  iconBytes > 0 && iconBytes <= 256 * 1024,
], [true, true, true])
check('the locale files are exported and shipped', [
  packageJson.exports['./locale/*.json'],
  packageJson.files.includes('locale/*.json'),
], ['./locale/*.json', true])
const localeFiles = Object.fromEntries(
  await Promise.all(
    ['en', 'zh'].map(async (language) => [
      language,
      JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), 'utf8')),
    ]),
  ),
)
check('both locale files carry the display metadata', [
  typeof localeFiles.en.meta?.title,
  typeof localeFiles.en.meta?.description,
  typeof localeFiles.zh.meta?.title,
  typeof localeFiles.zh.meta?.description,
], ['string', 'string', 'string', 'string'])
check('the English title is the name the plugin shows', localeFiles.en.meta.title, 'Trellis Statusline')
check('the two titles differ, so the pair is not a copy-paste', localeFiles.zh.meta.title !== localeFiles.en.meta.title, true)

// --- A refused locale namespace costs the dictionaries, not the cell ---------------------
const logged = []
const originalError = console.error
console.error = (message) => logged.push(String(message))
const stylesheetsBefore = styleTags.length
// A plugin reload unloads the first fiber before mounting the second; the real registry refuses
// a duplicate (name, id, priority), so skipping this would model something that cannot happen.
const mountedBeforeReload = registrations.length
registry.unload()
check('unloading the plugin half takes both cells with it', registrations.length, mountedBeforeReload - 2)
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

report()
