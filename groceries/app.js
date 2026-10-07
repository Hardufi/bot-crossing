import { STAPLES, STORAGE, FREEZER_DAYS, byKey, inSeason, searchCatalog, findByName } from './catalog.js'
import * as L from './logic.js'
import { loadLocal, localStore, openStore, deviceGet, deviceSet, stateFromStorageEvent } from './storage.js'

const TABS = ['check', 'pantry', 'shop', 'settings']
const TAB_LABELS = { check: 'בדיקה', pantry: 'מלאי', shop: 'קניות', settings: 'הגדרות' }
const ANSWER_LABELS = { fresh: 'במצב טוב', soon: 'לאכול בקרוב', later: 'נדחה למחר', eaten: 'סיימנו', spoiled: 'זרקנו' }
const LETTER_COLORS = ['#5c8a43', '#b8323a', '#d4691c', '#7a3b69', '#8a5a2b', '#3f7f7a']

// The page is a top-level app (own server, home-screen install) or framed inside claude.ai.
const TOP_LEVEL = window.self === window.top
const NOTIFY_SUPPORTED = TOP_LEVEL && 'Notification' in window

const root = document.getElementById('app')
document.documentElement.lang = 'he'
document.documentElement.dir = 'rtl'

let state = L.normalizeState(loadLocal())
let store = localStore
let today = L.isoDay()
let toastTimer = null

// Announcements live outside #app, which is rebuilt on every render: a live region that is
// re-created each time is announced unreliably, or over and over.
const polite = liveRegion('status')
const urgent = liveRegion('alert')

function liveRegion(role) {
  const el = document.createElement('div')
  el.className = 'sr-only'
  el.setAttribute('role', role)
  document.body.append(el)
  return el
}

function announce(text, region = polite) {
  region.textContent = ''
  setTimeout(() => {
    region.textContent = text
  }, 60)
}

const ui = {
  tab: initialTab(),
  sheet: null, // {type:'add', mode, query, kind} | {type:'edit', id, draft}
  followUp: null, // {item, kind, age, learnedBefore} after "eaten" or "spoiled"
  askFirst: null, // the item "ask now" was pressed on
  toast: null, // {text, undo}
  syncError: null,
  confirmReset: false,
  restoreOpen: false,
  copyFallback: null, // {where: 'shop' | 'backup', text} when the clipboard refused
  enter: new Set(), // what animates in on the next render: 'card', 'sheet', 'toast'
  focus: null, // a selector to focus after the next render
  opener: null, // the control that opened the current sheet, to return focus to
}

function initialTab() {
  const h = location.hash.slice(1)
  return TABS.includes(h) ? h : 'check'
}

// ---- helpers -------------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const pad = (n) => String(n).padStart(2, '0')

function shortDate(iso) {
  const [, m, d] = iso.split('-').map(Number)
  return `${d}.${m}`
}

function weekdayName(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('he-IL', { weekday: 'long' }).format(new Date(y, m - 1, d))
}

function whenText(iso) {
  const n = L.daysBetween(today, iso)
  if (n <= 0) return 'היום'
  if (n === 1) return 'מחר'
  if (n < 7) return weekdayName(iso)
  return shortDate(iso)
}

function colorFor(p) {
  if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) return p.color
  let h = 0
  for (const ch of p.name ?? '') h = (h * 31 + ch.codePointAt(0)) >>> 0
  return LETTER_COLORS[h % LETTER_COLORS.length]
}

function tile(p, size = '') {
  if (p.emoji) return `<span class="tile ${size}" aria-hidden="true">${esc(p.emoji)}</span>`
  const letter = [...(p.name ?? '?').trim()][0] ?? '?'
  return `<span class="tile tile-letter ${size}" style="--c:${colorFor(p)}" aria-hidden="true">${esc(letter)}</span>`
}

const icons = {
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.8-5"/>',
  pantry: '<rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M6 10h12M9.5 6v2M9.5 13v3"/>',
  shop: '<path d="M3.5 9.5h17l-1.6 9.2a2 2 0 0 1-2 1.7H7.1a2 2 0 0 1-2-1.7z"/><path d="M8.5 9.5 12 4l3.5 5.5M9.5 13v4M14.5 13v4"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
}
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`

function countText(n, one, many) {
  return n === 1 ? one : `${n} ${many}`
}

// ---- state changes -------------------------------------------------------------------------

function commit(mutate, { toast = null, undoable = true } = {}) {
  const before = state
  const draft = structuredClone(state)
  const result = mutate(draft)
  draft.updatedAt = Date.now()
  state = draft
  store.save(state)
  if (toast) showToast(toast, undoable ? before : null)
  render()
  return result
}

function showToast(text, undo = null) {
  ui.toast = { text, undo }
  ui.enter.add('toast')
  announce(text)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    ui.toast = null
    document.querySelector('.toast')?.remove()
  }, 5500)
}

// Another device, another window, or another person's leftover cache changed the state.
function adopt(data, why) {
  state = data ? L.normalizeState(data) : L.emptyState()
  if (ui.sheet?.type === 'edit' && !state.items.some((i) => i.id === ui.sheet.id)) ui.sheet = null
  if (ui.toast) ui.toast.undo = null // undoing now would roll back the other device's changes
  if (why === 'reset') {
    ui.followUp = null
    ui.toast = null
  }
  if (why === 'conflict') showToast('המלאי עודכן ממכשיר אחר. שינויים שנעשו כאן לפני הסנכרון לא נשמרו.')
  render()
}

openStore({
  getState: () => state,
  adopt,
  onStatus(message) {
    if (message === ui.syncError) return
    ui.syncError = message
    if (message) announce(message, urgent)
    render()
  },
}).then((s) => {
  store = s
  if (s.kind === 'cloud' && ui.tab === 'settings') render()
})

window.addEventListener('storage', (e) => {
  const data = stateFromStorageEvent(e)
  if (!data) return
  const next = L.normalizeState(data)
  if (next.updatedAt > state.updatedAt) adopt(next, 'newer')
})

// ---- views ---------------------------------------------------------------------------------

// Every render rebuilds #app, so focus is carried across by what the focused control does.
const FOCUS_ATTRS = ['data-act', 'data-id', 'data-key', 'data-kind', 'data-tab', 'data-delta', 'data-storage', 'data-outcome', 'data-mode', 'data-yes']

function focusSelector(el) {
  if (!el || el === document.body || !root.contains(el)) return null
  if (el.id) return '#' + CSS.escape(el.id)
  const parts = FOCUS_ATTRS.filter((a) => el.hasAttribute(a)).map((a) => `[${a}="${CSS.escape(el.getAttribute(a))}"]`)
  return parts.length ? parts.join('') : null
}

function render() {
  today = L.isoDay()
  const due = L.dueItems(state, today)
  const active = document.activeElement
  const hadFocus = Boolean(active && active !== document.body && root.contains(active))
  const wanted = ui.focus ?? (hadFocus ? focusSelector(active) : null)
  ui.focus = null
  const sheetScroll = document.querySelector('.sheet')?.scrollTop ?? 0

  if (ui.sheet?.type === 'edit' && !state.items.some((i) => i.id === ui.sheet.id)) ui.sheet = null
  const views = { check: viewCheck, pantry: viewPantry, shop: viewShop, settings: viewSettings }
  const overlay = ui.sheet ? renderSheet() : ui.followUp && ui.tab !== 'check' ? renderFollowUpSheet() : ''
  const inert = overlay ? 'inert' : ''
  const opened = { sheet: ui.enter.has('sheet'), card: ui.enter.has('card') }

  root.innerHTML = `
    <header class="mast" ${inert}>
      <div class="brand">
        <span class="brand-name">בתוקף</span>
        <span class="brand-sub">פירות וירקות בבית</span>
      </div>
      <time class="mast-date" datetime="${today}">${esc(new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()))}</time>
    </header>
    ${ui.syncError ? `<p class="banner banner-warn" ${inert}>${esc(ui.syncError)}</p>` : ''}
    <main class="view" id="view-${ui.tab}" ${inert}>${views[ui.tab](due)}</main>
    <nav class="tabbar" aria-label="ניווט" ${inert}>
      ${TABS.map(
        (t) => `<button class="tab" data-act="tab" data-tab="${t}" ${t === ui.tab ? 'aria-current="page"' : ''}>
          ${icon(t)}<span>${TAB_LABELS[t]}</span>
          ${t === 'check' && due.length ? `<b class="badge" aria-label="${due.length === 1 ? 'פריט אחד מחכה לבדיקה' : `${due.length} פריטים מחכים לבדיקה`}">${due.length}</b>` : ''}
          ${t === 'shop' && openShopping().length ? `<b class="badge badge-quiet">${openShopping().length}</b>` : ''}
        </button>`,
      ).join('')}
    </nav>
    ${overlay}
    ${ui.toast ? renderToast() : ''}
  `
  ui.enter.clear()
  document.body.classList.toggle('locked', Boolean(overlay))
  document.title = due.length ? `(${due.length}) בתוקף` : 'בתוקף'
  if (TOP_LEVEL && navigator.setAppBadge) (due.length ? navigator.setAppBadge(due.length) : navigator.clearAppBadge()).catch(() => {})

  const sheet = document.querySelector('.sheet')
  if (sheet) sheet.scrollTop = sheetScroll

  const $ = (sel) => (sel ? root.querySelector(sel) : null)
  let target = null
  if (opened.sheet) target = (ui.sheet?.type === 'add' && matchMedia('(pointer: fine)').matches && $('#add-q')) || $('#sheet-title')
  else if (opened.card && overlay) target = $('#f-name')
  target ??= $(wanted)
  // The control that had focus is gone (the question was answered): continue from the next card.
  if (!target && hadFocus) target = $('#q-name') ?? $('#f-name') ?? $('main h1')
  target?.focus({ preventScroll: true })
}

const openShopping = () => state.shopping.filter((s) => !s.done)

// -- check ----------------------------------------------------------------------------------

function viewCheck(due) {
  if (ui.followUp) return followUpCard()
  if (!state.items.length) return emptyStart()
  if (!due.length) return allDone()
  return questionCard(due.find((i) => i.id === ui.askFirst) ?? due[0], due.length)
}

function questionCard(item, remaining) {
  const f = L.freshness(item, today)
  const nextIfFresh = f.left <= 0 ? L.addDays(today, 1) : L.nextCheckAfterFresh(item, today)
  const where = STORAGE[item.storage] ?? ''
  return `
    <p class="queue">${remaining === 1 ? 'אחרון לבדיקה היום' : `עוד ${remaining} לבדיקה היום`}</p>
    <article class="qcard lvl-${f.level} ${ui.enter.has('card') ? 'enter' : ''}" aria-labelledby="q-name">
      <div class="qcard-top">
        ${tile(item, 'tile-xl')}
        <div class="qcard-title">
          <h1 class="qname" id="q-name" tabindex="-1">${esc(item.name)}</h1>
          ${item.qty ? `<p class="qty-tag">כמות: ${esc(item.qty)}</p>` : ''}
          <p class="qmeta">${[L.atHomeText(f.age), esc(where), `הערכה: ${L.aboutDays(item.shelfLife)}`].map((t) => `<span class="nb">${t}</span>`).join(' · ')}</p>
        </div>
      </div>
      ${dayStrip(item, f)}
      <h2 class="qask">עדיין בתוקף?</h2>
      <div class="answers">
        <button class="ans ans-fresh" data-act="answer" data-kind="fresh" data-id="${esc(item.id)}">
          <span class="ans-label">במצב טוב</span><span class="ans-hint">אשאל שוב ${L.inDaysText(L.daysBetween(today, nextIfFresh))}</span>
        </button>
        <button class="ans ans-soon" data-act="answer" data-kind="soon" data-id="${esc(item.id)}">
          <span class="ans-label">לאכול בקרוב</span><span class="ans-hint">אזכיר מחר</span>
        </button>
        <button class="ans ans-eaten" data-act="answer" data-kind="eaten" data-id="${esc(item.id)}">
          <span class="ans-label">סיימנו</span><span class="ans-hint">יוצא מהמלאי</span>
        </button>
        <button class="ans ans-spoiled" data-act="answer" data-kind="spoiled" data-id="${esc(item.id)}">
          <span class="ans-label">זרקנו</span><span class="ans-hint">אעדכן את ההערכה</span>
        </button>
      </div>
      <button class="link-btn" data-act="answer" data-kind="later" data-id="${esc(item.id)}">לדלג ולשאול מחר</button>
    </article>`
}

// One cell per day of the expected life, so "day 4 of about 5" can be seen rather than read.
function dayStrip(item, f) {
  const n = item.shelfLife
  const end = L.addDays(item.boughtOn, n)
  const label = `${L.atHomeText(f.age)}, מתוך ${L.aboutDays(n)}`
  let bar
  if (n <= 14) {
    const total = Math.min(16, Math.max(n, f.age + 1))
    const cells = []
    for (let i = 0; i < total; i++) {
      const cls = i < f.age ? 'past' : i === f.age ? 'now' : ''
      cells.push(`<i class="day ${cls} ${i >= n ? 'beyond' : ''}"></i>`)
    }
    bar = `<div class="days">${cells.join('')}</div>`
  } else {
    const pct = Math.min(100, Math.round((f.age / n) * 100))
    bar = `<div class="meter"><i style="inline-size:${pct}%"></i></div>`
  }
  return `
    <figure class="strip" role="img" aria-label="${esc(label)}">
      ${bar}
      <figcaption><span>קנייה ${shortDate(item.boughtOn)}</span><span>סוף משוער ${shortDate(end)}</span></figcaption>
    </figure>`
}

function followUpCard(asSheet = false) {
  const { item, kind, age, learnedBefore } = ui.followUp
  const onList = openShopping().some((s) => L.sameProduct(s, item))
  let tip = ''
  if (kind === 'spoiled') {
    const times = L.spoiledCount(state, item, today)
    const learned = state.learned[L.productId(item)]
    tip =
      times >= 2
        ? `זו הפעם ה־${times} החודש. אולי כדאי לקנות פחות בכל פעם.`
        : learned && learned !== learnedBefore
          ? `עדכנתי את ההערכה: מעכשיו ${L.aboutDays(learned)}.`
          : ''
  } else if (age < item.shelfLife / 2) {
    tip = `סיימנו תוך ${age ? L.daysText(age) : 'פחות מיום'}. אולי לקנות יותר בפעם הבאה?`
  }
  return `
    <article class="qcard follow ${ui.enter.has('card') ? 'enter' : ''}" aria-labelledby="f-name">
      <div class="qcard-top">
        ${tile(item, 'tile-xl')}
        <div class="qcard-title">
          <p class="eyebrow">${kind === 'eaten' ? 'סיימנו' : 'זרקנו'}</p>
          <h1 class="qname" id="f-name" tabindex="-1">${esc(item.name)}</h1>
        </div>
      </div>
      ${tip ? `<p class="tip">${esc(tip)}</p>` : ''}
      ${
        onList
          ? `<p class="qask">כבר ברשימת הקניות.</p>
             <div class="answers one"><button class="ans" data-act="buy-again"><span class="ans-label">המשך</span></button></div>`
          : `<h2 class="qask">לקנות שוב?</h2>
             <div class="answers">
               <button class="ans ans-fresh" data-act="buy-again" data-yes="1"><span class="ans-label">כן, לרשימה</span><span class="ans-hint">יופיע בקניות</span></button>
               <button class="ans" data-act="buy-again"><span class="ans-label">לא הפעם</span><span class="ans-hint">${asSheet ? 'סגירה' : 'לפריט הבא'}</span></button>
             </div>`
      }
    </article>`
}

function renderFollowUpSheet() {
  return `
    <div class="sheet-backdrop" data-act="buy-again"></div>
    <section class="sheet sheet-card ${ui.enter.has('card') ? 'enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="f-name">
      ${followUpCard(true)}
    </section>`
}

function emptyStart() {
  return `
    <section class="empty">
      <h1 class="empty-title">מה יש בבית?</h1>
      <p class="lede">מוסיפים את הפירות והירקות שקניתם. כשמגיע הזמן אשאל אם הם עדיין בתוקף, ומה שנגמר או התקלקל יעבור לרשימת הקניות.</p>
      <h2 class="section-label">הוספה מהירה</h2>
      <div class="pick-grid">${STAPLES.map((k) => pickTile(byKey(k), 'pantry')).join('')}</div>
      <div class="btn-row">
        <button class="btn btn-primary" data-act="open-add" data-mode="pantry">${icon('plus')}פריטים נוספים</button>
        <button class="btn" data-act="load-sample">לנסות עם מלאי לדוגמה</button>
      </div>
    </section>`
}

function allDone() {
  const upcoming = new Map()
  for (const i of [...state.items].sort((a, b) => (a.nextCheckOn < b.nextCheckOn ? -1 : 1))) {
    if (!upcoming.has(i.nextCheckOn)) {
      if (upcoming.size === 4) break
      upcoming.set(i.nextCheckOn, [])
    }
    upcoming.get(i.nextCheckOn).push(i)
  }
  const eatFirst = state.items.filter((i) => L.freshness(i, today).level !== 'fresh').sort(L.byUrgency(today))
  return `
    <section class="done">
      <h1 class="done-title">הכל נבדק להיום</h1>
      <p class="lede">אשאל שוב כשיגיע הזמן של כל פריט.</p>
      ${
        eatFirst.length
          ? `<h2 class="section-label">כדאי לאכול קודם</h2>
             <div class="chips">${eatFirst.map((i) => `<button class="chip lvl-${L.freshness(i, today).level}" data-act="edit" data-id="${esc(i.id)}">${tile(i, 'tile-sm')}${esc(i.name)}</button>`).join('')}</div>`
          : ''
      }
      <h2 class="section-label">השאלות הבאות</h2>
      <ol class="agenda">
        ${[...upcoming]
          .map(
            ([day, items]) => `<li>
              <span class="agenda-day">${esc(whenText(day))}</span>
              <span class="agenda-items">${items.map((i) => `${tile(i, 'tile-sm')}<span>${esc(i.name)}</span>`).join('')}</span>
            </li>`,
          )
          .join('')}
      </ol>
      <div class="btn-row">
        <button class="btn btn-primary" data-act="open-add" data-mode="pantry">${icon('plus')}הוספה למלאי</button>
        <button class="btn" data-act="tab" data-tab="pantry">לכל המלאי</button>
      </div>
    </section>`
}

// -- pantry ---------------------------------------------------------------------------------

function viewPantry() {
  const items = [...state.items].sort(L.byUrgency(today))
  const first = items.filter((i) => L.freshness(i, today).level !== 'fresh')
  const fresh = items.filter((i) => L.freshness(i, today).level === 'fresh')
  const hasSample = state.items.some((i) => i.sample)
  return `
    <div class="view-head">
      <div>
        <h1 class="view-title">מלאי</h1>
        <p class="view-sub">${items.length ? `${countText(items.length, 'פריט אחד', 'פריטים')}${first.length ? ` · ${first.length} לאכול קודם` : ''}` : 'ריק כרגע'}</p>
      </div>
      <button class="btn btn-primary" data-act="open-add" data-mode="pantry">${icon('plus')}הוספה</button>
    </div>
    ${hasSample ? `<p class="banner">זה מלאי לדוגמה, כדי לראות איך זה עובד. <button class="link-btn" data-act="clear-sample">ניקוי הדוגמה</button></p>` : ''}
    ${
      items.length
        ? `${first.length ? `<h2 class="section-label">לאכול קודם</h2><ul class="list">${first.map(pantryRow).join('')}</ul>` : ''}
           ${fresh.length ? `<h2 class="section-label">טרי</h2><ul class="list">${fresh.map(pantryRow).join('')}</ul>` : ''}`
        : `<p class="lede">אין כרגע פריטים במלאי. אפשר להוסיף ידנית, או לסמן פריטים ברשימת הקניות ולהעביר אותם לכאן אחרי הקנייה.</p>
           <div class="pick-grid">${STAPLES.map((k) => pickTile(byKey(k), 'pantry')).join('')}</div>`
    }`
}

function pantryRow(item) {
  const f = L.freshness(item, today)
  const due = L.isDue(item, today)
  return `<li>
    <button class="row row-pantry lvl-${f.level}" data-act="edit" data-id="${esc(item.id)}">
      ${tile(item)}
      <span class="row-main">
        <span class="row-name">${esc(item.name)}${item.qty ? ` <span class="qty">${esc(item.qty)}</span>` : ''}</span>
        <span class="row-sub">${esc(STORAGE[item.storage] ?? '')} · ${L.atHomeText(f.age)}${due ? ' · <b class="due-dot">מחכה לתשובה</b>' : ''}</span>
      </span>
      <span class="pill">${L.statusText(item, today)}</span>
    </button>
  </li>`
}

// -- shopping -------------------------------------------------------------------------------

function viewShop() {
  const open = openShopping()
  const inCart = state.shopping.filter((s) => s.done)
  const list = [...open, ...inCart]
  const again = L.recentlyFinished(state, today)
  const month = Number(today.slice(5, 7))
  const listed = new Set([...state.items, ...state.shopping].map(L.productId))
  const season = inSeason(month).filter((p) => !listed.has(L.productId(p)))
  const monthName = new Intl.DateTimeFormat('he-IL', { month: 'long' }).format(new Date())
  const text = shoppingText()
  return `
    <div class="view-head">
      <div>
        <h1 class="view-title">קניות</h1>
        <p class="view-sub">${!list.length ? 'הרשימה ריקה' : open.length ? `${countText(open.length, 'פריט אחד', 'פריטים')} ברשימה${inCart.length ? ` · ${inCart.length} בעגלה` : ''}` : 'הכל בעגלה'}</p>
      </div>
      <button class="btn btn-primary" data-act="open-add" data-mode="shop">${icon('plus')}הוספה</button>
    </div>
    ${
      list.length
        ? `<ul class="list">${list.map(shopRow).join('')}</ul>
           ${inCart.length ? `<button class="btn btn-primary wide" data-act="checkout">קניתי · להעביר ${countText(inCart.length, 'פריט אחד', 'פריטים')} למלאי</button>` : `<p class="hint">מסמנים מה נכנס לעגלה, ובסוף מעבירים הכל למלאי בלחיצה אחת.</p>`}
           ${
             open.length
               ? `<div class="btn-row">
                    <button class="btn" data-act="copy-list">העתקת הרשימה</button>
                    <a class="btn" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">שליחה בוואטסאפ</a>
                  </div>`
               : ''
           }
           ${copyFallback('shop')}`
        : `<p class="lede">כשמשהו נגמר או מתקלקל, אשאל אם להוסיף אותו לכאן.</p>`
    }
    ${again.length ? `<h2 class="section-label">נגמר לאחרונה</h2><div class="chips">${again.map((h) => chipAdd(h)).join('')}</div>` : ''}
    ${season.length ? `<h2 class="section-label">בעונה ב${esc(monthName)}</h2><div class="chips">${season.map((p) => chipAdd(p)).join('')}</div>` : ''}`
}

function shopRow(s) {
  return `<li class="shop-row ${s.done ? 'is-done' : ''}">
    <button class="row" role="checkbox" aria-checked="${s.done === true}" data-act="shop-toggle" data-id="${esc(s.id)}">
      <span class="box" aria-hidden="true"></span>
      ${tile(s)}
      <span class="row-main">
        <span class="row-name">${esc(s.name)}</span>
        ${s.note ? `<span class="row-sub">${esc(s.note)}</span>` : ''}
      </span>
    </button>
    <button class="icon-btn" data-act="shop-remove" data-id="${esc(s.id)}" aria-label="הסרת ${esc(s.name)} מהרשימה">${icon('close')}</button>
  </li>`
}

function chipAdd(p) {
  const attrs = p.key ? `data-key="${esc(p.key)}"` : `data-name="${esc(p.name)}"`
  return `<button class="chip" data-act="pick" data-mode="shop" ${attrs}>${tile(p, 'tile-sm')}${esc(p.name)}${icon('plus')}</button>`
}

function copyFallback(where) {
  if (ui.copyFallback?.where !== where) return ''
  return `<label class="field"><span>אפשר להעתיק מכאן:</span><textarea id="copy-fallback" rows="5" readonly dir="${where === 'backup' ? 'ltr' : 'rtl'}">${esc(ui.copyFallback.text)}</textarea></label>`
}

function shoppingText() {
  return ['רשימת קניות:', ...openShopping().map((s) => `• ${s.name}`)].join('\n')
}

// -- settings -------------------------------------------------------------------------------

function viewSettings() {
  const s = L.stats(state, today)
  // A typed name is stored squashed (no spaces or quotes); show it as it was typed.
  const typed = (pid) =>
    state.history.findLast((h) => L.productId(h) === pid) ?? state.items.find((i) => L.productId(i) === pid) ?? { name: pid.slice(5) }
  const learned = Object.entries(state.learned)
    .map(([pid, days]) => {
      const p = pid.startsWith('name:') ? typed(pid) : byKey(pid) ?? { name: pid }
      return { p, days, base: byKey(pid)?.days }
    })
    .filter((x) => x.days !== x.base)
  const notifyOn = NOTIFY_SUPPORTED && deviceGet('notify', false) && Notification.permission === 'granted'
  return `
    <h1 class="view-title">הגדרות</h1>

    <section class="panel">
      <h2>תזכורת יומית</h2>
      <label class="field field-inline"><span>באיזו שעה לשאול?</span><input type="time" id="remind-at" value="${esc(state.settings.remindAt)}"></label>
      <p class="hint">האפליקציה שואלת כשפותחים אותה. תזכורת ביומן תדאג שתפתחו אותה כל יום בשעה הזו.</p>
      <div class="btn-row">
        <a class="btn" id="gcal" href="${esc(googleCalendarUrl())}" target="_blank" rel="noopener">הוספה ליומן Google</a>
        ${TOP_LEVEL ? `<button class="btn" data-act="ics">קובץ ליומן של iPhone</button>` : ''}
      </div>
      ${
        NOTIFY_SUPPORTED
          ? `<label class="toggle"><input type="checkbox" id="notify" ${notifyOn ? 'checked' : ''}><span>התראה בשעה הזו כשיש מה לבדוק</span></label>
             <p class="hint">${Notification.permission === 'denied' ? 'הדפדפן חוסם התראות לאתר הזה. אפשר לאפשר אותן בהגדרות הדפדפן.' : 'עובד כשהאפליקציה פתוחה ברקע או מותקנת במסך הבית.'}</p>`
          : ''
      }
    </section>

    <section class="panel">
      <h2>30 הימים האחרונים</h2>
      ${
        s.eaten + s.spoiled
          ? `<dl class="stats">
               <div><dt>סיימנו</dt><dd>${s.eaten}</dd></div>
               <div><dt>זרקנו</dt><dd>${s.spoiled}</dd></div>
               <div><dt>הלך לפח</dt><dd>${Math.round(s.wasteRate * 100)}%</dd></div>
             </dl>
             ${s.topSpoiled.length ? `<p class="hint">בראש רשימת הפח: ${s.topSpoiled.map((t) => `${esc(t.name)} (${t.count})`).join(', ')}</p>` : ''}`
          : `<p class="hint">כאן יופיע כמה סיימתם וכמה נזרק, אחרי שתענו על כמה שאלות.</p>`
      }
    </section>

    ${
      learned.length
        ? `<section class="panel">
             <h2>מה למדתי מהתשובות שלכם</h2>
             <ul class="learned">${learned
               .map(({ p, days, base }) => `<li>${tile(p, 'tile-sm')}<span>${esc(p.name)}</span><span class="learned-days">${L.aboutDays(days)}${base ? ` <s>${base}</s>` : ''}</span></li>`)
               .join('')}</ul>
             <button class="link-btn" data-act="reset-learned">חזרה להערכות ההתחלתיות</button>
           </section>`
        : ''
    }

    <section class="panel">
      <h2>גיבוי</h2>
      <p class="hint">${store.kind === 'cloud' ? 'הנתונים נשמרים בחשבון Claude שלכם, גלויים רק לכם, ומסתנכרנים בין מכשירים.' : 'הנתונים נשמרים בדפדפן הזה בלבד. כדאי לשמור גיבוי מדי פעם.'}</p>
      <div class="btn-row">
        <button class="btn" data-act="copy-backup">העתקת גיבוי</button>
        <button class="btn" data-act="restore-open" aria-expanded="${ui.restoreOpen}">שחזור מגיבוי</button>
      </div>
      ${copyFallback('backup')}
      ${
        ui.restoreOpen
          ? `<form class="restore" data-form="restore">
               <label class="field"><span>מדביקים כאן את הגיבוי:</span><textarea id="restore-text" rows="4" dir="ltr"></textarea></label>
               <button class="btn btn-primary" type="submit">שחזור</button>
             </form>`
          : ''
      }
    </section>

    <section class="panel">
      <h2>מחיקת הכל</h2>
      <p class="hint">מוחק את המלאי, רשימת הקניות, ההיסטוריה ומה שנלמד.</p>
      <button class="btn btn-danger" data-act="reset">${ui.confirmReset ? 'למחוק באמת? לחיצה נוספת מוחקת' : 'מחיקת כל הנתונים'}</button>
    </section>`
}

function googleCalendarUrl() {
  const [h, m] = (state.settings.remindAt || '19:00').split(':')
  const day = today.replaceAll('-', '')
  const start = `${day}T${h}${m}00`
  const endMin = Number(h) * 60 + Number(m) + 10
  const end = endMin < 24 * 60 ? `${day}T${pad(Math.floor(endMin / 60))}${pad(endMin % 60)}00` : `${day}T235900`
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'בדיקת טריות · בתוקף',
    details: 'לפתוח את בתוקף ולענות מה עדיין טוב במקרר.' + (TOP_LEVEL ? '\n' + location.origin + location.pathname : ''),
    dates: `${start}/${end}`,
    ctz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jerusalem',
    recur: 'RRULE:FREQ=DAILY',
  })
  return 'https://calendar.google.com/calendar/render?' + params
}

function icsFile() {
  const [h, m] = (state.settings.remindAt || '19:00').split(':')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  const url = location.origin + location.pathname
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//betokef//he',
    'BEGIN:VEVENT',
    'UID:betokef-daily-check',
    `DTSTAMP:${stamp}`,
    `DTSTART:${today.replaceAll('-', '')}T${h}${m}00`,
    'DURATION:PT10M',
    'RRULE:FREQ=DAILY',
    'SUMMARY:בדיקת טריות · בתוקף',
    `DESCRIPTION:לפתוח את בתוקף ולענות מה עדיין טוב במקרר.\\n${url}`,
    `URL:${url}`,
    'BEGIN:VALARM',
    'TRIGGER:PT0M',
    'ACTION:DISPLAY',
    'DESCRIPTION:בדיקת טריות',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

// -- sheets ---------------------------------------------------------------------------------

function renderSheet() {
  const body = ui.sheet.type === 'add' ? addSheet() : editSheet()
  return `
    <div class="sheet-backdrop" data-act="close-sheet"></div>
    <section class="sheet ${ui.enter.has('sheet') ? 'enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      ${body}
    </section>`
}

function addSheet() {
  const { mode, query, kind } = ui.sheet
  return `
    <div class="sheet-head">
      <h2 id="sheet-title" tabindex="-1">${mode === 'shop' ? 'הוספה לרשימת הקניות' : 'הוספה למלאי'}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="סגירה">${icon('close')}</button>
    </div>
    <input class="search" id="add-q" type="text" inputmode="search" placeholder="חיפוש, או שם של משהו אחר" value="${esc(query)}" autocomplete="off" enterkeyhint="done">
    <div class="seg" role="group" aria-label="סינון">
      ${[
        ['all', 'הכל'],
        ['fruit', 'פירות'],
        ['veg', 'ירקות'],
      ]
        .map(([k, label]) => `<button class="seg-btn" data-act="add-kind" data-kind="${k}" aria-pressed="${kind === k}">${label}</button>`)
        .join('')}
    </div>
    <div class="pick-grid" id="add-results">${pickResults()}</div>
    <p class="hint">${mode === 'shop' ? 'כל לחיצה מוסיפה לרשימה.' : 'כל לחיצה מוסיפה פריט שנקנה היום. כמות, תאריך ומקום משנים בלחיצה על הפריט במלאי.'}</p>
    <button class="btn btn-primary wide" data-act="close-sheet">סיום</button>`
}

function pickResults() {
  const { mode, query, kind } = ui.sheet
  const results = searchCatalog(query, kind)
  const custom = query.trim() && !findByName(query)
  const customBtn = custom
    ? `<button class="pick pick-new" data-act="pick-custom" data-mode="${mode}">${icon('plus')}<span>הוספת "${esc(query.trim())}"</span></button>`
    : ''
  return results.map((p) => pickTile(p, mode)).join('') + customBtn + (!results.length && !custom ? '<p class="hint">לא נמצא.</p>' : '')
}

function pickTile(p, mode) {
  const have = mode === 'shop' ? openShopping().some((s) => s.key === p.key) : state.items.filter((i) => i.key === p.key).length
  const mark = mode === 'shop' ? (have ? '<em class="pick-count" aria-label="ברשימה">✓</em>' : '') : have ? `<em class="pick-count" aria-label="${have} במלאי">${have}</em>` : ''
  return `<button class="pick" data-act="pick" data-mode="${mode}" data-key="${p.key}">${tile(p, 'tile-lg')}<span>${esc(p.name)}</span>${mark}</button>`
}

function editSheet() {
  const item = state.items.find((i) => i.id === ui.sheet.id)
  if (!item) return ''
  const d = ui.sheet.draft
  const pid = L.productId(item)
  const base = byKey(item.key)?.days
  const learned = state.learned[pid]
  return `
    <div class="sheet-head">
      <h2 id="sheet-title" tabindex="-1">${tile(item, 'tile-sm')}${esc(item.name)}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="סגירה">${icon('close')}</button>
    </div>
    <form class="edit" data-form="edit">
      <label class="field"><span>שם</span><input id="e-name" value="${esc(d.name)}" required maxlength="40"></label>
      <label class="field"><span>כמות</span><input id="e-qty" value="${esc(d.qty)}" placeholder="למשל 6, חצי קילו" maxlength="24"></label>
      <div class="field"><span>איפה זה שמור</span>
        <div class="seg" role="group" aria-label="מקום">
          ${Object.entries(STORAGE)
            .map(([k, label]) => `<button type="button" class="seg-btn" data-act="edit-storage" data-storage="${k}" aria-pressed="${d.storage === k}">${label}</button>`)
            .join('')}
        </div>
      </div>
      <label class="field"><span>תאריך קנייה</span><input id="e-bought" type="date" value="${d.boughtOn}" max="${today}" required></label>
      <div class="field"><span>כמה ימים זה מחזיק בערך</span>
        <div class="stepper">
          <button type="button" class="icon-btn" data-act="edit-days" data-delta="1" aria-label="יום נוסף">${icon('plus')}</button>
          <output id="e-days">${d.shelfLife}</output>
          <button type="button" class="icon-btn" data-act="edit-days" data-delta="-1" aria-label="יום אחד פחות"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
        </div>
      </div>
      ${learned && base && learned !== base ? `<p class="hint">ההערכה ההתחלתית הייתה ${L.daysText(base)}. לפי התשובות שלכם עדכנתי ${L.toDays(learned)}.</p>` : ''}
      <p class="hint">השאלה הבאה: ${esc(whenText(item.nextCheckOn))}.</p>
      <button class="btn btn-primary wide" type="submit">שמירה</button>
    </form>
    <div class="sheet-actions">
      <button class="btn" data-act="edit-out" data-outcome="eaten">סיימנו</button>
      <button class="btn" data-act="edit-out" data-outcome="spoiled">זרקנו</button>
      <button class="btn" data-act="check-now">לשאול עכשיו</button>
    </div>
    <button class="link-btn link-danger" data-act="edit-delete">מחיקה (טעות בהזנה)</button>`
}

function readEditForm() {
  if (ui.sheet?.type !== 'edit') return
  const d = ui.sheet.draft
  const v = (id) => document.getElementById(id)?.value
  d.name = v('e-name')?.trim() || d.name
  d.qty = v('e-qty')?.trim() ?? d.qty
  d.boughtOn = v('e-bought') || d.boughtOn
}

function renderToast() {
  return `<div class="toast ${ui.enter.has('toast') ? 'enter' : ''}">
    <span>${esc(ui.toast.text)}</span>
    ${ui.toast.undo ? '<button class="toast-btn" data-act="undo">ביטול</button>' : ''}
  </div>`
}

// ---- actions -------------------------------------------------------------------------------

function entryFrom(el) {
  if (el.dataset.key) return byKey(el.dataset.key)
  if (el.dataset.name) return state.history.findLast((h) => h.name === el.dataset.name) ?? { name: el.dataset.name }
  return null
}

function addEntry(entry, mode) {
  if (!entry) return
  if (ui.sheet?.type === 'add') ui.sheet.query = ''
  if (mode !== 'shop') {
    commit((d) => L.addItem(d, entry, today), { toast: `נוסף למלאי: ${entry.name}` })
  } else if (openShopping().some((s) => L.sameProduct(s, entry))) {
    showToast(`כבר ברשימה: ${entry.name}`)
    render()
  } else {
    commit((d) => L.addToShopping(d, entry, today), { toast: `נוסף לרשימה: ${entry.name}` })
  }
}

function goTab(tab) {
  ui.tab = tab
  ui.copyFallback = null
  ui.restoreOpen = false
  ui.confirmReset = false
  try {
    history.replaceState(null, '', '#' + tab)
  } catch {}
  render()
  window.scrollTo({ top: 0 })
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text)
    showToast(done)
    render()
    return true
  } catch {
    return false
  }
}

function followUpFor(item, kind) {
  return { item, kind, age: L.freshness(item, today).age, learnedBefore: state.learned[L.productId(item)] }
}

function closeSheet() {
  ui.sheet = null
  ui.focus = ui.opener
  ui.opener = null
}

const actions = {
  tab: (el) => goTab(el.dataset.tab),

  answer(el) {
    const { id, kind } = el.dataset
    const item = state.items.find((i) => i.id === id)
    if (!item) return
    ui.enter.add('card')
    if (ui.askFirst === id) ui.askFirst = null
    if (kind === 'eaten' || kind === 'spoiled') ui.followUp = followUpFor(item, kind)
    commit((d) => L.answer(d, id, kind, today), { toast: `נרשם: ${item.name} · ${ANSWER_LABELS[kind]}` })
  },

  'buy-again'(el) {
    const f = ui.followUp
    ui.followUp = null
    ui.enter.add('card')
    if (f && el.dataset.yes) {
      const note = `${f.kind === 'eaten' ? 'סיימנו' : 'זרקנו'} · ${shortDate(today)}`
      commit((d) => L.addToShopping(d, f.item, today, note), { toast: `נוסף לרשימת הקניות: ${f.item.name}` })
    } else render()
  },

  'open-add'(el) {
    ui.toast = null
    ui.opener = focusSelector(el)
    ui.sheet = { type: 'add', mode: el.dataset.mode, query: '', kind: 'all' }
    ui.enter.add('sheet')
    render()
  },

  'add-kind'(el) {
    ui.sheet.kind = el.dataset.kind
    render()
  },

  pick: (el) => addEntry(entryFrom(el), el.dataset.mode),

  'pick-custom'(el) {
    const name = ui.sheet.query.trim()
    if (!name) return
    const kind = ui.sheet.kind === 'all' ? 'veg' : ui.sheet.kind
    ui.sheet.query = ''
    addEntry({ name, kind }, el.dataset.mode)
  },

  'close-sheet'() {
    closeSheet()
    render()
  },

  edit(el) {
    const item = state.items.find((i) => i.id === el.dataset.id)
    if (!item) return
    const { name, qty, storage, boughtOn, shelfLife } = item
    ui.toast = null
    ui.opener = focusSelector(el)
    ui.sheet = { type: 'edit', id: item.id, draft: { name, qty, storage, boughtOn, shelfLife } }
    ui.enter.add('sheet')
    render()
  },

  'edit-storage'(el) {
    readEditForm()
    const d = ui.sheet.draft
    const item = state.items.find((i) => i.id === ui.sheet.id)
    const next = el.dataset.storage
    if (next === d.storage) return
    if (next === 'freezer') d.shelfLife = FREEZER_DAYS
    else if (d.storage === 'freezer') {
      // Thawed: the kitchen clock starts from today.
      d.shelfLife = L.estimateDays(state, item, next)
      d.boughtOn = today
    }
    d.storage = next
    render()
  },

  'edit-days'(el) {
    readEditForm()
    const d = ui.sheet.draft
    d.shelfLife = Math.max(1, Math.min(365, d.shelfLife + Number(el.dataset.delta)))
    render()
    announce(L.daysText(d.shelfLife))
  },

  'edit-out'(el) {
    const id = ui.sheet.id
    const outcome = el.dataset.outcome
    ui.sheet = null
    ui.opener = null
    const item = state.items.find((i) => i.id === id)
    if (!item) return
    ui.followUp = followUpFor(item, outcome)
    ui.enter.add('card')
    commit((d) => L.removeItem(d, id, outcome, today), { toast: `נרשם: ${item.name} · ${ANSWER_LABELS[outcome]}` })
  },

  'check-now'() {
    const id = ui.sheet.id
    ui.sheet = null
    ui.opener = null
    ui.askFirst = id
    ui.enter.add('card')
    commit((d) => {
      const i = d.items.find((x) => x.id === id)
      if (i) i.nextCheckOn = today
    }, { undoable: false })
    ui.focus = '#q-name'
    goTab('check')
  },

  'edit-delete'() {
    const id = ui.sheet.id
    const item = state.items.find((i) => i.id === id)
    ui.sheet = null
    ui.opener = null
    commit((d) => L.removeItem(d, id, null, today), { toast: `נמחק מהמלאי: ${item?.name}` })
  },

  'shop-toggle': (el) => commit((d) => L.toggleShopping(d, el.dataset.id), { undoable: false }),

  'shop-remove'(el) {
    const s = state.shopping.find((x) => x.id === el.dataset.id)
    commit((d) => L.removeShopping(d, el.dataset.id), { toast: `הוסר מהרשימה: ${s?.name}` })
  },

  checkout() {
    const n = state.shopping.filter((s) => s.done).length
    commit((d) => L.checkout(d, today), { toast: `${countText(n, 'פריט אחד עבר', 'פריטים עברו')} למלאי` })
  },

  async 'copy-list'() {
    const text = shoppingText()
    if (!(await copyText(text, 'הרשימה הועתקה'))) {
      ui.copyFallback = { where: 'shop', text }
      render()
      document.getElementById('copy-fallback')?.select()
    }
  },

  'load-sample'() {
    const sample = [
      ['banana', 3, '6'],
      ['avocado', 2, '3'],
      ['cucumber', 4, '8'],
      ['tomato', 2, '1 ק״ג'],
      ['lettuce', 1, '1'],
      ['apple', 4, '5'],
      ['carrot', 6, ''],
      ['parsley', 1, 'צרור'],
    ]
    ui.enter.add('card')
    commit(
      (d) => {
        for (const [key, ago, qty] of sample) L.addItem(d, byKey(key), today, { boughtOn: L.addDays(today, -ago), qty, sample: true })
      },
      { toast: 'נטען מלאי לדוגמה' },
    )
  },

  'clear-sample'() {
    if (ui.followUp?.item.sample) ui.followUp = null
    commit((d) => L.clearSample(d), { toast: 'הדוגמה נוקתה' })
  },

  ics() {
    const blob = new Blob([icsFile()], { type: 'text/calendar' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'betokef-reminder.ics'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  },

  async 'copy-backup'() {
    const text = JSON.stringify(state)
    if (!(await copyText(text, 'הגיבוי הועתק. כדאי להדביק אותו בפתק או במייל לעצמכם.'))) {
      ui.restoreOpen = false
      ui.copyFallback = { where: 'backup', text }
      showToast('לא הצלחתי להעתיק אוטומטית. אפשר להעתיק מהתיבה.')
      render()
      document.getElementById('copy-fallback')?.select()
    }
  },

  'restore-open'() {
    ui.restoreOpen = !ui.restoreOpen
    render()
  },

  'reset-learned'() {
    commit(
      (d) => {
        d.learned = {}
      },
      { toast: 'חזרנו להערכות ההתחלתיות' },
    )
  },

  reset() {
    if (!ui.confirmReset) {
      ui.confirmReset = true
      render()
      setTimeout(() => {
        if (ui.confirmReset) {
          ui.confirmReset = false
          render()
        }
      }, 5000)
      return
    }
    ui.confirmReset = false
    ui.followUp = null
    commit(
      (d) => {
        Object.assign(d, L.emptyState(), { settings: d.settings })
      },
      { toast: 'כל הנתונים נמחקו' },
    )
  },

  undo() {
    if (!ui.toast?.undo) return
    state = { ...ui.toast.undo, updatedAt: Date.now() }
    store.save(state)
    ui.toast = null
    ui.followUp = null
    ui.enter.add('card')
    render()
  },
}

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]')
  if (!el || !root.contains(el)) return
  const act = actions[el.dataset.act]
  if (!act) return
  e.preventDefault()
  act(el, e)
})

root.addEventListener('input', (e) => {
  if (e.target.id === 'add-q' && ui.sheet?.type === 'add') {
    ui.sheet.query = e.target.value
    document.getElementById('add-results').innerHTML = pickResults()
  }
})

root.addEventListener('change', async (e) => {
  const t = e.target
  // Saved in place: a full render here would rebuild the field while it is still being typed.
  if (t.id === 'remind-at' && t.value && t.value !== state.settings.remindAt) {
    state = { ...state, settings: { ...state.settings, remindAt: t.value }, updatedAt: Date.now() }
    store.save(state)
    document.getElementById('gcal')?.setAttribute('href', googleCalendarUrl())
    announce(`התזכורת תהיה ב־${t.value}`)
  }
  if (t.id === 'notify') {
    if (t.checked && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied')
      deviceSet('notify', p === 'granted')
    } else deviceSet('notify', t.checked)
    render()
    maybeNotify()
  }
})

root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'add-q') {
    e.preventDefault()
    // Enter (or the keyboard's Done key) on an empty search only closes the keyboard.
    if (!ui.sheet?.query?.trim()) return
    document.querySelector('#add-results [data-act]')?.click()
  }
})

root.addEventListener('submit', (e) => {
  e.preventDefault()
  const form = e.target.dataset.form
  if (form === 'edit') {
    readEditForm()
    const { id, draft } = ui.sheet
    closeSheet()
    commit((d) => L.editItem(d, id, draft, today), { toast: 'נשמר' })
  }
  if (form === 'restore') {
    let parsed
    try {
      parsed = JSON.parse(document.getElementById('restore-text').value)
    } catch {
      showToast('זה לא נראה כמו גיבוי של בתוקף. מדביקים את כל הטקסט שהועתק.')
      render()
      return
    }
    if (!L.looksLikeBackup(parsed)) {
      showToast('זה לא נראה כמו גיבוי של בתוקף. מדביקים את כל הטקסט שהועתק.')
      render()
      return
    }
    const restored = L.normalizeState(parsed)
    const n = restored.items.length
    ui.restoreOpen = false
    ui.followUp = null
    commit(
      (d) => {
        Object.assign(d, restored)
      },
      { toast: n === 1 ? 'שוחזר פריט אחד במלאי' : `שוחזרו ${n} פריטים במלאי` },
    )
  }
})

window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1)
  if (TABS.includes(tab) && tab !== ui.tab) goTab(tab)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (ui.sheet || (ui.followUp && ui.tab !== 'check'))) {
    if (ui.sheet) closeSheet()
    else ui.followUp = null
    render()
  }
})

// ---- reminders -----------------------------------------------------------------------------

async function maybeNotify() {
  if (!NOTIFY_SUPPORTED || !deviceGet('notify', false) || Notification.permission !== 'granted') return
  const now = new Date()
  if (`${pad(now.getHours())}:${pad(now.getMinutes())}` < state.settings.remindAt) return
  const day = L.isoDay(now)
  if (deviceGet('notifiedOn') === day) return
  // Having the app open after the reminder time counts as today's reminder.
  if (document.visibilityState === 'visible') {
    deviceSet('notifiedOn', day)
    return
  }
  const due = L.dueItems(state, day)
  if (!due.length) return
  deviceSet('notifiedOn', day)
  const title = due.length === 1 ? `${due[0].name}: עדיין בתוקף?` : `${due.length} פריטים מחכים לבדיקה`
  const body = due.length === 1 ? 'לחיצה פותחת את השאלה.' : due.slice(0, 5).map((i) => i.name).join(', ')
  const options = { body, tag: 'betokef-daily', icon: 'icon-192.png', badge: 'icon-192.png', lang: 'he', dir: 'rtl' }
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null)
  if (reg) reg.showNotification(title, options)
  else new Notification(title, options)
}

setInterval(() => {
  if (L.isoDay() !== today) render()
  maybeNotify()
}, 60_000)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && L.isoDay() !== today) render()
  maybeNotify()
})

if (TOP_LEVEL && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {})
}

render()
