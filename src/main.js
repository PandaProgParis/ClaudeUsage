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
  // Unpackaged, electron.exe must be handed the project root, where
  // package.json lives. Packaged, the app is the asar itself and any extra
  // argument is not an app path — handing it the asar path made it exit.
  const args = __dirname.includes('app.asar') ? [] : [path.resolve(__dirname, '..')]
  require('child_process')
    .spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' })
    .unref()
  process.exit(0)
}

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell, ipcMain } = electron

const {
  createTranslator,
  pickLanguage,
  resolveConfig,
  configProblems,
  pickOrganization,
  isAuthFailure,
  hasUsageShape,
  buildGauges,
} = require('./lib.js')

const CLAUDE_ORIGIN = 'https://claude.ai'
const SESSION_PARTITION = 'persist:claudeai'
const LOAD_TIMEOUT_MS = 30000
const FETCH_TIMEOUT_MS = 20000
const LOGIN_POLL_MS = 5000
const POST_TIMEOUT_MS = 10000
const MAX_LOG_BYTES = 1024 * 1024
const PANEL_WIDTH = 320
const PANEL_MARGIN = 8
const CONFIG_WIDTH = 400

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
let configWindow = null
let tray = null
let syncTimer = null
let loginTimer = null
let isQuitting = false
// Run id of the reading in flight, 0 when idle. startLogin and logout bump
// syncGeneration, which makes any reading still awaiting a response stale.
let syncing = 0
let syncGeneration = 0
// "Log out" clears the claude.ai session and leaves the site alone until the
// user asks to reconnect — the timer must not pop the login window on its own.
let loggedOut = false
// Once the user has dragged the panel somewhere, it stays there.
let panelMoved = false

const state = {
  status: 'idle', // idle | syncing | ok | error | login
  message: '', // detailed status; the panel shows it only on error / login
  headline: '', // "Read at 01:07" or "No reading yet" — the panel's title line
  lastSync: null,
  gauges: [],
  intervalMinutes: 5,
  autostart: false,
  endpoint: '',
  delivery: null, // { status: 'ok' | 'error', message } once an endpoint is set
  labels: {},
}

function panelLabels() {
  return {
    empty: t('panelEmpty'),
    sync: t('panelSync'),
    settings: t('panelSettings'),
    minimize: t('panelMinimize'),
    relogin: t('panelRelogin'),
    logout: t('panelLogout'),
    quit: t('panelQuit'),
    pending: t('panelPending'),
    reset: t('panelReset', { time: '{time}' }), // the panel fills {time} per gauge
  }
}

function configLabels() {
  return {
    endpoint: t('configEndpoint'),
    endpointHint: t('configEndpointHint'),
    interval: t('configInterval'),
    intervalHint: t('configIntervalHint'),
    outputPath: t('configOutputPath'),
    outputPathHint: t('configOutputPathHint'),
    save: t('configSave'),
    cancel: t('configCancel'),
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

function writeConfigFile(values) {
  fs.mkdirSync(path.dirname(configFilePath()), { recursive: true })
  fs.writeFileSync(
    configFilePath(),
    JSON.stringify(
      {
        outputPath: values.outputPath,
        intervalMinutes: values.intervalMinutes,
        endpoint: values.endpoint,
      },
      null,
      2
    ),
    'utf8'
  )
}

let isFirstRun = false

/** resolveConfig, plus a single separator style for logs and the panel. */
function resolveAndNormalize(raw) {
  const resolved = resolveConfig(raw, os.homedir())
  resolved.outputPath = path.normalize(resolved.outputPath)
  return resolved
}

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

  const resolved = resolveAndNormalize(read.ok ? read.raw : null)

  if (read.missing) {
    try {
      writeConfigFile(resolved) // materialise a file to edit
    } catch (err) {
      log('config write failed: ' + err.message)
    }
    isFirstRun = true
  }
  return resolved
}

/**
 * Switch to new settings: reschedule, refresh the panel, take a reading.
 * Shared by the file watcher and the settings window; a no-op when nothing
 * differs, which is how a save is not applied twice (the watcher sees it too).
 */
function applyConfig(next) {
  const previous = config
  config = next // always adopted: outputPathRaw may differ even when nothing effective does

  const unchanged = next.outputPath === previous.outputPath &&
    next.intervalMinutes === previous.intervalMinutes &&
    next.endpoint === previous.endpoint
  if (unchanged) return false

  const intervalChanged = next.intervalMinutes !== previous.intervalMinutes
  const endpointChanged = next.endpoint !== previous.endpoint
  log('config reloaded — output=' + config.outputPath + ' interval=' + config.intervalMinutes +
    'min endpoint=' + (config.endpoint || 'none'))

  if (intervalChanged) scheduleSync()
  setState({
    intervalMinutes: config.intervalMinutes,
    endpoint: config.endpoint,
    // A delivery verdict belongs to the endpoint it was sent to.
    delivery: config.endpoint && !endpointChanged ? state.delivery : null,
  })
  syncOnce()
  return true
}

/** Apply edits to config.json without restarting the agent. */
function watchConfig() {
  try {
    fs.watchFile(configFilePath(), { interval: 2000 }, () => applyConfig(loadConfig(config)))
  } catch (err) {
    log('config watch failed: ' + err.message)
  }
}

/** The settings window hands back what was typed: refuse, or persist and apply. */
function saveConfig(raw) {
  const problems = configProblems(raw)
  if (problems.length > 0) {
    const messages = {
      endpoint: t('configInvalidEndpoint'),
      intervalMinutes: t('configInvalidInterval'),
      outputPath: t('configInvalidPath'),
    }
    return { ok: false, problems: Object.fromEntries(problems.map(p => [p, messages[p]])) }
  }

  const next = resolveAndNormalize(raw)
  try {
    // Stored as typed: the form was pre-filled with outputPathRaw, so a `~`
    // the user wrote by hand survives a save that only touched another field.
    writeConfigFile({
      outputPath: next.outputPathRaw,
      intervalMinutes: next.intervalMinutes,
      endpoint: next.endpoint,
    })
  } catch (err) {
    log('config write failed: ' + err.message)
    return { ok: false, problems: { form: t('configWriteFailed', { error: err.message }) } }
  }

  log('config saved from the settings window')
  applyConfig(next)
  return { ok: true }
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

/**
 * Run a same-origin fetch inside the claude.ai page and bring back the JSON.
 * Bounded twice: the fetch itself aborts, and the executeJavaScript promise is
 * raced against a timer — a page that navigates away mid-call never resolves
 * it, and an unresolved call would leave `syncing` stuck forever.
 */
function pageFetch(pathname) {
  const script = [
    '(async () => {',
    '  try {',
    '    const r = await fetch(' + JSON.stringify(pathname) + ', {',
    '      headers: { accept: "application/json" },',
    '      credentials: "include",',
    '      signal: AbortSignal.timeout(' + FETCH_TIMEOUT_MS + '),',
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

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('fetchTimeout', { path: pathname }))), FETCH_TIMEOUT_MS + 5000)
    workerWindow.webContents.executeJavaScript(script, true).then(
      (result) => {
        clearTimeout(timer)
        // status 0 is the script's own catch: aborted, or never connected.
        // Surfacing its message beats reporting "answered 0" to the user.
        if (result && result.status === 0) {
          reject(new Error(t('fetchFailed', { path: pathname, error: result.error || 'no response' })))
        } else {
          resolve(result)
        }
      },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
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

/**
 * One reading. `manual` marks a click (panel or tray) as opposed to the timer:
 * a logged-out agent stays quiet on the timer, but a click means "get me back in".
 */
async function syncOnce({ manual = false } = {}) {
  if (syncing || isQuitting || loginTimer) return
  if (loggedOut) {
    if (manual) startLogin(t('loginRequired'))
    return
  }
  const run = ++syncGeneration
  syncing = run
  // The worker page is shared: a login or a logout navigates it from under
  // us, and the response we were waiting for (or the 401 the wipe causes)
  // then belongs to nobody. Checked after every await.
  const stale = () => run !== syncGeneration
  setState({ status: 'syncing', message: t('reading') })

  try {
    if (!(await ensureOnClaudeOrigin())) {
      throw new Error(t('unreachable'))
    }
    if (stale()) return

    const orgs = await pageFetch('/api/organizations')
    if (stale()) return
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
    if (stale()) return
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
    if (stale()) return

    const readAt = t('readAt', { time: shortTime(now) })
    setState({
      status: 'ok',
      message: readAt,
      headline: readAt,
      lastSync: now,
      gauges: buildGauges(usage.json, Date.now(), pickLanguage(appLocale)),
      delivery,
    })
  } catch (err) {
    if (stale()) return // an orphaned fetch timing out is not news
    log('sync failed: ' + err.message)
    setState({ status: 'error', message: t('failed', { error: err.message }) })
  } finally {
    if (syncing === run) syncing = 0
  }
}

/** Any reading in flight is now meaningless; let the next one start at once. */
function abandonReading() {
  syncGeneration++
  syncing = 0
}

function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = setInterval(() => syncOnce(), config.intervalMinutes * 60 * 1000)
}

// --- Login flow ---

function startLogin(reason) {
  if (loginTimer) {
    // Already waiting on the login window: just bring it back to the front.
    workerWindow.show()
    workerWindow.focus()
    return
  }
  loggedOut = false
  abandonReading()
  log('login required: ' + reason)
  setState({ status: 'login', message: t('loginPrompt', { reason }) })

  loadPage(LOGIN_PAGE).then(() => {
    if (isQuitting || !loginTimer) return
    workerWindow.show()
    workerWindow.focus()
  })

  // One probe at a time, and a probe only counts for the poll that sent it:
  // a logout (or quit) while it was out must not be undone by its answer.
  let probing = false
  const timer = setInterval(async () => {
    if (isQuitting || probing) return
    probing = true
    try {
      const probe = await pageFetch('/api/organizations')
      if (loginTimer === timer && Array.isArray(probe.json)) finishLogin()
    } catch {
    } finally {
      probing = false
    }
  }, LOGIN_POLL_MS)
  loginTimer = timer
}

function finishLogin() {
  if (!loginTimer) return
  clearInterval(loginTimer)
  loginTimer = null
  workerWindow.hide()
  log('login ok')
  setState({ status: 'idle', message: t('loggedIn') })
  loadPage(IDLE_PAGE).then(() => syncOnce())
}

/**
 * Forget the claude.ai account: wipe the partition (cookies and all) and stop
 * reading until the user reconnects. The JSON already on disk is left alone.
 */
async function logout() {
  loggedOut = true
  abandonReading()
  if (loginTimer) {
    clearInterval(loginTimer)
    loginTimer = null
  }
  workerWindow.hide()
  try {
    await workerWindow.webContents.session.clearStorageData()
    log('logged out — claude.ai session cleared')
  } catch (err) {
    log('logout failed: ' + err.message)
  }
  setState({
    status: 'login',
    message: t('loggedOut'),
    headline: t('noReading'),
    lastSync: null,
    gauges: [],
    delivery: null,
  })
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
    { label: t('traySync'), click: () => syncOnce({ manual: true }) },
    { label: t('traySettings'), click: () => openConfigWindow() },
    { type: 'separator' },
    { label: t('trayRelogin'), click: () => startLogin(t('reconnectRequested')) },
    { label: t('trayLogout'), click: () => logout() },
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
    width: PANEL_WIDTH,
    height: 300,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium pauses requestAnimationFrame in a hidden window; the panel
      // reports its height from one, and it must arrive before the first show.
      backgroundThrottling: false,
    },
  })

  panelWindow.loadFile(path.join(__dirname, 'panel.html'))

  // A floating widget: it stays open when focus goes elsewhere and closes only
  // from its × button, Escape, or another click on the tray icon. Dragging it
  // (panel.html marks the body as a drag region) pins it where it was dropped;
  // will-move is only raised for user-initiated moves, never for setBounds.
  panelWindow.on('will-move', () => { panelMoved = true })
  // Windows pops the system menu (Move / Size / Close) on a right-click in a
  // drag region — meaningless on a frameless panel.
  panelWindow.on('system-context-menu', (event) => event.preventDefault())
  panelWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    panelWindow.hide()
  })
}

/** Park the panel against the tray icon, inside that screen's work area. */
function positionPanel() {
  if (!tray || !panelWindow || panelWindow.isDestroyed()) return
  const trayBounds = tray.getBounds()
  const area = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea
  const height = panelWindow.getBounds().height

  const centered = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_WIDTH / 2)
  const x = Math.min(Math.max(centered, area.x + PANEL_MARGIN), area.x + area.width - PANEL_WIDTH - PANEL_MARGIN)
  const nearBottom = trayBounds.y > area.y + area.height / 2
  const y = nearBottom ? area.y + area.height - height - PANEL_MARGIN : area.y + PANEL_MARGIN

  panelWindow.setBounds({ x, y, width: PANEL_WIDTH, height }, false)
}

/**
 * Follow the content height without moving the panel: the bottom edge stays
 * put when the panel sits on the bottom of the work area (parked over a
 * taskbar, it must grow upwards), the top edge otherwise. Never off-screen.
 */
function resizePanel(height) {
  const bounds = panelWindow.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const clamped = Math.min(Math.max(Math.round(height), 140), Math.min(700, area.height))

  const bottomGap = area.y + area.height - (bounds.y + bounds.height)
  const pinBottom = Math.abs(bottomGap - PANEL_MARGIN) <= 2
  let y = pinBottom ? bounds.y + bounds.height - clamped : bounds.y
  y = Math.min(Math.max(y, area.y), area.y + area.height - clamped)

  panelWindow.setBounds({ x: bounds.x, y, width: PANEL_WIDTH, height: clamped }, false)
}

/** A panel dragged onto a display that has since gone must not be lost. */
function keepPanelOnScreen() {
  const bounds = panelWindow.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height)
  if (x !== bounds.x || y !== bounds.y) panelWindow.setPosition(x, y, false)
}

function showPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) createPanel()
  panelWindow.webContents.send('usage:state', state)
  if (panelMoved) keepPanelOnScreen()
  else positionPanel()
  panelWindow.show()
  panelWindow.focus()
}

function togglePanel() {
  if (panelWindow && panelWindow.isVisible()) panelWindow.hide()
  else showPanel()
}

// --- Settings window ---

function createConfigWindow() {
  configWindow = new BrowserWindow({
    width: CONFIG_WIDTH,
    height: 360,
    useContentSize: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true, // the panel is always on top; the form must not open behind it
    autoHideMenuBar: true,
    title: t('configWindowTitle'),
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'config-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // same reason as the panel: sized before it is shown
    },
  })

  configWindow.loadFile(path.join(__dirname, 'config.html'))
  // The form reports its height once the labels are in and the window is
  // revealed then, at its final size; the timer is only a safety net.
  configWindow.once('ready-to-show', () => setTimeout(revealConfigWindow, 500))
  configWindow.on('closed', () => { configWindow = null })
}

function revealConfigWindow() {
  if (!configWindow || configWindow.isDestroyed() || configWindow.isVisible()) return
  configWindow.show()
  configWindow.focus()
}

function openConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.show()
    configWindow.focus()
    return
  }
  createConfigWindow()
}

function closeConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) configWindow.close()
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
  ipcMain.on('usage:sync', () => syncOnce({ manual: true }))
  ipcMain.on('usage:relogin', () => startLogin(t('reconnectRequested')))
  ipcMain.on('usage:logout', () => logout())
  ipcMain.on('usage:open-settings', () => openConfigWindow())
  ipcMain.on('usage:quit', quit)
  ipcMain.on('usage:hide', () => panelWindow && panelWindow.hide())
  ipcMain.on('usage:height', (_event, height) => {
    if (!panelWindow || panelWindow.isDestroyed()) return
    resizePanel(height)
  })

  ipcMain.handle('config:get', () => ({
    config: {
      endpoint: config.endpoint,
      intervalMinutes: config.intervalMinutes,
      outputPath: config.outputPathRaw, // as written in the file, `~` included
    },
    labels: configLabels(),
  }))
  ipcMain.handle('config:save', (_event, raw) => saveConfig(raw))
  ipcMain.on('config:close', () => closeConfigWindow())
  ipcMain.on('config:height', (_event, height) => {
    if (!configWindow || configWindow.isDestroyed()) return
    configWindow.setContentSize(CONFIG_WIDTH, Math.min(Math.max(Math.round(height), 200), 800))
    revealConfigWindow()
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
    config = loadConfig(resolveAndNormalize(null))
    log('starting — output=' + config.outputPath + ' interval=' + config.intervalMinutes +
      'min endpoint=' + (config.endpoint || 'none') + ' autostart=' + isAutostartEnabled())

    Object.assign(state, {
      intervalMinutes: config.intervalMinutes,
      endpoint: config.endpoint,
      autostart: isAutostartEnabled(),
      message: t('noReading'),
      headline: t('noReading'),
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
