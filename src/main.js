// claude-usage — background agent that keeps a claude.ai usage snapshot on disk.
//
// Same trick as the Chrome extension: the request is issued from a real page on
// the claude.ai origin, with the real cookies and a real Chrome user agent, so
// it looks exactly like the web app talking to its own API. The window that
// does it stays hidden; it only shows up when you need to log in again.

const electron = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Some terminals (VS Code, Claude Code) export ELECTRON_RUN_AS_NODE=1, which
// turns electron.exe into plain Node — `require('electron')` is then just a
// path string and there is no GUI. Relaunch ourselves without that variable.
if (typeof electron === 'string') {
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  require('child_process')
    // Electron is handed the project root, where package.json lives.
    .spawn(process.execPath, [path.resolve(__dirname, '..')], { env, detached: true, stdio: 'ignore' })
    .unref()
  process.exit(0)
}

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell, ipcMain } = electron

const {
  createTranslator,
  resolveConfig,
  pickOrganization,
  isAuthFailure,
  hasUsageShape,
  buildGauges,
} = require('./lib.js')

const CLAUDE_ORIGIN = 'https://claude.ai'
const SESSION_PARTITION = 'persist:claudeai'
const LOAD_TIMEOUT_MS = 30000
const LOGIN_POLL_MS = 5000
const POST_TIMEOUT_MS = 10000
const MAX_LOG_BYTES = 1024 * 1024

// A page on the claude.ai origin that is cheap to load — we only need the
// origin and its cookies, not the whole SPA running in the background.
const IDLE_PAGE = CLAUDE_ORIGIN + '/robots.txt'
const LOGIN_PAGE = CLAUDE_ORIGIN + '/login'

// Replaced on ready: app.getLocale() is only meaningful from then on.
let t = createTranslator('en')
let appLocale = 'en'
let config = { outputPath: '', intervalMinutes: 5, endpoint: '' }
let workerWindow = null
let panelWindow = null
let tray = null
let syncTimer = null
let loginTimer = null
let isQuitting = false
let syncing = false

const state = {
  status: 'idle', // idle | syncing | ok | error | login
  message: '',
  lastSync: null,
  gauges: [],
  outputPath: '',
  intervalMinutes: 5,
  autostart: false,
  endpoint: '',
  delivery: null, // { status: 'ok' | 'error', message } once an endpoint is set
  labels: {},
}

function panelLabels() {
  return {
    usage: t('panelUsage'),
    empty: t('panelEmpty'),
    sync: t('panelSync'),
    relogin: t('panelRelogin'),
    config: t('panelConfig'),
    quit: t('panelQuit'),
    openFolder: t('panelOpenFolder'),
    pending: t('panelPending'),
    subtitle: t('panelSubtitle', { minutes: config.intervalMinutes }),
    reset: t('panelReset', { time: '{time}' }), // the panel fills {time} per gauge
  }
}

// --- Logging ---

function logFilePath() {
  return path.join(app.getPath('userData'), 'claude-usage.log')
}

function log(message) {
  try {
    const file = logFilePath()
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.rmSync(file)
    } catch {}
    fs.appendFileSync(file, '[' + new Date().toISOString() + '] ' + message + '\n')
  } catch {}
}

// --- Config ---

function configFilePath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function readConfigFile() {
  try {
    return { ok: true, raw: JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) }
  } catch (err) {
    return { ok: false, missing: err.code === 'ENOENT', error: err }
  }
}

function writeDefaultConfig(resolved) {
  try {
    fs.mkdirSync(path.dirname(configFilePath()), { recursive: true })
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify(
        {
          outputPath: resolved.outputPath,
          intervalMinutes: resolved.intervalMinutes,
          endpoint: resolved.endpoint,
        },
        null,
        2
      ),
      'utf8'
    )
  } catch (err) {
    log('config write failed: ' + err.message)
  }
}

let isFirstRun = false

/**
 * Read config.json, falling back to `current` if it is there but unreadable —
 * a half-saved file must never silently reset the user's settings.
 */
function loadConfig(current) {
  const read = readConfigFile()
  if (!read.ok && !read.missing) {
    log('config unreadable (' + read.error.message + ') — keeping current settings')
    return current
  }

  const resolved = resolveConfig(read.ok ? read.raw : null, os.homedir())
  // Keep a single separator style in logs and in the panel.
  resolved.outputPath = path.normalize(resolved.outputPath)

  if (read.missing) {
    writeDefaultConfig(resolved) // materialise a file to edit
    isFirstRun = true
  }
  return resolved
}

/** Apply edits to config.json without restarting the agent. */
function watchConfig() {
  try {
    fs.watchFile(configFilePath(), { interval: 2000 }, () => {
      const next = loadConfig(config)
      const unchanged = next.outputPath === config.outputPath &&
        next.intervalMinutes === config.intervalMinutes &&
        next.endpoint === config.endpoint
      if (unchanged) return

      const intervalChanged = next.intervalMinutes !== config.intervalMinutes
      config = next
      log('config reloaded — output=' + config.outputPath + ' interval=' + config.intervalMinutes +
        'min endpoint=' + (config.endpoint || 'none'))

      if (intervalChanged) scheduleSync()
      setState({
        outputPath: config.outputPath,
        intervalMinutes: config.intervalMinutes,
        endpoint: config.endpoint,
        delivery: config.endpoint ? state.delivery : null,
        labels: panelLabels(),
      })
      syncOnce()
    })
  } catch (err) {
    log('config watch failed: ' + err.message)
  }
}

// --- State broadcasting ---

function setState(patch) {
  Object.assign(state, patch)
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('usage:state', state)
  }
  updateTray()
}

function updateTray() {
  if (!tray) return
  const lines = ['claude-usage', state.message]
  if (state.gauges.length > 0) {
    lines.push(state.gauges.map(g => g.label.replace('Weekly — ', '') + ' ' + g.percent + '%').join(' · '))
  }
  tray.setToolTip(lines.join('\n'))
}

// --- Worker window (hidden) ---

function createWorkerWindow() {
  workerWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: t('loginWindowTitle'),
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      partition: SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Closing the login window just hides it — the agent keeps running.
  workerWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    workerWindow.hide()
  })
}

function loadPage(url) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      workerWindow.webContents.removeListener('did-finish-load', onLoad)
      workerWindow.webContents.removeListener('did-fail-load', onFail)
      resolve(ok)
    }
    const onLoad = () => finish(true)
    // -3 is ERR_ABORTED, which fires on ordinary redirects — not a failure.
    const onFail = (_event, code) => { if (code !== -3) finish(false) }
    const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS)

    workerWindow.webContents.on('did-finish-load', onLoad)
    workerWindow.webContents.on('did-fail-load', onFail)
    workerWindow.loadURL(url).catch(() => finish(false))
  })
}

/** Run a same-origin fetch inside the claude.ai page and bring back the JSON. */
function pageFetch(pathname) {
  const script = [
    '(async () => {',
    '  try {',
    '    const r = await fetch(' + JSON.stringify(pathname) + ', {',
    '      headers: { accept: "application/json" },',
    '      credentials: "include",',
    '    })',
    '    const text = await r.text()',
    '    let json = null',
    '    try { json = JSON.parse(text) } catch (e) {}',
    '    return { status: r.status, json: json }',
    '  } catch (e) {',
    '    return { status: 0, json: null, error: String((e && e.message) || e) }',
    '  }',
    '})()',
  ].join('\n')

  return workerWindow.webContents.executeJavaScript(script, true)
}

async function ensureOnClaudeOrigin() {
  if (workerWindow.webContents.getURL().startsWith(CLAUDE_ORIGIN)) return true
  if (await loadPage(IDLE_PAGE)) return true
  return loadPage(CLAUDE_ORIGIN + '/')
}

async function readCookie(name) {
  try {
    const cookies = await workerWindow.webContents.session.cookies.get({ url: CLAUDE_ORIGIN, name })
    return cookies.length > 0 ? cookies[0].value : null
  } catch {
    return null
  }
}

/** Never logged in vs. logged in once and dropped — the wording differs. */
async function authFailureReason() {
  return (await readCookie('sessionKey')) ? t('sessionExpired') : t('loginRequired')
}

// --- Output ---

function writeOutput(payload) {
  const target = config.outputPath
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  fs.renameSync(tmp, target) // atomic: a reader never sees a half-written file
}

/**
 * Optional relay to a server, same contract as the Chrome extension's endpoint.
 * The file on disk is the deliverable; a failed POST is reported, not fatal.
 */
async function postUsage(payload) {
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    log('posted -> ' + config.endpoint)
    return { status: 'ok', message: t('sent') }
  } catch (err) {
    log('post failed (' + config.endpoint + '): ' + err.message)
    return { status: 'error', message: t('sendFailed', { error: err.message }) }
  }
}

// --- Sync cycle ---

function shortTime(date) {
  return new Date(date).toLocaleTimeString(appLocale, { hour: '2-digit', minute: '2-digit' })
}

async function syncOnce() {
  if (syncing || isQuitting || loginTimer) return
  syncing = true
  setState({ status: 'syncing', message: t('reading') })

  try {
    if (!(await ensureOnClaudeOrigin())) {
      throw new Error(t('unreachable'))
    }

    const orgs = await pageFetch('/api/organizations')
    if (isAuthFailure(orgs.status)) {
      startLogin(await authFailureReason())
      return
    }
    if (!Array.isArray(orgs.json)) {
      throw new Error(t('orgsResponded', { status: orgs.status }))
    }

    const orgId = pickOrganization(orgs.json, await readCookie('lastActiveOrg'))
    if (!orgId) throw new Error(t('noOrg'))

    const usage = await pageFetch('/api/organizations/' + orgId + '/usage')
    if (isAuthFailure(usage.status)) {
      startLogin(await authFailureReason())
      return
    }
    if (!hasUsageShape(usage.json)) {
      throw new Error(t('usageResponded', { status: usage.status }))
    }

    writeOutput(usage.json)
    const now = new Date().toISOString()
    log('sync ok -> ' + config.outputPath)

    const delivery = config.endpoint ? await postUsage(usage.json) : null

    setState({
      status: 'ok',
      message: t('readAt', { time: shortTime(now) }),
      lastSync: now,
      gauges: buildGauges(usage.json),
      delivery,
    })
  } catch (err) {
    log('sync failed: ' + err.message)
    setState({ status: 'error', message: t('failed', { error: err.message }) })
  } finally {
    syncing = false
  }
}

function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = setInterval(syncOnce, config.intervalMinutes * 60 * 1000)
}

// --- Login flow ---

function startLogin(reason) {
  if (loginTimer) return
  log('login required: ' + reason)
  setState({ status: 'login', message: t('loginPrompt', { reason }) })

  loadPage(LOGIN_PAGE).then(() => {
    if (isQuitting) return
    workerWindow.show()
    workerWindow.focus()
  })

  loginTimer = setInterval(async () => {
    if (isQuitting) return
    try {
      const probe = await pageFetch('/api/organizations')
      if (Array.isArray(probe.json)) finishLogin()
    } catch {}
  }, LOGIN_POLL_MS)
}

function finishLogin() {
  clearInterval(loginTimer)
  loginTimer = null
  workerWindow.hide()
  log('login ok')
  setState({ status: 'idle', message: t('loggedIn') })
  loadPage(IDLE_PAGE).then(syncOnce)
}

// --- Autostart ---

const APP_ID = 'com.pandaprog.claude-usage'

/**
 * electron-builder's portable target unpacks into a throwaway temp folder, so
 * process.execPath there points at a path that will not exist at next boot.
 * PORTABLE_EXECUTABLE_FILE names the .exe the user actually launched.
 */
function executablePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
}

function loginItemOptions() {
  // `name` is the registry value under HKCU ... CurrentVersion\Run. Without it
  // Electron falls back to the generic AppUserModelId, which every unpackaged
  // Electron app shares — they would overwrite each other's entry.
  // Unpackaged, Windows must also be told to relaunch electron.exe *with this folder*.
  return app.isPackaged
    ? { name: 'claude-usage', path: executablePath(), args: [] }
    : { name: 'claude-usage', path: executablePath(), args: [path.resolve(__dirname, '..')] }
}

function isAutostartEnabled() {
  try {
    const settings = app.getLoginItemSettings(loginItemOptions())
    // Unpackaged on Windows we launch electron.exe with a folder argument;
    // openAtLogin compares those arguments strictly and answers false even
    // with a live Run entry. executableWillLaunchAtLogin ignores the args and
    // answers the question the checkbox actually asks.
    return Boolean(settings.openAtLogin || settings.executableWillLaunchAtLogin)
  } catch {
    return false
  }
}

function setAutostart(enabled) {
  try {
    app.setLoginItemSettings(Object.assign({ openAtLogin: enabled, openAsHidden: true }, loginItemOptions()))
  } catch (err) {
    log('autostart toggle failed: ' + err.message)
  }
  setState({ autostart: isAutostartEnabled() })
  buildTrayMenu()
}

// --- Tray + panel ---

function iconPath() {
  return path.join(__dirname, 'icon.png')
}

function buildTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('trayGauges'), click: showPanel },
    { type: 'separator' },
    { label: t('traySync'), click: () => syncOnce() },
    { label: t('trayRelogin'), click: () => startLogin(t('reconnectRequested')) },
    { type: 'separator' },
    { label: t('trayOpenJson'), click: () => shell.showItemInFolder(config.outputPath) },
    { label: t('trayOpenConfig'), click: () => shell.openPath(configFilePath()) },
    { label: t('trayOpenLog'), click: () => shell.openPath(logFilePath()) },
    { type: 'separator' },
    {
      label: t('trayAutostart'),
      type: 'checkbox',
      checked: state.autostart,
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: t('trayQuit'), click: quit },
  ]))
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath())
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  buildTrayMenu()
  updateTray()
  tray.on('click', togglePanel)
}

function createPanel() {
  panelWindow = new BrowserWindow({
    width: 320,
    height: 300,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  panelWindow.loadFile(path.join(__dirname, 'panel.html'))
  panelWindow.on('blur', () => {
    if (!panelWindow.webContents.isDevToolsOpened()) panelWindow.hide()
  })
  panelWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    panelWindow.hide()
  })
}

/** Park the panel against the tray icon, inside the current screen's work area. */
function positionPanel() {
  if (!tray || !panelWindow || panelWindow.isDestroyed()) return
  const trayBounds = tray.getBounds()
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
  const area = display.workArea
  const bounds = panelWindow.getBounds()

  const centered = Math.round(trayBounds.x + trayBounds.width / 2 - bounds.width / 2)
  const x = Math.min(Math.max(centered, area.x + 8), area.x + area.width - bounds.width - 8)
  const nearBottom = trayBounds.y > area.y + area.height / 2
  const y = nearBottom ? area.y + area.height - bounds.height - 8 : area.y + 8

  panelWindow.setPosition(x, y, false)
}

function showPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) createPanel()
  panelWindow.webContents.send('usage:state', state)
  positionPanel()
  panelWindow.show()
  panelWindow.focus()
}

function togglePanel() {
  if (panelWindow && panelWindow.isVisible()) panelWindow.hide()
  else showPanel()
}

function quit() {
  isQuitting = true
  if (syncTimer) clearInterval(syncTimer)
  if (loginTimer) clearInterval(loginTimer)
  fs.unwatchFile(configFilePath())
  app.quit()
}

// --- IPC ---

function registerIpc() {
  ipcMain.handle('usage:get-state', () => state)
  ipcMain.on('usage:sync', () => syncOnce())
  ipcMain.on('usage:relogin', () => startLogin(t('reconnectRequested')))
  ipcMain.on('usage:open-json', () => shell.showItemInFolder(config.outputPath))
  ipcMain.on('usage:open-config', () => shell.openPath(configFilePath()))
  ipcMain.on('usage:quit', quit)
  ipcMain.on('usage:hide', () => panelWindow && panelWindow.hide())
  ipcMain.on('usage:height', (_event, height) => {
    if (!panelWindow || panelWindow.isDestroyed()) return
    const clamped = Math.min(Math.max(Math.round(height), 140), 700)
    panelWindow.setBounds(Object.assign(panelWindow.getBounds(), { height: clamped }))
    positionPanel()
  })
}

// --- Boot ---

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showPanel)
  // Hidden windows must not be mistaken for "nothing left to do".
  app.on('window-all-closed', () => {})

  // claude.ai should see a plain Chrome, not an Electron shell.
  app.userAgentFallback = app.userAgentFallback
    .replace(/ claude-usage\/[^ ]+/, '')
    .replace(/ Electron\/[^ ]+/, '')

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID) // distinct taskbar / notification identity on Windows
    if (process.platform === 'darwin' && app.dock) app.dock.hide() // tray-only agent

    appLocale = app.getLocale()
    t = createTranslator(appLocale)
    config = loadConfig(resolveConfig(null, os.homedir()))
    log('starting — output=' + config.outputPath + ' interval=' + config.intervalMinutes +
      'min endpoint=' + (config.endpoint || 'none') + ' autostart=' + isAutostartEnabled())

    Object.assign(state, {
      outputPath: config.outputPath,
      intervalMinutes: config.intervalMinutes,
      endpoint: config.endpoint,
      autostart: isAutostartEnabled(),
      message: t('noReading'),
      labels: panelLabels(),
    })

    registerIpc()
    createWorkerWindow()
    createPanel()
    createTray()

    // A fresh install starts with Windows, as asked; the tray menu can undo it.
    if (isFirstRun) setAutostart(true)

    syncOnce()
    scheduleSync()
    watchConfig()
  })
}
