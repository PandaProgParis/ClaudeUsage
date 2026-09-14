// Tray panel renderer. Gauges arrive already computed from main.js (lib.js
// owns that logic), so this file only paints and forwards clicks.

const subtitle = document.getElementById('subtitle')
const gaugeList = document.getElementById('gauge-list')
const statusBar = document.getElementById('status')
const statusText = document.getElementById('status-text')
const outputPath = document.getElementById('output-path')
const delivery = document.getElementById('delivery')
const deliveryText = document.getElementById('delivery-text')
const gaugesTitle = document.getElementById('gauges-title')
const syncLabel = document.getElementById('sync-label')
const loginLabel = document.getElementById('login-label')
const configBtn = document.getElementById('config-btn')
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

  subtitle.textContent = labels.subtitle || ''
  gaugesTitle.textContent = labels.usage || ''
  syncLabel.textContent = labels.sync || ''
  loginLabel.textContent = labels.relogin || ''
  configBtn.textContent = labels.config || ''
  quitBtn.textContent = labels.quit || ''
  outputPath.title = labels.openFolder || ''

  statusBar.className = 'status-bar ' + state.status
  statusText.textContent = state.message
  outputPath.textContent = state.outputPath
  renderGauges(state.gauges, labels)
  renderDelivery(state)

  // The panel sizes itself to its content; main.js repositions it afterwards.
  requestAnimationFrame(() => {
    window.agent.reportHeight(document.body.scrollHeight)
  })
}

document.getElementById('sync-btn').addEventListener('click', () => window.agent.sync())
document.getElementById('login-btn').addEventListener('click', () => window.agent.relogin())
document.getElementById('config-btn').addEventListener('click', () => window.agent.openConfig())
document.getElementById('quit-btn').addEventListener('click', () => window.agent.quit())
outputPath.addEventListener('click', () => window.agent.openJson())

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.agent.hide()
})

window.agent.onState(render)
window.agent.getState().then(render)
