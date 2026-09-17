/**
 * dsh-plugin-trellis-statusline — browser half.
 *
 * Shipped in the module-loader bundle form: this file's only job is to register a factory
 * with the shell's loader, which materializes it as a plugin when the web shell needs it.
 * `react` is resolved from the platform baseline, so this bundle requests nothing else.
 *
 * One additive surface: a cell in `conversation.session.header.actions` — the title-adjacent
 * session actions row, immediately right of the session-preset selector — showing the Trellis
 * task the session's workspace is working on. The cell asks the Host half over the private
 * `/trellis-statusline` channel and renders nothing at all when there is no task — an ordinary
 * conversation must not grow a control for a capability it is not using.
 *
 * It registers its own locale namespace and lets the seat project `t`, which is how the
 * official same-header cells stay translatable without re-registering on a locale change.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-trellis-statusline',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const name = 'dsh-plugin-trellis-statusline'
    const inject = ['slots', 'locale', 'timer']

    /** Named-route prefix the Host half owns on the composition's web server. */
    const ROUTE_PREFIX = '/trellis-statusline'
    const ENDPOINT_READ = 'task/read'

    /** The seat: title-adjacent session actions, in ascending order. */
    const SEAT = 'conversation.session.header.actions'
    const CELL_ID = 'trellis-statusline'
    /**
     * Right of the session-preset selector (`agent-preset`, order -10) and left of the
     * background-jobs counter (`job-list`, order 20). The title-adjacent row has room for a
     * task title where the right-aligned utilities row does not.
     */
    const CELL_ORDER = 10

    /**
     * The second seat: the frame-wide overlay, positioned by measurement.
     *
     * It cannot be a seat *inside* the composer. The hero's composer stack is
     * `HeroShell → heroWorkspaceRow → conversation.input.dock → inputBar`, so the card is its
     * last child and nothing additive sits below it. `conversation.composer.dock` looks like one
     * from its catalog description ("below the composer card"), but its render site gates it on
     * `variant === "composer"` while the hero sets `variant === "hero"` — which is why the
     * render site, not the description, is what to read. So the overlay it is: root-scoped,
     * click-through, and the seat the sibling `dsh-plugin-ollama-usage` already anchors a hero
     * pill in.
     */
    const HERO_SEAT = 'shell.overlay'
    const HERO_CELL_ID = 'trellis-statusline-hero'
    /** Ahead of the overlay's shipped occupant (`ollama-cloud-model-picker`, order 100). */
    const HERO_CELL_ORDER = 1
    /** Gap between the card's bottom edge and the pill. */
    const HERO_GAP_PX = 6

    /** The slot protocol's own marker for the composer body — not a product CSS class. */
    const COMPOSER_SLOT_SELECTOR = '[data-slot="conversation.composer.bar"]'

    const REFRESH_INTERVAL_MS = 10_000

    /**
     * Statuses this seat has words for. Trellis' full vocabulary is
     * `planning | in_progress | review | completed` (`task.py`'s `--status` help); the session
     * pointer is the only source and it is unfiltered, so any of the four can arrive. Anything
     * outside this table falls back to a generic word rather than leaking a raw token into the
     * header.
     */
    const STATE_KEYS = {
      in_progress: 'state.in_progress',
      planning: 'state.planning',
      review: 'state.review',
      completed: 'state.completed',
    }
    const STATE_UNKNOWN = 'state.unknown'

    /**
     * The only two roles there are (R7): the tree's top ancestor is the one and only parent
     * task, and every other member — grandchildren included — is a subtask. There is no third
     * label to pick, which is what makes the header readable on an arbitrarily deep tree.
     */
    const ROLE_KEYS = { root: 'role.root', child: 'role.child' }

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'state.in_progress': '进行中',
      'state.planning': '规划中',
      'state.review': '审核中',
      'state.completed': '已完成',
      'state.unknown': '未知状态',
      'role.root': '父任务',
      'role.child': '子任务',
      'menu.aria': 'Trellis 任务树',
    }
    /** English dictionary, key-identical to the Chinese source of truth. */
    const en = {
      'state.in_progress': 'in progress',
      'state.planning': 'planning',
      'state.review': 'in review',
      'state.completed': 'completed',
      'state.unknown': 'unknown state',
      'role.root': 'parent task',
      'role.child': 'subtask',
      'menu.aria': 'Trellis task tree',
    }

    /**
     * Theme tokens only, so the pill follows light/dark without its own palettes.
     *
     * The chevron is drawn with two borders rather than a `▾` character: same reasoning as the
     * tree indent, which uses nesting margins instead of `├`/`└` — a glyph depends on the font
     * the user happens to run.
     */
    const CSS = [
      '.trellis-statusline{box-sizing:border-box;min-width:0;max-width:100%;align-items:center;display:inline-flex;position:relative;font-size:12px;line-height:18px}',
      '.trellis-statusline-pill{box-sizing:border-box;min-width:0;max-width:100%;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:0;border-radius:8px;align-items:center;gap:4px;padding:2px 8px;font:inherit;white-space:nowrap;display:inline-flex}',
      'button.trellis-statusline-pill{cursor:pointer}',
      'button.trellis-statusline-pill:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      'button.trellis-statusline-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      // The overlay entry: a zero-size, click-through box whose child carries the pill at the
      // measured coordinates, so the layer never blocks the app underneath.
      '.trellis-statusline-hero{position:absolute;left:0;top:0;width:100%;height:0;pointer-events:none}',
      '.trellis-statusline-hero-slot{position:absolute;left:0;top:0;display:inline-flex;pointer-events:auto}',
      '.trellis-statusline-priority{flex:none;color:var(--dsw-alias-brand-primary);font-weight:500;font-variant-numeric:tabular-nums}',
      '.trellis-statusline-title{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.trellis-statusline-separator{flex:none;opacity:.6}',
      '.trellis-statusline-state{flex:none}',
      '.trellis-statusline[data-status="in_progress"] .trellis-statusline-state{color:var(--dsw-alias-state-success-primary)}',
      '.trellis-statusline[data-status="planning"] .trellis-statusline-state{color:var(--dsw-alias-state-warn-primary)}',
      '.trellis-statusline-role{flex:none;border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:0 4px;font-size:11px;line-height:16px}',
      '.trellis-statusline-role[data-role="root"]{color:var(--dsw-alias-brand-primary)}',
      '.trellis-statusline-chevron{flex:none;width:5px;height:5px;margin-left:2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translate(-1px,-1px)}',
      '.trellis-statusline-chevron[data-open="true"]{transform:rotate(-135deg) translate(-1px,-1px)}',
      '.trellis-statusline-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:100;box-sizing:border-box;min-width:240px;max-width:min(460px,80vw);max-height:min(60vh,420px);overflow:auto;margin:0;padding:4px;list-style:none;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgb(0 0 0 / 18%));color:var(--dsw-alias-label-primary)}',
      '.trellis-statusline-menurow{box-sizing:border-box;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;white-space:nowrap;overflow:hidden;display:flex}',
      '.trellis-statusline-menurow:not([data-depth="0"]){border-left:1px solid var(--dsw-alias-border-l1)}',
      '.trellis-statusline-menurow[data-current="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}',
      '.trellis-statusline-menurow[data-current="true"] .trellis-statusline-menustate{color:var(--dsw-alias-brand-primary)}',
      '.trellis-statusline-menupriority{flex:none;font-variant-numeric:tabular-nums;opacity:.9}',
      '.trellis-statusline-menutitle{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.trellis-statusline-menustate{flex:none;color:var(--dsw-alias-label-secondary)}',
    ].join('\n')

    const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    const readText = (value) => (typeof value === 'string' ? value.trim() : '')

    /** Depth ceiling for decoding a tree: the Host sends a shallow one, and a malformed reply
     * must not be able to recurse the browser half off the stack. */
    const NODE_MAX_DEPTH = 8

    function errorMessage(error) {
      if (error === null || error === undefined) return 'unknown error'
      const message = error.message
      if (typeof message === 'string' && message.length > 0) return message
      return String(error)
    }

    /**
     * Chinese unless the locale service says otherwise — the same default the sibling plugin
     * uses, so a service that cannot answer does not silently flip the UI to English.
     */
    function activeIsChinese(locale) {
      try {
        const active = readText(locale.getLocale().active)
        return active.length === 0 ? true : active.indexOf('zh') === 0
      } catch {
        return true
      }
    }

    /**
     * Re-narrow the Host half's reply rather than trusting it. Anything that is not exactly
     * `{ status: 'ok', task: { title, status, ... } }` means "nothing to show" — the same
     * `null` this seat renders for a session without a task.
     *
     * `tree` is optional and decoded defensively: a tree the browser half cannot trust is
     * dropped rather than partially rendered, which degrades to the plain pill.
     */
    function decodeTask(value) {
      if (!isRecord(value) || value.status !== 'ok' || !isRecord(value.task)) return null
      const id = readText(value.task.id)
      const title = readText(value.task.title)
      const status = readText(value.task.status)
      if (title.length === 0 || status.length === 0) return null

      const task = { id, title, status, priority: readText(value.task.priority), tree: null }
      const tree = decodeNode(value.tree, 0)
      // A tree that does not contain the task it claims to describe is unusable: both the role
      // chip and the highlight are keyed off that id.
      if (tree !== null && id.length > 0 && containsId(tree, id)) task.tree = tree
      return task
    }

    /**
     * One tree node. The shape is the Host's `{ id, title, status, priority?, current?,
     * children? }`; anything unrecognised inside it is skipped instead of being trusted.
     */
    function decodeNode(value, depth) {
      if (!isRecord(value) || depth > NODE_MAX_DEPTH) return null
      const id = readText(value.id)
      const title = readText(value.title)
      const status = readText(value.status)
      if (id.length === 0 || title.length === 0 || status.length === 0) return null

      const node = {
        id,
        title,
        status,
        priority: readText(value.priority),
        current: value.current === true,
        children: [],
      }
      if (Array.isArray(value.children)) {
        for (const child of value.children) {
          const decoded = decodeNode(child, depth + 1)
          if (decoded !== null) node.children.push(decoded)
        }
      }
      return node
    }

    /** Whether `id` names a node anywhere in the decoded tree. */
    function containsId(node, id) {
      if (node.id === id) return true
      return node.children.some((child) => containsId(child, id))
    }

    /**
     * Depth-first rows for the dropdown, each carrying its own indent level. Kept as data (not
     * nested markup) so the menu stays a flat list the owner can scroll.
     */
    function flattenRows(node, depth, rows) {
      rows.push({ node, depth })
      for (const child of node.children) flattenRows(child, depth + 1, rows)
      return rows
    }

    /**
     * The first descendant (or self) that actually occupies a box.
     *
     * A slot outlet can be a `display:contents` wrapper, which generates no box at all and
     * measures as a zero rect — so a zero rect means "keep looking inside" rather than "gone".
     * The depth bound keeps a pathological tree from recursing forever.
     */
    function resolveBox(element, depth) {
      if (element === null || element === undefined) return null
      if (depth > 4) return null
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return { element, rect }
      for (const child of element.children ?? []) {
        const inner = resolveBox(child, depth + 1)
        if (inner !== null) return inner
      }
      return null
    }

    /** The composer body, found by the slot protocol's own marker rather than a CSS class. */
    function composerAnchor() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      const outlet = document.querySelector(COMPOSER_SLOT_SELECTOR)
      return outlet === null || outlet === undefined ? null : resolveBox(outlet, 0)
    }

    /**
     * Where to draw the pill so it sits centred just under the composer card.
     *
     * Coordinates come back relative to `root` — the overlay entry's own box — because the
     * overlay layer's origin is not the viewport. The anchor's own bottom padding is subtracted
     * so the pill lands under the card's visible edge rather than under a transparent band.
     *
     * @returns `{ left, top }`, or `null` while the layout cannot be measured; the caller then
     *   draws nothing, so a missing or reshaped composer degrades to "no hero pill".
     */
    function measureHero(root, slot) {
      if (root === null || slot === null) return null
      const own = root.getBoundingClientRect()
      const slotRect = slot.getBoundingClientRect()
      if (own.width === 0 || slotRect.width === 0) return null
      const anchor = composerAnchor()
      if (anchor === null || anchor.rect.width === 0) return null

      let paddingBottom = 0
      const view = typeof document === 'undefined' ? undefined : document.defaultView
      if (view !== null && view !== undefined && typeof view.getComputedStyle === 'function') {
        const parsed = Number.parseFloat(view.getComputedStyle(anchor.element).paddingBottom)
        if (Number.isFinite(parsed)) paddingBottom = parsed
      }

      return {
        left: anchor.rect.left + anchor.rect.width / 2 - own.left - slotRect.width / 2,
        top: anchor.rect.bottom - paddingBottom + HERO_GAP_PX - own.top,
      }
    }

    function makeApply(ctx) {
      const h = React.createElement
      const copy = activeIsChinese(ctx.locale) ? zh : en

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = name
        tag.textContent = CSS
        document.head.append(tag)
        return () => tag.remove()
      }, 'trellis-statusline: stylesheet')

      // Dictionaries are registered under the cell id, which is also the namespace handed to
      // the seat, so the `t` a cell receives resolves against exactly these keys. A namespace
      // that is refused (it is already taken, say) must cost the *shared* dictionaries only:
      // `StatuslineCell` reads the same table directly when the seat projects no `t`, so the
      // pill keeps working instead of the whole client half failing.
      try {
        ctx.effect(() => ctx.locale.register(CELL_ID, { zh, en }), 'trellis-statusline: dictionaries')
      } catch (error) {
        console.error(`[trellis-statusline] locale namespace unavailable: ${errorMessage(error)}`)
      }

      /**
       * The page's own origin, mirroring the shipped client halves.
       *
       * A page that is not served over http (Electron loads the built files over `file://`)
       * has origin `null`; the placeholder then points at nothing and the request fails into
       * the same "nothing to show" path as any other rejection.
       *
       * @returns the base URL the Host half's route is resolved against.
       */
      function hostBase() {
        const origin = globalThis.location?.origin
        return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
      }

      /**
       * One request to the Host half's route. A rejection is not an error surface: every
       * caller treats "no answer" as "nothing to show".
       *
       * The route applies the composition's trust fence before it answers, so a 401/403 and a
       * plain network failure are the same thing here.
       *
       * @param endpoint - the endpoint segment under {@link ROUTE_PREFIX}.
       * @param query - query parameters for the request.
       * @returns the answer's `value`, or null when the Host did not send one.
       */
      async function request(endpoint, query) {
        const url = new URL(`${ROUTE_PREFIX}/${endpoint}`, hostBase())
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        if (!response.ok) return null
        const answered = await response.json()
        if (!isRecord(answered) || answered.ok !== true) return null
        return answered.value
      }

      /**
       * The pill's state and markup, shared by both seats.
       *
       * A hook rather than a component: both seats need the same polling, the same dismissal
       * listeners and the same markup, and a component boundary would only add a nesting level
       * that changes nothing — while forcing the Hero seat to render it in order to decide
       * whether to show anything at all.
       *
       * @param sessionId - the session whose workspace to report on.
       * @param t - the seat's namespace translator, when it projects one; the same dictionaries
       *   are read directly otherwise, so a seat without a translator degrades to the locale
       *   captured at apply time instead of blanking out or throwing.
       * @param enabled - when false no request is made at all, so the seat that is not showing
       *   costs nothing. Effects still run unconditionally, as React requires.
       * @returns the pill element, or `null` when there is nothing to show.
       */
      function useTaskPill(sessionId, t, enabled) {
        const [task, setTask] = React.useState(null)
        const [open, setOpen] = React.useState(false)
        const rootRef = React.useRef(null)
        const say = typeof t === 'function' ? t : (key) => copy[key] ?? key

        React.useEffect(() => {
          if (!enabled) return undefined
          let live = true
          const refresh = () => {
            request(ENDPOINT_READ, { sessionId }).then(
              (value) => {
                if (live) setTask(decodeTask(value))
              },
              () => {
                if (live) setTask(null)
              },
            )
          }
          refresh()
          // Owned by this component: a new sessionId disposes it and starts a fresh one, and
          // unmounting leaves no timer behind.
          const stop = ctx.interval(refresh, REFRESH_INTERVAL_MS)
          return () => {
            live = false
            stop()
          }
        }, [sessionId, enabled])

        // Another session's tree has nothing to do with an open menu.
        React.useEffect(() => {
          setOpen(false)
        }, [sessionId])

        // While the menu is open, both dismissal routes live on `document` so they work no
        // matter where focus went. One effect owns both listeners so they can only be removed
        // together — and only while this cell is mounted.
        React.useEffect(() => {
          if (!open) return undefined
          const onPointerDown = (event) => {
            const root = rootRef.current
            const inside = root !== null && typeof root.contains === 'function' && root.contains(event.target)
            if (!inside) setOpen(false)
          }
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('pointerdown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open])

        if (task === null) return null

        const tree = task.tree
        // Only two roles exist (R7): the root ancestor is the one and only parent task, and
        // every other member of the tree — grandchildren included — is a subtask.
        const role = tree === null ? null : tree.id === task.id ? 'root' : 'child'
        const state = say(STATE_KEYS[task.status] ?? STATE_UNKNOWN)
        const bracket = task.priority.length === 0 ? null : `[${task.priority}]`

        const parts = []
        if (bracket !== null) parts.push(h('span', { className: 'trellis-statusline-priority', key: 'priority' }, bracket), ' ')
        parts.push(h('span', { className: 'trellis-statusline-title', key: 'title' }, task.title))
        parts.push(h('span', { className: 'trellis-statusline-separator', key: 'separator' }, ' · '))
        parts.push(h('span', { className: 'trellis-statusline-state', key: 'state' }, state))
        if (role !== null) {
          parts.push(h('span', { className: 'trellis-statusline-separator', key: 'role-separator' }, ' · '))
          parts.push(h('span', { className: 'trellis-statusline-role', key: 'role', 'data-role': role }, say(ROLE_KEYS[role])))
          parts.push(h('span', { className: 'trellis-statusline-chevron', key: 'chevron', 'data-open': open ? 'true' : 'false' }))
        }

        // A stand-alone task gets a plain `span`: no click target, no focus ring, no tab stop.
        const pillProps = { className: 'trellis-statusline-pill' }
        if (tree !== null) {
          pillProps.type = 'button'
          pillProps['aria-haspopup'] = 'true'
          pillProps['aria-expanded'] = open ? 'true' : 'false'
          pillProps.onClick = () => setOpen((current) => !current)
        }
        const pill = h(tree === null ? 'span' : 'button', pillProps, ...parts)

        let menu = null
        if (open && tree !== null) {
          const rows = flattenRows(tree, 0, []).map(({ node, depth }) => {
            const rowParts = []
            if (node.priority.length > 0) {
              rowParts.push(
                h('span', { className: 'trellis-statusline-menupriority', key: 'priority' }, `[${node.priority}]`),
                ' ',
              )
            }
            rowParts.push(
              h('span', { className: 'trellis-statusline-menutitle', key: 'title' }, node.title),
              h('span', { className: 'trellis-statusline-separator', key: 'separator' }, ' · '),
              h(
                'span',
                { className: 'trellis-statusline-menustate', key: 'state' },
                say(STATE_KEYS[node.status] ?? STATE_UNKNOWN),
              ),
            )
            return h(
              'li',
              {
                className: 'trellis-statusline-menurow',
                key: node.id,
                'data-depth': String(depth),
                'data-role': depth === 0 ? 'root' : 'child',
                'data-current': node.id === task.id ? 'true' : 'false',
                // Nested guide lines need the row's own edge to move inward, which padding
                // does not do — hence margin, with the CSS border sitting on that edge.
                style: { marginLeft: `${depth * 14}px` },
                title: node.title,
              },
              ...rowParts,
            )
          })
          menu = h(
            'ul',
            { className: 'trellis-statusline-menu', key: 'menu', 'aria-label': say('menu.aria') },
            rows,
          )
        }

        return h(
          'span',
          {
            className: 'trellis-statusline',
            'data-status': task.status,
            'data-role': role ?? 'none',
            title: task.title,
            ref: rootRef,
          },
          pill,
          menu,
        )
      }

      /** The session-header cell: the pill as the header's title-adjacent action. */
      function StatuslineCell({ sessionId, t }) {
        return useTaskPill(sessionId, t, true)
      }

      /**
       * The new-session cell, drawn in the frame overlay just below the composer card.
       *
       * A blank session is shown as the Hero, and the shell hides the entire session header
       * there (`.wSkVaW_headerHidden{display:none}`) — the header cell stays *mounted*, so it
       * cannot be the thing that decides to appear elsewhere. This seat therefore keys off the
       * same fact the shell itself uses to pick the Hero: `SessionListState.byId[id].blank`,
       * which `ConversationRoot` reads as `summaryBlank`. Being root-scoped it has no
       * `sessionId` prop, so it reads the current session from the same store.
       *
       * Not blank ⇒ `null`, so an ordinary conversation never grows a second pill — and
       * `enabled` keeps that seat from polling at all while it is hidden.
       *
       * The overlay is frame-wide, so the blank bit alone is not enough: a blank session stays
       * blank while another main panel (Settings, a board) is on screen, and the pill would
       * float over it. `PanelInfo.activePanelId === null` means "the Conversation is displayed",
       * which is the other half of the condition.
       */
      function HeroStatuslineCell({ t, useSessions, usePanelInfo }) {
        // Selectors each return a primitive: one building a fresh object would defeat the
        // store's reference comparison on every read.
        const sessionId = typeof useSessions === 'function' ? useSessions((state) => state.current) : undefined
        const blank =
          typeof useSessions === 'function'
            ? useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.blank))
            : undefined
        const panel = typeof usePanelInfo === 'function' ? usePanelInfo((state) => state.activePanelId) : undefined
        const enabled = blank === true && panel === null
        const pill = useTaskPill(sessionId, t, enabled)
        const [place, setPlace] = React.useState(null)
        const rootRef = React.useRef(null)
        const slotRef = React.useRef(null)
        // The task arrives one render after the mount, and the wrapper only exists once it has —
        // so the measuring effect must re-run when that happens. Keying it on `enabled` alone
        // would measure nothing on the first pass and never try again.
        const hasPill = pill !== null

        React.useEffect(() => {
          // Hooks stay unconditional (an early return before them would change the hook count
          // the moment `blank` flips); it is the work that is skipped.
          if (!enabled || !hasPill) return undefined
          const root = rootRef.current
          if (root === null) return undefined
          const apply = () => setPlace(measureHero(root, slotRef.current))
          apply()
          const view = typeof document === 'undefined' ? undefined : document.defaultView
          const anchor = composerAnchor()
          let observer = null
          if (view !== null && view !== undefined && typeof view.ResizeObserver === 'function') {
            observer = new view.ResizeObserver(apply)
            if (root.parentElement !== null) observer.observe(root.parentElement)
            if (anchor !== null) {
              observer.observe(anchor.element)
              if (anchor.element.parentElement !== null) observer.observe(anchor.element.parentElement)
            }
          }
          if (view !== null && view !== undefined && typeof view.addEventListener === 'function') {
            view.addEventListener('resize', apply)
          }
          return () => {
            if (observer !== null) observer.disconnect()
            if (view !== null && view !== undefined && typeof view.removeEventListener === 'function') {
              view.removeEventListener('resize', apply)
            }
          }
        }, [enabled, hasPill])

        if (!enabled || pill === null) return null

        // The wrapper has to exist before it can be measured, so it is always drawn and the slot
        // starts hidden — `visibility` keeps a box measurable, unlike `display:none`.
        const style =
          place === null ? { visibility: 'hidden' } : { left: `${place.left}px`, top: `${place.top}px` }
        return h(
          'div',
          { className: 'trellis-statusline-hero', ref: rootRef },
          h('div', { className: 'trellis-statusline-hero-slot', style, ref: slotRef }, pill),
        )
      }

      // `slots.inject` defers registration until the seat exists; a seat that was renamed or
      // is never rendered leaves this plugin inert instead of failing the client half.
      ctx.slots.inject(SEAT, () =>
        ctx.slots.register({ name: SEAT, id: CELL_ID, order: CELL_ORDER, locale: CELL_ID }, StatuslineCell),
      )
      // The overlay is click-through, so the entry opts back into pointer events on its own
      // content: the pill stays clickable while everything around it passes clicks through.
      ctx.slots.inject(HERO_SEAT, () =>
        ctx.slots.register(
          { name: HERO_SEAT, id: HERO_CELL_ID, order: HERO_CELL_ORDER, locale: CELL_ID },
          HeroStatuslineCell,
        ),
      )
    }

    function apply(ctx) {
      makeApply(ctx)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
