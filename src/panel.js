// Tray panel renderer. Everything arrives already computed from main.js
// (lib.js owns that logic), so this file only paints and forwards clicks.

const headline = document.getElementById('headline')
const content = document.getElementById('content')
const accountList = document.getElementById('account-list')
const syncBtn = document.getElementById('sync-btn')
const settingsBtn = document.getElementById('settings-btn')
const minimizeBtn = document.getElementById('minimize-btn')
const addAccountBtn = document.getElementById('add-account-btn')
const quitBtn = document.getElementById('quit-btn')

let labels = {}
// The only state this renderer owns, and it is deliberate: which block is asking
// before it deletes. It is pure display, it must survive the re-render that every
// reading triggers, and pushing it through the main process would buy nothing.
let confirmingId = null
let lastState = null

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )
}

function gaugesHtml(gauges) {
  if (!gauges || gauges.length === 0) {
    return '<div class="gauges-empty">' + escapeHtml(labels.empty || '') + '</div>'
  }

  return gauges.map(g => `
    <div class="gauge">
      <div class="gauge-header">
        <span class="gauge-label">${escapeHtml(g.label)}</span>
        <span class="gauge-reset">${g.reset ? escapeHtml((labels.reset || '{time}').replace('{time}', g.reset)) : ''}</span>
      </div>
      <div class="gauge-row">
        <div class="gauge-track">
          <div class="gauge-fill" style="width:${g.percent}%; background:${escapeHtml(g.color)}"></div>
        </div>
        <span class="gauge-value">${g.percent}%</span>
      </div>
    </div>
  `).join('')
}

/** Host only — the full endpoint would swamp a 320px panel. */
function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Only the active account's payload is ever posted, so only it reports a delivery. */
function deliveryHtml(account, endpoint) {
  if (!account.active || !endpoint) return ''
  const status = account.delivery ? account.delivery.status : ''
  const outcome = account.delivery ? account.delivery.message : labels.pending
  return `
    <div class="delivery ${escapeHtml(status)}">
      <span class="delivery-dot"></span>
      <span>→ ${escapeHtml(hostOf(endpoint))} · ${escapeHtml(outcome || '')}</span>
    </div>
  `
}

const LOGIN_ICON = '<svg viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>'

function loginButtonHtml(account) {
  return `
    <button class="btn btn-secondary" data-action="relogin" data-id="${escapeHtml(account.id)}">
      ${LOGIN_ICON}
      <span>${escapeHtml(account.loginLabel || '')}</span>
    </button>
  `
}

/** The pill and the login button only earn their place when the user is needed. */
function troubleHtml(account) {
  if (account.status !== 'error' && account.status !== 'login') return ''
  return `
    <div class="status-bar ${escapeHtml(account.status)}">
      <div class="status-dot"></div>
      <span class="status-text">${escapeHtml(account.message || '')}</span>
    </div>
    ${loginButtonHtml(account)}
  `
}

/**
 * A brand new account waiting on its login window. No name, no reading, nothing
 * worth a header or an empty gauge list — just what the user has to do next.
 */
function pendingHtml(account) {
  return `
    <div class="account pending">
      <div class="empty-state">
        <span class="empty-title">${escapeHtml(account.message || '')}</span>
        ${loginButtonHtml(account)}
      </div>
    </div>
  `
}

/**
 * The block header: name on the left, the remove button on the right. Always
 * shown, even for a lone account — hiding it there left no way to remove that
 * account at all. The active block is not a switch target, so it carries no
 * data-action and does not pretend to be clickable.
 */
function headHtml(account) {
  const id = escapeHtml(account.id)
  const switchable = account.active ? '' : ` data-action="activate" data-id="${id}"`
  const title = account.active ? '' : escapeHtml(labels.activate || '')
  const summary = account.expanded
    ? ''
    : `<span class="account-summary">${escapeHtml(account.summary || account.message || '')}</span>`
  return `
    <div class="account-head">
      <button class="account-switch"${switchable} title="${title}">
        <span class="account-dot"></span>
        <span class="account-name">${escapeHtml(account.name)}</span>
        ${summary}
      </button>
      <button class="account-remove" data-action="ask-remove" data-id="${id}"
              title="${escapeHtml(labels.removeAccount || '')}">
        <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>
  `
}

/** Nothing to show yet: the invitation takes the middle of the panel. */
function emptyStateHtml() {
  return `
    <div class="empty-state">
      <span class="empty-title">${escapeHtml(labels.noAccount || '')}</span>
      <button class="btn btn-secondary" data-action="add">
        <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span>${escapeHtml(labels.addAccount || '')}</span>
      </button>
    </div>
  `
}

/** Asked in place of the gauges, so the question sits where the block was. */
function confirmHtml(account) {
  return `
    <div class="confirm-row">
      <button class="btn btn-secondary" data-action="cancel-remove">${escapeHtml(labels.cancel || '')}</button>
      <button class="btn btn-danger" data-action="remove" data-id="${escapeHtml(account.id)}">${escapeHtml(labels.confirmDelete || '')}</button>
    </div>
  `
}

function accountHtml(account, state) {
  if (account.id === confirmingId) {
    return `
      <div class="account ${account.active ? 'active' : ''}">
        ${headHtml(account)}
        ${confirmHtml(account)}
      </div>
    `
  }
  return `
    <div class="account ${account.active ? 'active' : ''}">
      ${headHtml(account)}
      ${account.expanded ? gaugesHtml(account.gauges) + troubleHtml(account) : ''}
      ${deliveryHtml(account, state.endpoint)}
    </div>
  `
}

function render(state) {
  if (!state) return
  lastState = state
  labels = state.labels || {}

  // A block that went away (removed, or removed elsewhere) cannot stay pending.
  if (confirmingId && !(state.accounts || []).some(a => a.id === confirmingId)) {
    confirmingId = null
  }

  headline.textContent = state.headline || ''
  syncBtn.title = labels.sync || ''
  settingsBtn.title = labels.settings || ''
  minimizeBtn.title = labels.minimize || ''
  addAccountBtn.textContent = labels.addAccount || ''
  quitBtn.textContent = labels.quit || ''

  syncBtn.classList.toggle('spinning', state.status === 'syncing')

  const accounts = state.accounts || []
  // Both of these fill the panel with a single centred message, so they want
  // the footer pinned to the bottom and no duplicate add link above it.
  const centred = accounts.length === 0 || (accounts.length === 1 && accounts[0].pending)
  content.classList.toggle('empty', centred)
  addAccountBtn.hidden = centred
  accountList.innerHTML = accounts.length === 0
    ? emptyStateHtml()
    : accounts.map(a => (a.pending ? pendingHtml(a) : accountHtml(a, state))).join('')

  // The panel sizes itself to its content; main.js resizes the window in place.
  requestAnimationFrame(() => {
    window.agent.reportHeight(document.body.offsetHeight)
  })
}

// Delegated: the blocks are rebuilt on every state push, and the CSP forbids
// inline handlers anyway.
accountList.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  const id = target.dataset.id
  const action = target.dataset.action
  if (action === 'add') window.agent.addAccount()
  if (action === 'activate') window.agent.activate(id)
  if (action === 'relogin') window.agent.relogin(id)
  if (action === 'ask-remove') {
    confirmingId = id
    render(lastState)
  }
  if (action === 'cancel-remove') {
    confirmingId = null
    render(lastState)
  }
  if (action === 'remove') {
    confirmingId = null
    window.agent.removeAccount(id)
  }
})

syncBtn.addEventListener('click', () => window.agent.sync())
settingsBtn.addEventListener('click', () => window.agent.openSettings())
minimizeBtn.addEventListener('click', () => window.agent.hide())
addAccountBtn.addEventListener('click', () => window.agent.addAccount())
quitBtn.addEventListener('click', () => window.agent.quit())

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.agent.hide()
})

window.agent.onState(render)
window.agent.getState().then(render)
