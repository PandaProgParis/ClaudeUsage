// Tray panel renderer. Everything arrives already computed from main.js
// (lib.js owns that logic), so this file only paints and forwards clicks.

const headline = document.getElementById('headline')
const accountList = document.getElementById('account-list')
const syncBtn = document.getElementById('sync-btn')
const settingsBtn = document.getElementById('settings-btn')
const minimizeBtn = document.getElementById('minimize-btn')
const addAccountBtn = document.getElementById('add-account-btn')
const quitBtn = document.getElementById('quit-btn')

let labels = {}

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

/** The pill and the reconnect button only earn their place when the user is needed. */
function troubleHtml(account) {
  if (account.status !== 'error' && account.status !== 'login') return ''
  return `
    <div class="status-bar ${escapeHtml(account.status)}">
      <div class="status-dot"></div>
      <span class="status-text">${escapeHtml(account.message || '')}</span>
    </div>
    <button class="btn btn-secondary" data-action="relogin" data-id="${escapeHtml(account.id)}">
      <svg viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      <span>${escapeHtml(labels.relogin || '')}</span>
    </button>
  `
}

/** Shown only when there is something to switch between. */
function headHtml(account) {
  const hint = account.expanded ? labels.collapse : labels.expand
  const summary = account.expanded
    ? ''
    : `<span class="account-summary">${escapeHtml(account.summary || account.message || '')}</span>`
  return `
    <button class="account-head" data-action="activate" data-id="${escapeHtml(account.id)}"
            title="${escapeHtml(hint || '')}">
      <span class="account-dot"></span>
      <span class="account-name">${escapeHtml(account.name)}</span>
      ${summary}
    </button>
  `
}

function removeHtml(account, multi) {
  if (!multi || !account.expanded) return ''
  return `
    <div class="footer-links">
      <button class="link danger" data-action="remove" data-id="${escapeHtml(account.id)}">${escapeHtml(labels.removeAccount || '')}</button>
    </div>
  `
}

function accountHtml(account, state) {
  return `
    <div class="account ${account.active ? 'active' : ''}">
      ${state.multi ? headHtml(account) : ''}
      ${account.expanded ? gaugesHtml(account.gauges) + troubleHtml(account) : ''}
      ${deliveryHtml(account, state.endpoint)}
      ${removeHtml(account, state.multi)}
    </div>
  `
}

function render(state) {
  if (!state) return
  labels = state.labels || {}

  headline.textContent = state.headline || ''
  syncBtn.title = labels.sync || ''
  settingsBtn.title = labels.settings || ''
  minimizeBtn.title = labels.minimize || ''
  addAccountBtn.textContent = labels.addAccount || ''
  quitBtn.textContent = labels.quit || ''

  syncBtn.classList.toggle('spinning', state.status === 'syncing')

  accountList.innerHTML = (state.accounts || []).map(a => accountHtml(a, state)).join('')

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
  if (target.dataset.action === 'activate') window.agent.activate(id)
  if (target.dataset.action === 'relogin') window.agent.relogin(id)
  if (target.dataset.action === 'remove') window.agent.removeAccount(id)
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
