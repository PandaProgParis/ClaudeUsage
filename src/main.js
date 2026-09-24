// Claude Usage - background agent that keeps a claude.ai usage snapshot on disk.
//
// Same trick as the Chrome extension: the request is issued from a real page on
// the claude.ai origin, with the real cookies and a real Chrome user agent, so
// it looks exactly like the web app talking to its own API. The window that
// does it stays hidden; it only shows up when you need to log in again.

const electron = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

// Some terminals (VS Code, Claude Code) export ELECTRON_RUN_AS_NODE=1, which
// turns electron.exe into plain Node - `require('electron')` is then just a
// path string and there is no GUI. Relaunch ourselves without that variable.
if (typeof electron === 'string') {
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  // Unpackaged, electron.exe must be handed the project root, where
  // package.json lives. Packaged, the app is the asar itself and any extra
  // argument is not an app path - handing it the asar path made it exit.
  const args = __dirname.includes('app.asar') ? [] : [path.resolve(__dirname, '..')]
  require('child_process')
    .spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' })
    .unref()
  process.exit(0)
}

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, screen, shell, ipcMain, session } = electron

const {
  USER_DATA_FOLDER,
  MIGRATED_ACCOUNT_ID,
  createTranslator,
  pickLanguage,
  resolveConfig,
  configProblems,
  pickOrganization,
  isAuthFailure,
  hasUsageShape,
  buildGauges,
  diffGaugeAlerts,
  buildSummary,
  partitionFor,
  orphanPartitionDirs,
  resolveAccounts,
  accountsFileTrusted,
  aggregateStatus,
  organizationName,
  buildTooltip,
} = require('./lib.js')

// Electron names userData after productName, which is "Claude Usage" since
// 1.0.4; every earlier install keeps its claude.ai sessions in the lowercase
// folder. Pinned before anything reads the path - the single-instance lock and
// every session partition live under it - and measured to leave no empty
// "Claude Usage" folder behind.
app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_FOLDER))

// Chromium opens three GPU shader caches per session (GPUCache,
// DawnWebGPUCache, DawnGraphiteCache), ~550 KB preallocated each, woken on a
// timer and rewritten every few minutes - for shaders this app never compiles.
// Measured: none of them is created with this switch. Must stay before ready.
// Hardware acceleration itself stays on: without it WebGL falls back to
// SwiftShader, a renderer string the claude.ai login's bot check can flag.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

const CLAUDE_ORIGIN = 'https://claude.ai'
const LOAD_TIMEOUT_MS = 30000
const FETCH_TIMEOUT_MS = 20000
const LOGIN_POLL_MS = 5000
const POST_TIMEOUT_MS = 10000
const MAX_LOG_BYTES = 1024 * 1024
const PANEL_WIDTH = 320
const PANEL_MARGIN = 8
const CONFIG_WIDTH = 400

// A page on the claude.ai origin that is cheap to load - we only need the
// origin and its cookies, not the whole SPA running in the background.
const IDLE_PAGE = CLAUDE_ORIGIN + '/robots.txt'
const LOGIN_PAGE = CLAUDE_ORIGIN + '/login'

// Replaced on ready: app.getLocale() is only meaningful from then on.
let t = createTranslator('en')
let appLocale = 'en'
let config = { outputPath: '', intervalMinutes: 5, endpoint: '', expandAll: false, notify: true, notifySound: true }
let panelWindow = null
let configWindow = null
let tray = null
let syncTimer = null
let isQuitting = false
// Once the user has dragged the panel somewhere, it stays there.
let panelMoved = false

// One entry per claude.ai account, in panel order. Each carries its own hidden
// window, its own reading state and its own hardening counters: a login on one
// account must not make another's in-flight reading stale.
let accounts = []
let activeId = null
// Only one login window at a time - two visible login pages and the user no
// longer knows which account they are signing into.
let loginOwner = null

// Everything here is global to the agent; anything per-account lives on the
// account itself and is recomposed by panelState() on every push.
const state = {
  intervalMinutes: 5,
  autostart: false,
  endpoint: '',
  labels: {},
}

function panelLabels() {
  return {
    empty: t('panelEmpty'),
    sync: t('panelSync'),
    settings: t('panelSettings'),
    minimize: t('panelMinimize'),
    addAccount: t('panelAddAccount'),
    removeAccount: t('panelRemoveAccount'),
    confirmDelete: t('panelConfirmDelete'),
    cancel: t('panelCancel'),
    activate: t('panelActivate'),
    noAccount: t('noAccount'),
    quit: t('panelQuit'),
    pending: t('panelPending'),
    reset: t('panelReset', { time: '{time}' }), // the panel fills {time} per gauge
    countdown: t('panelCountdown', { time: '{time}' }), // same, for the collapsed summary
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
    expandAll: t('configExpandAll'),
    expandAllHint: t('configExpandAllHint'),
    notify: t('configNotify'),
    notifyHint: t('configNotifyHint'),
    notifySound: t('configNotifySound'),
    notifySoundHint: t('configNotifySoundHint'),
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

// --- Accounts ---

function accountsFilePath() {
  return path.join(app.getPath('userData'), 'accounts.json')
}

// accounts.json as last read or written. Claude Agents takes an accounts.json
// newer than the usage file for a switch still awaiting its reading and hides
// the account name meanwhile, so rewriting identical content is not free.
let accountsFileText = null

/**
 * What accounts.json held, and how the read went. `raw` is null both for "no
 * file yet" (an upgrade from a single-account version) and "unreadable file" -
 * resolveAccounts turns either into the historical account, the only outcome
 * that preserves a live claude.ai session. `state` tells them apart, which is
 * what collectPartitions needs before it deletes anything.
 */
function readAccountsFile() {
  let text
  for (let attempt = 1; text === undefined; attempt++) {
    try {
      text = fs.readFileSync(accountsFilePath(), 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return { state: 'missing', raw: null }
      // A scanner or a backup holding the file at logon is gone within a
      // moment; a fallback now would set the real list aside for nothing.
      if (attempt < 3) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
        continue
      }
      log('accounts.json unreadable (' + err.message + ') - falling back to the historical session')
      return { state: 'unreadable', raw: null }
    }
  }
  try {
    const raw = JSON.parse(text)
    accountsFileText = text
    return { state: 'ok', raw }
  } catch (err) {
    log('accounts.json unreadable (' + err.message + ') - falling back to the historical session')
    return { state: 'unreadable', raw: null }
  }
}

function writeAccountsFile() {
  const text = JSON.stringify(
    { activeId, accounts: accounts.map(a => ({ id: a.id, label: a.label, orgId: a.orgId })) },
    null,
    2
  )
  if (text === accountsFileText) return
  const target = accountsFilePath()
  if (accountsFileText === null && isEmptyFile(damagedAccountsPath()) && fs.existsSync(target)) {
    // Locked at boot, so quarantineAccountsFile could only leave an empty
    // marker: this file holds the list that marker stands for. Copy it in
    // before replacing it, or keep off it while the lock holds.
    try {
      fs.copyFileSync(target, damagedAccountsPath())
      log('accounts.json copied into accounts.json.damaged before being replaced')
    } catch (err) {
      log('accounts.json still unreadable (' + err.message + ') - not overwriting it')
      return
    }
  }
  const tmp = target + '.tmp'
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // The old file or the new one, never a torn one: the fallback would turn a
    // torn accounts.json into the default account, and collectPartitions acts
    // on the account list. Flushed to disk, since this file is rare and
    // precious; usage.json is rewritten at every reading and needs none of it.
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, text, null, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.renameSync(tmp, target)
    } catch (err) {
      // A scanner holding accounts.json open refuses the replace on Windows.
      // Losing the write would be worse: the next launch would sweep the
      // session of an account the file never learnt about.
      log('accounts rename failed (' + err.message + ') - writing in place')
      fs.writeFileSync(target, text, 'utf8')
      fs.rmSync(tmp, { force: true })
    }
    accountsFileText = text // only once the new content is really in place
  } catch (err) {
    log('accounts write failed: ' + err.message)
  }
}

function createAccountState(record) {
  return {
    id: record.id,
    label: record.label,
    orgId: record.orgId,
    window: null, // created lazily: an account is only ever read or logged into
    status: 'idle',
    message: t('noReading'),
    headline: t('noReading'),
    gauges: [],
    lastSync: null,
    delivery: null,
    // The 1.0.1 hardening, now owned by the account instead of the module.
    syncing: 0,
    syncGeneration: 0,
    loginTimer: null,
  }
}

/** Returns the read itself: collectPartitions judges the file as it was found. */
function loadAccounts() {
  const read = readAccountsFile()
  const resolved = resolveAccounts(read.raw)
  accounts = resolved.accounts.map(createAccountState)
  activeId = resolved.activeId
  log('accounts loaded - ' + accounts.length + ', active=' + (activeId || 'none'))
  return read
}

function findAccount(id) {
  return accounts.find(a => a.id === id)
}

function activeAccount() {
  return findAccount(activeId)
}

function accountName(account) {
  return account.label || t('accountUnnamed')
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
        expandAll: values.expandAll,
        notify: values.notify,
        notifySound: values.notifySound,
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
 * Read config.json, falling back to `current` if it is there but unreadable -
 * a half-saved file must never silently reset the user's settings.
 */
function loadConfig(current) {
  const read = readConfigFile()
  if (!read.ok && !read.missing) {
    log('config unreadable (' + read.error.message + ') - keeping current settings')
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

  const readingChanged = next.outputPath !== previous.outputPath ||
    next.intervalMinutes !== previous.intervalMinutes ||
    next.endpoint !== previous.endpoint
  const displayChanged = next.expandAll !== previous.expandAll ||
    next.notify !== previous.notify || next.notifySound !== previous.notifySound
  if (!readingChanged && !displayChanged) return false

  log('config reloaded - output=' + config.outputPath + ' interval=' + config.intervalMinutes +
    'min endpoint=' + (config.endpoint || 'none') + ' expandAll=' + config.expandAll +
    ' notify=' + config.notify + ' sound=' + config.notifySound)

  // Folding blocks open or shut, or muting the notifications, changes nothing
  // on claude.ai's side: repaint, do not spend a reading on it.
  if (!readingChanged) {
    broadcast()
    return true
  }

  if (next.intervalMinutes !== previous.intervalMinutes) scheduleSync()
  // A delivery verdict belongs to the endpoint it was sent to.
  if (next.endpoint !== previous.endpoint) {
    for (const account of accounts) account.delivery = null
  }
  setState({ intervalMinutes: config.intervalMinutes, endpoint: config.endpoint })
  syncAll()
  return true
}

let configWatcher = null
let configReloadTimer = null

function reloadConfigSoon() {
  // A save arrives as several events, the first one on a half-written file.
  clearTimeout(configReloadTimer)
  configReloadTimer = setTimeout(() => {
    // Only the boot materialises a missing file. Here it is an editor or a sync
    // tool between a delete and a write: writing defaults over it, and a
    // reading to the default path, would undo the settings it is about to put back.
    if (fs.existsSync(configFilePath())) applyConfig(loadConfig(config))
  }, 300)
}

// Up to 1.0.3 this polled; kept only for a folder that cannot be watched, so live reload
// is never worse than it was.
function pollConfig(err) {
  log('config watch failed (' + err.message + ') - polling every 2 s instead')
  configWatcher = null
  fs.unwatchFile(configFilePath())
  fs.watchFile(configFilePath(), { interval: 2000 }, reloadConfigSoon)
}

/**
 * Apply edits to config.json without restarting the agent. An event, not a
 * poll: fs.watchFile stat'ed the file every 2 s, 43,200 times a day, for an
 * edit that happens a few times a year. The folder is watched rather than the
 * file because editors that save through a temp file and a rename replace it,
 * and a watch held on the file itself (kqueue on macOS) stays on the old one.
 */
function watchConfig() {
  const name = path.basename(configFilePath()).toLowerCase()
  try {
    const watcher = fs.watch(path.dirname(configFilePath()), (_event, filename) => {
      // Windows reports the watched folder's own deletion as an endless run of
      // events carrying its absolute path, never as an 'error'.
      if (filename && path.isAbsolute(filename)) {
        if (configWatcher !== watcher) return // an event queued before the switch
        watcher.close()
        return pollConfig(new Error('watched folder removed'))
      }
      // The folder also holds the log and Chromium's own files. Windows and
      // macOS compare names without case, and a tool that recreates the file
      // as Config.json keeps that case. Windows may report no name at all; one
      // extra read of a small file is harmless.
      if (filename && filename.toLowerCase() !== name) return
      reloadConfigSoon()
    })
    configWatcher = watcher
    watcher.on('error', pollConfig) // Node has already closed the handle
  } catch (err) {
    pollConfig(err)
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
      expandAll: next.expandAll,
      notify: next.notify,
      notifySound: next.notifySound,
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

/**
 * Everything the panel renders, composed on demand. Recomposing rather than
 * keeping a second copy means the account list can never drift from `accounts`,
 * and the panel can ask for the current state before the first reading.
 */
function panelState() {
  const active = activeAccount()
  return {
    status: aggregateStatus(accounts, activeId),
    // No account: the empty state in the middle of the panel speaks for itself,
    // so the top line stays out of the way.
    headline: active ? active.headline : '',
    accounts: accounts.map(account => ({
      id: account.id,
      name: accountName(account),
      active: account.id === activeId,
      expanded: config.expandAll || account.id === activeId,
      status: account.status,
      message: account.message,
      // Never connected and waiting on its login window: there is no name and
      // no reading to show, so the block is replaced by a centred invitation.
      pending: !account.label && account.status === 'login',
      // One place decides the wording: a named account has been connected before.
      loginLabel: account.label ? t('panelRelogin') : t('panelLogin'),
      gauges: account.gauges,
      summary: buildSummary(account.gauges),
      // The POST only ever concerns the account whose payload was written.
      delivery: account.id === activeId ? account.delivery : null,
    })),
    intervalMinutes: state.intervalMinutes,
    endpoint: state.endpoint,
    autostart: state.autostart,
    labels: state.labels,
  }
}

function broadcast() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('usage:state', panelState())
  }
  if (tray) tray.setToolTip(buildTooltip(accounts))
}

function setState(patch) {
  Object.assign(state, patch)
  broadcast()
}

function setAccountState(account, patch) {
  Object.assign(account, patch)
  broadcast()
}

// --- Worker windows (hidden, one per account) ---

/**
 * The account's claude.ai session, without an HTTP disk cache: a reading never
 * reuses anything from it, and all it ever held was the login page's assets,
 * 13 to 22 MB per account. The cookies, the only thing that matters, are not
 * cached data and stay. fromPartition hands back the session already created
 * for this partition, so every caller must go through here to get the option.
 */
function accountSession(id) {
  return session.fromPartition(partitionFor(id), { cache: false })
}

/**
 * A window's session is fixed at creation, so every account needs its own
 * window. Created for a reading or a login and released once it is over (see
 * releaseWindow); within one login the same window is shown, then released,
 * never recreated midway.
 */
function accountWindow(account) {
  // syncAll walks the list it started with, and a reading may still be queued
  // behind a removal: neither may rebuild a window on a wiped partition.
  if (account.removed) throw new Error('account removed')
  if (account.window && !account.window.isDestroyed()) return account.window

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: t('loginWindowTitle') + ' - ' + accountName(account),
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      session: accountSession(account.id),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Closing the login window just hides it - the agent keeps running.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
    onLoginWindowClosed(account)
  })
  win.on('closed', () => {
    if (account.window === win) account.window = null
  })

  account.window = win
  return win
}

/**
 * An account needs no page between readings: its cookies live in the session,
 * not in the window, and each idle page held a renderer of ~25 MB private.
 * Skipped while a reading or a login owns the page; the next reading builds a
 * fresh hidden window on robots.txt.
 */
function releaseWindow(account) {
  if (account.syncing || account.loginTimer || loginOwner === account.id) return
  const win = account.window
  account.window = null
  if (win && !win.isDestroyed()) win.destroy() // no 'close' event, so no onLoginWindowClosed
}

function loadPage(account, url) {
  const win = accountWindow(account)
  // Held once: every getter on a destroyed BrowserWindow throws, and loadURL
  // rejects as soon as its WebContents is destroyed (a removal mid-load), so
  // finish() must not go back through `win`.
  const contents = win.webContents
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      contents.removeListener('did-finish-load', onLoad)
      contents.removeListener('did-fail-load', onFail)
      resolve(ok)
    }
    const onLoad = () => finish(true)
    // -3 is ERR_ABORTED, which fires on ordinary redirects - not a failure. A
    // subframe failing (the login page's captcha or analytics) is not one either.
    const onFail = (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) finish(false)
    }
    const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS)

    contents.on('did-finish-load', onLoad)
    contents.on('did-fail-load', onFail)
    win.loadURL(url).catch(() => finish(false))
  })
}

/**
 * Run a same-origin fetch inside the claude.ai page and bring back the JSON.
 * Bounded twice: the fetch itself aborts, and the executeJavaScript promise is
 * raced against a timer - a page that navigates away mid-call never resolves
 * it, and an unresolved call would leave `syncing` stuck forever.
 */
function pageFetch(account, pathname) {
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
    // First, before the timer: if this throws (a removed account), the promise
    // rejects at once instead of leaving a 25 s timer behind.
    const contents = accountWindow(account).webContents
    const timer = setTimeout(() => reject(new Error(t('fetchTimeout', { path: pathname }))), FETCH_TIMEOUT_MS + 5000)
    contents.executeJavaScript(script, true).then(
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

/**
 * The worker belongs on robots.txt and nowhere else. getURL() is the last
 * committed URL, which lies three ways: a login window closed by hand leaves
 * the /login or /new app resident, a failed load commits an error page that
 * keeps the failed claude.ai URL under an opaque origin (every relative fetch
 * then fails), and a crashed renderer keeps its URL.
 */
function onIdlePage(contents) {
  if (contents.isCrashed() || contents.getURL() !== IDLE_PAGE) return false
  try {
    return contents.mainFrame.origin === CLAUDE_ORIGIN
  } catch {
    return false // render frame disposed: navigating is the cure anyway
  }
}

async function ensureOnClaudeOrigin(account) {
  if (onIdlePage(accountWindow(account).webContents)) return true
  if (await loadPage(account, IDLE_PAGE)) return true
  // A login started meanwhile owns this page: never drag it off /login.
  if (account.loginTimer) return false
  return loadPage(account, CLAUDE_ORIGIN + '/')
}

async function readCookie(account, name) {
  try {
    const cookies = await accountSession(account.id).cookies.get({ url: CLAUDE_ORIGIN, name })
    return cookies.length > 0 ? cookies[0].value : null
  } catch {
    return null
  }
}

/** Never logged in vs. logged in once and dropped - the wording differs. */
async function authFailureReason(account) {
  return (await readCookie(account, 'sessionKey')) ? t('sessionExpired') : t('loginRequired')
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
  // The OS locale, not Chromium's: getLocale() only returns a language whose
  // locale pack ships (electronLanguages) and falls back to en-US otherwise.
  // It is not always a BCP 47 tag, though: macOS keeps ICU keywords
  // (en-GB@rg=frzzzz, en-US@hours=h23), Windows appends '@variant'
  // (ca-ES@valencia), and Intl throws on both. A clock label must never fail
  // a reading, so the keywords go, bar a forced 12/24-hour clock, and
  // appLocale, always valid, backs it up.
  const options = { hour: '2-digit', minute: '2-digit' }
  const [system, keywords = ''] = String(app.getSystemLocale() || '').split('@')
  const hours = /(?:^|;)hours=(h11|h12|h23|h24)(?:;|$)/.exec(keywords)
  if (hours) options.hourCycle = hours[1]
  try {
    return new Date(date).toLocaleTimeString(system || appLocale, options)
  } catch {
    return new Date(date).toLocaleTimeString(appLocale, options)
  }
}

/**
 * One reading, for one account. It never opens a login window by itself - that
 * call belongs to syncAll, which can see whether any account is still working.
 */
async function syncAccount(account) {
  if (!account || account.removed || account.syncing || isQuitting || account.loginTimer) return

  const run = ++account.syncGeneration
  account.syncing = run
  // This account's page is shared with its own login flow: a login or a removal
  // navigates or wipes it from under us, and the response we were waiting for
  // (or the 401 the wipe causes) then belongs to nobody. Checked after every
  // await, and scoped to this account so another account's login is harmless.
  const stale = () => run !== account.syncGeneration
  setAccountState(account, { status: 'syncing', message: t('reading') })

  try {
    if (!(await ensureOnClaudeOrigin(account))) {
      throw new Error(t('unreachable'))
    }
    if (stale()) return

    const orgs = await pageFetch(account, '/api/organizations')
    if (stale()) return
    if (isAuthFailure(orgs.status)) {
      // No login window from here: with two accounts, an expired pro session
      // would pop a login page in the user's face every interval while the
      // perso one works. syncAll decides whether a blackout justifies it.
      const reason = await authFailureReason(account)
      if (stale()) return // a login started meanwhile owns the message now
      setAccountState(account, { status: 'login', message: reason })
      return
    }
    if (!Array.isArray(orgs.json)) {
      throw new Error(t('orgsResponded', { status: orgs.status }))
    }

    const orgId = pickOrganization(orgs.json, await readCookie(account, 'lastActiveOrg'))
    // Before accounts.json is touched: an orphaned run must not write it.
    if (stale()) return
    if (!orgId) throw new Error(t('noOrg'))

    // The payload carries no account identity, so a block's name comes from the
    // organizations listing - refreshed on every reading, it costs nothing.
    const name = organizationName(orgs.json, orgId)
    const changed = (name && name !== account.label) || orgId !== account.orgId
    if (name) account.label = name
    account.orgId = orgId
    if (changed) writeAccountsFile() // after both fields, or the file lags behind

    const usage = await pageFetch(account, '/api/organizations/' + orgId + '/usage')
    if (stale()) return
    if (isAuthFailure(usage.status)) {
      const reason = await authFailureReason(account)
      if (stale()) return
      setAccountState(account, { status: 'login', message: reason })
      return
    }
    if (!hasUsageShape(usage.json)) {
      throw new Error(t('usageResponded', { status: usage.status }))
    }

    // The file on disk is the active account's, by contract with Claude Agents.
    const isActive = account.id === activeId
    if (isActive) {
      writeOutput(usage.json)
      log('sync ok (' + account.id + ') -> ' + config.outputPath)
    } else {
      log('sync ok (' + account.id + ') - gauges only')
    }
    const now = new Date().toISOString()

    const delivery = isActive && config.endpoint ? await postUsage(usage.json) : null
    if (stale()) return

    const readAt = t('readAt', { time: shortTime(now) })
    const gauges = buildGauges(usage.json, Date.now(), pickLanguage(appLocale))
    // Diffed against this account's *previous* gauges, before they are replaced.
    const alerts = diffGaugeAlerts(account.gauges, gauges)
    setAccountState(account, {
      status: 'ok',
      message: readAt,
      headline: readAt,
      lastSync: now,
      gauges,
      delivery,
    })
    notifyAlerts(account, alerts)
  } catch (err) {
    if (stale()) return // an orphaned fetch timing out is not news
    log('sync failed (' + account.id + '): ' + err.message)
    setAccountState(account, { status: 'error', message: t('failed', { error: err.message }) })
  } finally {
    // A stale run, taken over by a login or a removal, never touches the window.
    if (account.syncing === run) {
      account.syncing = 0
      releaseWindow(account)
    }
  }
}

/**
 * Desktop notifications, native on all three platforms: the OS already owns the
 * placement, the stacking and the sound, and a hand-rolled toast window would
 * only have reimplemented them worse.
 */
// Electron does not pin a shown Notification: once V8 collects the wrapper,
// its delegate goes and a toast clicked later from the Action Center or the
// Notification Center does nothing. Not released on 'close': Windows emits it
// when the toast merely times out into the Action Center. Alerts only fire on
// a gauge crossing 100%, so a few are plenty.
const liveNotifications = []
const MAX_LIVE_NOTIFICATIONS = 8
// icon.png is 512 px: decoded per toast, and held by each one kept above.
let notificationIcon = null

function showNotification(title, body) {
  if (!Notification.isSupported()) return // no notification daemon on this Linux
  try {
    if (!notificationIcon) notificationIcon = nativeImage.createFromPath(iconPath()).resize({ width: 128, height: 128 })
    const notification = new Notification({
      title,
      body,
      icon: notificationIcon,
      silent: !config.notifySound,
    })
    const release = () => {
      const index = liveNotifications.indexOf(notification)
      if (index !== -1) liveNotifications.splice(index, 1)
    }
    notification.on('click', () => { release(); showPanel() })
    notification.on('failed', release)
    liveNotifications.push(notification)
    if (liveNotifications.length > MAX_LIVE_NOTIFICATIONS) liveNotifications.shift()
    notification.show()
    log('notified - ' + title + ' · ' + body)
  } catch (err) {
    // A notification is never worth failing a reading over.
    log('notification failed: ' + err.message)
  }
}

function notifyAlerts(account, alerts) {
  if (!config.notify) return
  const name = accountName(account)

  for (const gauge of alerts.exhausted) {
    // formatResetTime answers 'now' for a reset already past - useless in a
    // sentence that promises a return, so it falls back to the short wording.
    const eta = gauge.reset && gauge.reset !== 'now' ? gauge.reset : ''
    showNotification(
      t('notifyExhaustedTitle', { account: name }),
      eta
        ? t('notifyExhaustedBody', { gauge: gauge.label, time: eta })
        : t('notifyExhaustedBodyUnknown', { gauge: gauge.label })
    )
  }

  for (const gauge of alerts.restored) {
    showNotification(
      t('notifyRestoredTitle', { account: name }),
      t('notifyRestoredBody', { gauge: gauge.label, percent: gauge.percent })
    )
  }
}

/**
 * One pass over every account, strictly sequential: two logins hitting
 * claude.ai at once buys nothing and doubles the live renderers. The others in
 * panel order, the active one last: its reading rewrites usage.json, a rename
 * found on another account rewrites accounts.json, and Claude Agents hides the
 * name while accounts.json is the newer of the two.
 * A failing account does not interrupt the pass - each block carries its own
 * status, which is what lets a healthy perso account survive an expired pro one.
 */
async function syncAll() {
  if (isQuitting || accounts.length === 0) return

  const order = accounts.filter(a => a.id !== activeId).concat(accounts.filter(a => a.id === activeId))
  for (const account of order) {
    await syncAccount(account)
    if (isQuitting) return
  }

  // A single-account agent that is logged out is useless, so it still opens the
  // login window by itself - exactly the 1.0.1 behaviour. With several accounts,
  // only a total blackout justifies stealing the user's focus.
  if (!loginOwner && accounts.every(a => a.status === 'login')) {
    startLogin(activeAccount() || accounts[0], t('loginRequired'))
  }
}

/** Any reading in flight on this account is meaningless; let the next one start. */
function abandonReading(account) {
  account.syncGeneration++
  account.syncing = 0
}

function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = setInterval(() => syncAll(), config.intervalMinutes * 60 * 1000)
}

// --- Login flow ---

function startLogin(account, reason) {
  if (!account) return
  if (account.loginTimer) {
    // Already waiting on this account: just bring its window back to the front.
    const open = accountWindow(account)
    open.show()
    open.focus()
    return
  }
  if (loginOwner && loginOwner !== account.id) {
    // Refused rather than queued: two visible login pages and the user no longer
    // knows which account they are signing into.
    setAccountState(account, { status: 'login', message: t('loginBusy') })
    return
  }

  loginOwner = account.id
  abandonReading(account)
  log('login required (' + account.id + '): ' + reason)
  // A never-connected account shows the reason alone, centred above its own
  // login button: telling it to use the window would just repeat the button.
  setAccountState(account, {
    status: 'login',
    message: account.label ? t('loginPrompt', { reason }) : reason,
  })

  const win = accountWindow(account)
  loadPage(account, LOGIN_PAGE).then(() => {
    if (isQuitting || !account.loginTimer) return
    win.show()
    win.focus()
  })

  // One probe at a time, and a probe only counts for the poll that sent it:
  // a removal (or quit) while it was out must not be undone by its answer.
  let probing = false
  const timer = setInterval(async () => {
    if (isQuitting || probing) return
    probing = true
    try {
      const probe = await pageFetch(account, '/api/organizations')
      if (account.loginTimer === timer && Array.isArray(probe.json)) finishLogin(account)
    } catch {
    } finally {
      probing = false
    }
  }, LOGIN_POLL_MS)
  account.loginTimer = timer
}

function cancelLogin(account) {
  if (account.loginTimer) {
    clearInterval(account.loginTimer)
    account.loginTimer = null
  }
  if (loginOwner === account.id) loginOwner = null
}

function finishLogin(account) {
  if (!account.loginTimer) return
  cancelLogin(account)
  // A removal weeks from now falls back to the first account, as any other.
  account.previousActiveId = null
  // The logged-in claude.ai app is heavy and nothing needs it any more: the
  // next reading opens a fresh hidden page on robots.txt.
  releaseWindow(account)
  log('login ok (' + account.id + ')')
  setAccountState(account, { status: 'idle', message: t('loggedIn') })
  // This account first, so the panel reacts at once, then catch up the others.
  syncAccount(account).then(() => syncAll())
}

/**
 * A login window closed by hand. An added account that never got a name means
 * the user abandoned an "add an account" attempt: keeping it would leave an
 * empty block behind on every try. Never the migrated `default` account, which
 * has no name either until its first reading: it holds the 1.0.0/1.0.1
 * session, and dropping it would wipe cookies that may well be valid (a first
 * launch offline, or a 403 at the first reading, opens this window).
 */
function onLoginWindowClosed(account) {
  const abandoned = Boolean(account.loginTimer) && !account.label && account.id !== MIGRATED_ACCOUNT_ID
  cancelLogin(account)
  if (abandoned) {
    log('add-account abandoned - dropping ' + account.id)
    // Out of the close handler before destroying the window it fired on.
    setImmediate(() => removeAccount(account.id))
    return
  }
  // The login or chat app would otherwise stay resident behind the hidden
  // window until the next reading. Out of the close handler, as above.
  setImmediate(() => releaseWindow(account))
  broadcast()
}

// --- Adding, switching and removing accounts ---

/** 8 hex characters: this names a Chromium partition, so it stays filesystem-safe. */
function newAccountId() {
  return crypto.randomBytes(4).toString('hex')
}

function addAccount() {
  if (loginOwner) {
    // One login at a time: bring the open one back rather than start a second.
    const owner = findAccount(loginOwner)
    if (owner) startLogin(owner, t('loginRequired'))
    return
  }
  const account = createAccountState({ id: newAccountId(), label: null, orgId: null })
  accounts.push(account)
  // Where an abandoned attempt goes back to; forgotten once the login succeeds.
  account.previousActiveId = activeId
  activeId = account.id // a fresh account is the one the user is looking at
  writeAccountsFile()
  log('adding account ' + account.id)
  startLogin(account, t('loginRequired'))
}

function activateAccount(id) {
  const account = findAccount(id)
  if (!account || account.id === activeId) return
  activeId = id
  writeAccountsFile()
  log('active account -> ' + id)
  broadcast()
  // The output file belongs to the active account, so the switch must rewrite it.
  syncAccount(account)
}

/**
 * Forget an account: wipe its partition, drop its window, remove its block. This
 * replaces 1.0.x's "log out" - reconnecting is one click on "add an account", so
 * a second, nearly identical gesture was not worth its code.
 *
 * Nothing is asked here: the panel asks in place of the gauges, and an abandoned
 * add-account attempt needs no question at all. That is also why the tray has no
 * removal entry - a menu click cannot be confirmed inside the block.
 */
async function removeAccount(id) {
  const account = findAccount(id)
  if (!account) return

  // Before anything awaits: syncAll walks the list it started with, and a
  // reading queued after a login may still come, and both would otherwise
  // rebuild a window on the partition about to be wiped.
  account.removed = true
  cancelLogin(account)
  abandonReading(account)
  accounts = accounts.filter(a => a.id !== id)
  if (activeId === id) {
    // An abandoned add-account goes back to the account the user was on, not
    // to whichever one is listed first: usage.json follows the active account.
    const previous = account.previousActiveId ? findAccount(account.previousActiveId) : null
    activeId = previous ? previous.id : accounts.length > 0 ? accounts[0].id : null
  }
  writeAccountsFile()

  // Before the wipe, not after: the session comes from accountSession(), so the
  // window has nothing left to do, and a wipe that fails must not leave it alive.
  const win = account.window
  account.window = null
  if (win && !win.isDestroyed()) win.destroy()
  try {
    // Through the session whether or not a window ever opened it this run: the
    // cookies are on disk either way. The folder itself cannot go while the
    // session is open; collectPartitions() takes it at the next launch.
    await accountSession(id).clearStorageData()
    log('account removed - ' + id)
  } catch (err) {
    log('account removal failed (' + id + '): ' + err.message)
  }

  broadcast()
  if (activeId) syncAccount(activeAccount())
}

// --- Disk housekeeping ---

// Chromium's GPU shader caches, one set per session. Never recreated once
// disable-gpu-shader-disk-cache is set at the top of this file.
const GPU_CACHE_DIRS = ['GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']

function damagedAccountsPath() {
  return accountsFilePath() + '.damaged'
}

function isEmptyFile(file) {
  try {
    return fs.statSync(file).size === 0
  } catch {
    return false
  }
}

/**
 * The fallback account list is about to disown session folders that may be
 * real. Keep the file that named them aside (the first damaged copy wins), or
 * an empty marker when there is none: while that file exists, the orphan
 * cleanup stays off. Without it, the next launch would trust the healed
 * accounts.json and delete every session the damaged one listed.
 */
function quarantineAccountsFile(read) {
  const damaged = damagedAccountsPath()
  if (fs.existsSync(damaged)) return
  if (read.state !== 'missing') {
    try {
      fs.renameSync(accountsFilePath(), damaged)
      log('accounts.json not trusted (' + read.state + ') - kept as accounts.json.damaged')
      return
    } catch {
      // held open by a scanner: an empty marker still protects the sessions,
      // and writeAccountsFile copies the list into it before replacing it
    }
  }
  try {
    fs.writeFileSync(damaged, '')
    log('accounts.json not trusted (' + read.state + ') - accounts.json.damaged marker written')
  } catch (err) {
    log('accounts.json.damaged marker failed: ' + err.message)
  }
}

/**
 * At launch, before any account session is open and before accounts.json is
 * healed: delete the session folders no account owns - removed accounts,
 * abandoned add-account attempts, ~100 MB on a machine that had added and
 * removed a few - plus the HTTP and GPU caches that sessions filled before
 * both were switched off. In the background: nothing waits on it, and nothing
 * uses these folders.
 *
 * Orphans go only on the word of an accounts.json read whole, and never while
 * accounts.json.damaged exists: that file marks a list that once fell back to
 * the default account, and stays until someone deletes it by hand.
 */
function collectPartitions(read) {
  const base = app.getPath('userData')
  const root = path.join(base, 'Partitions')
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    // no account session was ever opened
  }

  let orphans = orphanPartitionDirs(names, accounts.map(a => a.id))
  if (orphans.length > 0) {
    const trusted = read.state === 'ok' && accountsFileTrusted(read.raw)
    if (!trusted) quarantineAccountsFile(read)
    if (!trusted || fs.existsSync(damagedAccountsPath())) {
      log('orphan session cleanup suspended - accounts.json.damaged holds the previous account list; ' +
        'delete it once the accounts are restored')
      orphans = []
    }
  }
  if (orphans.length > 0) log('removing orphan sessions - ' + orphans.join(', '))

  const live = accounts.map(a => path.join(root, partitionFor(a.id).slice('persist:'.length)))
  const targets = orphans.map(name => path.join(root, name))
    // Safe only because accountSession() passes cache:false: nothing opens Cache/.
    .concat(live.map(dir => path.join(dir, 'Cache')))
    .concat([base].concat(live).flatMap(dir => GPU_CACHE_DIRS.map(name => path.join(dir, name))))
  for (const target of targets) {
    // One retry: they compound per folder level, and the next launch is the
    // real retry for a folder something still holds.
    fs.promises.rm(target, { recursive: true, force: true, maxRetries: 1 })
      .catch(err => log('cleanup failed (' + target + '): ' + err.message))
  }
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
  // Electron app shares - they would overwrite each other's entry. It stays
  // lowercase across the rename: it is the entry every earlier install created.
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
    { label: t('traySync'), click: () => syncAll() },
    { label: t('traySettings'), click: () => openConfigWindow() },
    { type: 'separator' },
    { label: t('trayRelogin'), click: () => startLogin(activeAccount(), t('reconnectRequested')) },
    { label: t('trayAddAccount'), click: () => addAccount() },
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
  tray.setToolTip(buildTooltip(accounts))
  tray.on('click', togglePanel)
}

// The panel exists only while it is used: created on the first click, freed
// once hidden this long (its renderer held ~25 MB private for a view nobody
// looks at most of the day). Rebuilding it costs ~200 ms, measured.
const PANEL_IDLE_MS = 5 * 60 * 1000
let panelIdleTimer = null
// Between a rebuild and the new page's first height report: shown only then,
// like the settings window, so it never appears at the wrong size.
let panelRevealPending = false
let panelRevealTimer = null
// Where a dragged panel was when it was freed; it comes back there.
let panelBounds = null

function createPanel() {
  const win = new BrowserWindow({
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
      // backgroundThrottling stays on: switched off, a panel shown once then
      // hidden kept compositing its CSS animations, measured at ~25% of a core
      // around the clock. The panel reports its height synchronously instead
      // of from a requestAnimationFrame, which a hidden window never runs.
    },
  })
  panelWindow = win
  if (panelMoved && panelBounds) win.setBounds(panelBounds, false)

  win.loadFile(path.join(__dirname, 'panel.html'))

  // A floating widget: it stays open when focus goes elsewhere and closes only
  // from its × button, Escape, or another click on the tray icon. Dragging it
  // (panel.html marks the body as a drag region) pins it where it was dropped;
  // will-move is only raised for user-initiated moves, never for setBounds.
  win.on('will-move', () => { panelMoved = true })
  // Windows pops the system menu (Move / Size / Close) on a right-click in a
  // drag region - meaningless on a frameless panel.
  win.on('system-context-menu', (event) => event.preventDefault())
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('hide', () => {
    clearTimeout(panelIdleTimer)
    if (!isQuitting) panelIdleTimer = setTimeout(destroyPanel, PANEL_IDLE_MS)
  })
  win.on('show', () => clearTimeout(panelIdleTimer))
  win.on('closed', () => {
    if (panelWindow !== win) return
    panelWindow = null
    panelRevealPending = false
  })
  // A crashed panel is rebuilt on the next click instead of staying blank.
  win.webContents.on('render-process-gone', () => setImmediate(() => destroyPanel(true)))
}

/** Free the panel's renderer; the next showPanel() rebuilds it. */
function destroyPanel(force) {
  clearTimeout(panelIdleTimer)
  const win = panelWindow
  if (!win || win.isDestroyed()) {
    panelWindow = null
    return
  }
  if (!force && (win.isVisible() || panelRevealPending)) return
  panelBounds = win.getBounds()
  clearTimeout(panelRevealTimer)
  panelRevealPending = false
  panelWindow = null
  win.destroy() // skips the hide-only close handler
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
  clearTimeout(panelIdleTimer)
  if (panelRevealPending) return // its first height report is on the way
  if (!panelWindow || panelWindow.isDestroyed()) {
    // The page asks for its state itself once loaded (getState), so no push is
    // lost; revealPanel() shows it on the height that state gives it.
    createPanel()
    panelRevealPending = true
    panelRevealTimer = setTimeout(revealPanel, 1500) // a safety net only
    return
  }
  // Through broadcast, never a hand-rolled send: `state` alone no longer holds
  // the account list, and pushing it raw left the panel with no blocks at all
  // until the next reading.
  broadcast()
  placeAndShowPanel()
}

function revealPanel() {
  clearTimeout(panelRevealTimer)
  if (isQuitting || !panelRevealPending || !panelWindow || panelWindow.isDestroyed()) return
  panelRevealPending = false
  placeAndShowPanel()
}

function placeAndShowPanel() {
  if (panelMoved) keepPanelOnScreen()
  else positionPanel()
  panelWindow.show()
  panelWindow.focus()
}

function togglePanel() {
  if (panelRevealPending) return
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) panelWindow.hide()
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
  for (const account of accounts) cancelLogin(account)
  clearTimeout(panelIdleTimer)
  clearTimeout(panelRevealTimer)
  clearTimeout(configReloadTimer)
  if (configWatcher) configWatcher.close()
  fs.unwatchFile(configFilePath()) // a no-op unless the watch fell back to polling
  app.quit()
}

// --- IPC ---

function registerIpc() {
  ipcMain.handle('usage:get-state', () => panelState())
  ipcMain.on('usage:sync', () => syncAll())
  ipcMain.on('usage:relogin', (_event, id) => {
    startLogin(id ? findAccount(id) : activeAccount(), t('reconnectRequested'))
  })
  ipcMain.on('usage:activate', (_event, id) => activateAccount(id))
  ipcMain.on('usage:add-account', () => addAccount())
  ipcMain.on('usage:remove-account', (_event, id) => removeAccount(id))
  ipcMain.on('usage:open-settings', () => openConfigWindow())
  ipcMain.on('usage:quit', quit)
  ipcMain.on('usage:hide', () => {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide()
  })
  ipcMain.on('usage:height', (event, height) => {
    // A report from a panel freed meanwhile must not size its successor.
    if (!panelWindow || panelWindow.isDestroyed() || event.sender !== panelWindow.webContents) return
    resizePanel(height)
    revealPanel()
  })

  ipcMain.handle('config:get', () => ({
    config: {
      endpoint: config.endpoint,
      intervalMinutes: config.intervalMinutes,
      outputPath: config.outputPathRaw, // as written in the file, `~` included
      expandAll: config.expandAll,
      notify: config.notify,
      notifySound: config.notifySound,
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

  // claude.ai should see a plain Chrome, not an Electron shell. Electron writes
  // the app's token as its name with the spaces removed ("ClaudeUsage/1.0.4").
  app.userAgentFallback = app.userAgentFallback
    .replace(new RegExp(' ' + app.getName().replace(/\s/g, '') + '/[^ ]+'), '')
    .replace(/ Electron\/[^ ]+/, '')

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID) // distinct taskbar / notification identity on Windows
    if (process.platform === 'darwin' && app.dock) app.dock.hide() // tray-only agent

    appLocale = app.getLocale()
    t = createTranslator(appLocale)
    config = loadConfig(resolveAndNormalize(null))
    log('starting - output=' + config.outputPath + ' interval=' + config.intervalMinutes +
      'min endpoint=' + (config.endpoint || 'none') + ' autostart=' + isAutostartEnabled())

    // Before createAccountState: its labels come from the translator.
    const read = loadAccounts()
    // Before the file is healed and before any session opens: the cleanup
    // judges accounts.json as it was found, and moves a damaged one aside.
    collectPartitions(read)
    writeAccountsFile() // a first run or a fallback; identical content is skipped

    Object.assign(state, {
      intervalMinutes: config.intervalMinutes,
      endpoint: config.endpoint,
      autostart: isAutostartEnabled(),
      labels: panelLabels(),
    })

    registerIpc()
    // No window at boot: the panel is built on the first click, a worker window
    // for each reading.
    createTray()

    // A fresh install starts with Windows, as asked; the tray menu can undo it.
    if (isFirstRun) setAutostart(true)

    syncAll()
    scheduleSync()
    watchConfig()
  })
}
