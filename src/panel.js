// Tray panel renderer. Gauges arrive already computed from main.js (lib.js
// owns that logic), so this file only paints and forwards clicks.

const headline = document.getElementById('headline')
const gaugeList = document.getElementById('gauge-list')
const statusBar = document.getElementById('status')
const statusText = document.getElementById('status-text')
const delivery = document.getElementById('delivery')
const deliveryText = document.getElementById('delivery-text')
const syncBtn = document.getElementById('sync-btn')
const settingsBtn = document.getElementById('settings-btn')
const minimizeBtn = document.getElementById('minimize-btn')
const loginBtn = document.getElementById('login-btn')
const loginLabel = document.getElementById('login-label')
const logoutBtn = document.getElementById('logout-btn')
const quitBtn = document.getElementById('quit-btn')

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )
}

function renderGauges(gauges, labels) {
  if (!gauges || gauges.length === 0) {
    gaugeList.innerHTML = '<div class="gauges-empty">' + escapeHtml(labels.empty || '') + '</div>'
    return
  }

  gaugeList.innerHTML = gauges.map(g => `
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

function renderDelivery(state) {
  if (!state.endpoint) {
    delivery.hidden = true
    return
  }
  delivery.hidden = false
  delivery.className = 'delivery ' + (state.delivery ? state.delivery.status : '')
  const outcome = state.delivery ? state.delivery.message : state.labels.pending
  deliveryText.textContent = '→ ' + hostOf(state.endpoint) + ' · ' + outcome
}

function render(state) {
  if (!state) return

  const labels = state.labels || {}

  headline.textContent = state.headline || ''
  syncBtn.title = labels.sync || ''
  settingsBtn.title = labels.settings || ''
  minimizeBtn.title = labels.minimize || ''
  loginLabel.textContent = labels.relogin || ''
  logoutBtn.textContent = labels.logout || ''
  quitBtn.textContent = labels.quit || ''

  syncBtn.classList.toggle('spinning', state.status === 'syncing')

  // The card's top line already says when the last reading was, and the spinner says
  // one is in progress; the pill and the reconnect button only earn their
  // place when something needs the user.
  const needsUser = state.status === 'error' || state.status === 'login'
  statusBar.hidden = !needsUser
  loginBtn.hidden = !needsUser
  statusBar.className = 'status-bar ' + state.status
  statusText.textContent = state.message

  renderGauges(state.gauges, labels)
  renderDelivery(state)

  // The panel sizes itself to its content; main.js resizes the window in place.
  requestAnimationFrame(() => {
    window.agent.reportHeight(document.body.offsetHeight)
  })
}

syncBtn.addEventListener('click', () => window.agent.sync())
settingsBtn.addEventListener('click', () => window.agent.openSettings())
minimizeBtn.addEventListener('click', () => window.agent.hide())
loginBtn.addEventListener('click', () => window.agent.relogin())
logoutBtn.addEventListener('click', () => window.agent.logout())
quitBtn.addEventListener('click', () => window.agent.quit())

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.agent.hide()
})

window.agent.onState(render)
window.agent.getState().then(render)
