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
const crypto = require('crypto')

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

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell, ipcMain, session, dialog } = electron

const {
  createTranslator,
  pickLanguage,
  resolveConfig,
  configProblems,
  pickOrganization,
  isAuthFailure,
  hasUsageShape,
  buildGauges,
  partitionFor,
  resolveAccounts,
  summarizeGauges,
  aggregateStatus,
  organizationName,
  buildTooltip,
} = require('./lib.js')

const CLAUDE_ORIGIN = 'https://claude.ai'
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
let config = { outputPath: '', intervalMinutes: 5, endpoint: '', expandAll: false }
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
// Only one login window at a time — two visible login pages and the user no
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
    relogin: t('panelRelogin'),
    addAccount: t('panelAddAccount'),
    removeAccount: t('panelRemoveAccount'),
    activate: t('panelActivate'),
    noAccount: t('noAccount'),
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
    expandAll: t('configExpandAll'),
    expandAllHint: t('configExpandAllHint'),
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

/**
 * `null` covers both "no file yet" (an upgrade from a single-account version)
 * and "unreadable file" — resolveAccounts turns either into the historical
 * account, the only outcome that preserves a live claude.ai session.
 */
function readAccountsFile() {
  try {
    return JSON.parse(fs.readFileSync(accountsFilePath(), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('accounts.json unreadable (' + err.message + ') — falling back to the historical session')
    }
    return null
  }
}

function writeAccountsFile() {
  try {
    fs.mkdirSync(path.dirname(accountsFilePath()), { recursive: true })
    fs.writeFileSync(
      accountsFilePath(),
      JSON.stringify(
        { activeId, accounts: accounts.map(a => ({ id: a.id, label: a.label, orgId: a.orgId })) },
        null,
        2
      ),
      'utf8'
    )
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

function loadAccounts() {
  const resolved = resolveAccounts(readAccountsFile())
  accounts = resolved.accounts.map(createAccountState)
  activeId = resolved.activeId
  log('accounts loaded — ' + accounts.length + ', active=' + (activeId || 'none'))
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

  const readingChanged = next.outputPath !== previous.outputPath ||
    next.intervalMinutes !== previous.intervalMinutes ||
    next.endpoint !== previous.endpoint
  if (!readingChanged && next.expandAll === previous.expandAll) return false

  log('config reloaded — output=' + config.outputPath + ' interval=' + config.intervalMinutes +
    'min endpoint=' + (config.endpoint || 'none') + ' expandAll=' + config.expandAll)

  // Folding blocks open or shut changes nothing on claude.ai's side: repaint,
  // do not spend a reading on it.
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
      expandAll: next.expandAll,
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
      gauges: account.gauges,
      summary: summarizeGauges(account.gauges),
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
 * A window's partition is fixed at creation and immutable afterwards, so every
 * account needs its own window. Created on first use and then kept: the login
 * flow reuses this very window, shown and hidden again, never recreated.
 */
function accountWindow(account) {
  if (account.window && !account.window.isDestroyed()) return account.window

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: t('loginWindowTitle') + ' — ' + accountName(account),
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      partition: partitionFor(account.id),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Closing the login window just hides it — the agent keeps running.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
    onLoginWindowClosed(account)
  })

  account.window = win
  return win
}

function loadPage(account, url) {
  const win = accountWindow(account)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      win.webContents.removeListener('did-finish-load', onLoad)
      win.webContents.removeListener('did-fail-load', onFail)
      resolve(ok)
    }
    const onLoad = () => finish(true)
    // -3 is ERR_ABORTED, which fires on ordinary redirects — not a failure.
    const onFail = (_event, code) => { if (code !== -3) finish(false) }
    const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS)

    win.webContents.on('did-finish-load', onLoad)
    win.webContents.on('did-fail-load', onFail)
    win.loadURL(url).catch(() => finish(false))
  })
}

/**
 * Run a same-origin fetch inside the claude.ai page and bring back the JSON.
 * Bounded twice: the fetch itself aborts, and the executeJavaScript promise is
 * raced against a timer — a page that navigates away mid-call never resolves
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
    const timer = setTimeout(() => reject(new Error(t('fetchTimeout', { path: pathname }))), FETCH_TIMEOUT_MS + 5000)
    accountWindow(account).webContents.executeJavaScript(script, true).then(
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

async function ensureOnClaudeOrigin(account) {
  if (accountWindow(account).webContents.getURL().startsWith(CLAUDE_ORIGIN)) return true
  if (await loadPage(account, IDLE_PAGE)) return true
  return loadPage(account, CLAUDE_ORIGIN + '/')
}

async function readCookie(account, name) {
  try {
    const store = accountWindow(account).webContents.session.cookies
    const cookies = await store.get({ url: CLAUDE_ORIGIN, name })
    return cookies.length > 0 ? cookies[0].value : null
  } catch {
    return null
  }
}

/** Never logged in vs. logged in once and dropped — the wording differs. */
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
  return new Date(date).toLocaleTimeString(appLocale, { hour: '2-digit', minute: '2-digit' })
}

/**
 * One reading, for one account. It never opens a login window by itself — that
 * call belongs to syncAll, which can see whether any account is still working.
 */
async function syncAccount(account) {
  if (!account || account.syncing || isQuitting || account.loginTimer) return

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
      setAccountState(account, { status: 'login', message: await authFailureReason(account) })
      return
    }
    if (!Array.isArray(orgs.json)) {
      throw new Error(t('orgsResponded', { status: orgs.status }))
    }

    const orgId = pickOrganization(orgs.json, await readCookie(account, 'lastActiveOrg'))
    if (!orgId) throw new Error(t('noOrg'))

    // The payload carries no account identity, so a block's name comes from the
    // organizations listing — refreshed on every reading, it costs nothing.
    const name = organizationName(orgs.json, orgId)
    const changed = (name && name !== account.label) || orgId !== account.orgId
    if (name) account.label = name
    account.orgId = orgId
    if (changed) writeAccountsFile() // after both fields, or the file lags behind

    const usage = await pageFetch(account, '/api/organizations/' + orgId + '/usage')
    if (stale()) return
    if (isAuthFailure(usage.status)) {
      setAccountState(account, { status: 'login', message: await authFailureReason(account) })
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
      log('sync ok (' + account.id + ') — gauges only')
    }
    const now = new Date().toISOString()

    const delivery = isActive && config.endpoint ? await postUsage(usage.json) : null
    if (stale()) return

    const readAt = t('readAt', { time: shortTime(now) })
    setAccountState(account, {
      status: 'ok',
      message: readAt,
      headline: readAt,
      lastSync: now,
      gauges: buildGauges(usage.json, Date.now(), pickLanguage(appLocale)),
      delivery,
    })
  } catch (err) {
    if (stale()) return // an orphaned fetch timing out is not news
    log('sync failed (' + account.id + '): ' + err.message)
    setAccountState(account, { status: 'error', message: t('failed', { error: err.message }) })
  } finally {
    if (account.syncing === run) account.syncing = 0
  }
}

/**
 * One pass over every account, in panel order and strictly sequential: two
 * logins hitting claude.ai at once buys nothing and doubles the live renderers.
 * A failing account does not interrupt the pass — each block carries its own
 * status, which is what lets a healthy perso account survive an expired pro one.
 */
async function syncAll() {
  if (isQuitting || accounts.length === 0) return

  for (const account of accounts) {
    await syncAccount(account)
    if (isQuitting) return
  }

  // A single-account agent that is logged out is useless, so it still opens the
  // login window by itself — exactly the 1.0.1 behaviour. With several accounts,
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
  setAccountState(account, { status: 'login', message: t('loginPrompt', { reason }) })

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
  if (account.window && !account.window.isDestroyed()) account.window.hide()
  log('login ok (' + account.id + ')')
  setAccountState(account, { status: 'idle', message: t('loggedIn') })
  loadPage(account, IDLE_PAGE).then(async () => {
    // This account first, so the panel reacts at once, then catch up the others.
    await syncAccount(account)
    syncAll()
  })
}

/**
 * A login window closed by hand. An account that never got a name means the user
 * abandoned an "add an account" attempt: keeping it would leave an empty block
 * behind on every try.
 */
function onLoginWindowClosed(account) {
  const abandoned = Boolean(account.loginTimer) && !account.label
  cancelLogin(account)
  if (abandoned) {
    log('add-account abandoned — dropping ' + account.id)
    // Out of the close handler before destroying the window it fired on, and
    // without a confirmation prompt: the user just closed that very window.
    setImmediate(() => dropAccount(account.id))
    return
  }
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
 * Wiping a session is irreversible (a new login needs a fresh e-mail code) and
 * the button that does it now sits in the block header, a few pixels from the
 * switch target. So it asks first.
 */
async function confirmRemoval(account) {
  const options = {
    type: 'warning',
    buttons: [t('removeConfirmCancel'), t('removeConfirmOk')],
    defaultId: 0,
    cancelId: 0,
    message: t('removeConfirm', { name: accountName(account) }),
    detail: t('removeConfirmDetail'),
  }
  try {
    const parent = panelWindow && !panelWindow.isDestroyed() ? panelWindow : null
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    return response === 1
  } catch (err) {
    log('removal confirmation failed: ' + err.message)
    return false // never wipe a session because a dialog misbehaved
  }
}

/**
 * Forget an account: wipe its partition, drop its window, remove its block. This
 * replaces 1.0.x's "log out" — reconnecting is one click on "add an account", so
 * a second, nearly identical gesture was not worth its code.
 */
async function removeAccount(id) {
  const account = findAccount(id)
  if (!account) return
  if (!(await confirmRemoval(account))) return
  return dropAccount(id)
}

/** The same thing without asking — for an add-account attempt the user abandoned. */
async function dropAccount(id) {
  const account = findAccount(id)
  if (!account) return

  cancelLogin(account)
  abandonReading(account)
  accounts = accounts.filter(a => a.id !== id)
  if (activeId === id) activeId = accounts.length > 0 ? accounts[0].id : null
  writeAccountsFile()

  try {
    if (account.window && !account.window.isDestroyed()) {
      await account.window.webContents.session.clearStorageData()
      account.window.destroy()
    } else {
      // Never opened this run, but its cookies are still on disk.
      await session.fromPartition(partitionFor(id)).clearStorageData()
    }
    log('account removed — ' + id)
  } catch (err) {
    log('account removal failed (' + id + '): ' + err.message)
  }

  broadcast()
  if (activeId) syncAccount(activeAccount())
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
    { label: t('traySync'), click: () => syncAll() },
    { label: t('traySettings'), click: () => openConfigWindow() },
    { type: 'separator' },
    { label: t('trayRelogin'), click: () => startLogin(activeAccount(), t('reconnectRequested')) },
    { label: t('trayAddAccount'), click: () => addAccount() },
    { label: t('trayRemoveAccount'), enabled: Boolean(activeId), click: () => removeAccount(activeId) },
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
  // Through broadcast, never a hand-rolled send: `state` alone no longer holds
  // the account list, and pushing it raw left the panel with no blocks at all
  // until the next reading.
  broadcast()
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
  for (const account of accounts) cancelLogin(account)
  fs.unwatchFile(configFilePath())
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
      expandAll: config.expandAll,
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

    // Before createAccountState: its labels come from the translator.
    loadAccounts()
    writeAccountsFile() // materialise the file on a first run, as config.json does

    Object.assign(state, {
      intervalMinutes: config.intervalMinutes,
      endpoint: config.endpoint,
      autostart: isAutostartEnabled(),
      labels: panelLabels(),
    })

    registerIpc()
    createPanel() // worker windows are created per account, on first use
    createTray()

    // A fresh install starts with Windows, as asked; the tray menu can undo it.
    if (isFirstRun) setAutostart(true)

    syncAll()
    scheduleSync()
    watchConfig()
  })
}
