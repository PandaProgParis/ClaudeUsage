// Pure logic for the Claude Usage agent - no Electron, no fs, no network.
// Everything here is unit-tested in test/lib.test.js.

const DEFAULT_CONFIG = {
  outputPath: '~/.claude-usage/usage.json',
  intervalMinutes: 5,
  endpoint: '', // empty = write the file only, post nothing
  expandAll: false, // only the active account's block is expanded unless asked
  notify: true, // a desktop notification when a quota fills up, and when it frees again
  notifySound: true, // that notification's system sound
  claudePath: 'claude', // the Claude Code CLI run by an account's artifact watch: a name on PATH or a full path
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(p, homedir) {
  if (p === '~') return homedir
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir + p.slice(1)
  return p
}

/**
 * Where to POST the payload after writing it, like the Chrome extension's
 * endpoint field. Anything that is not an http(s) URL is dropped rather than
 * allowed to break every sync.
 */
function resolveEndpoint(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : ''
  } catch {
    return ''
  }
}

/**
 * Merge a raw config.json with the defaults, clamping anything out of range.
 * `outputPathRaw` is the path as written (a `~` kept), so the settings window
 * can hand it back unchanged instead of freezing the expanded absolute path
 * into the file.
 */
function resolveConfig(raw, homedir) {
  const source = raw && typeof raw === 'object' ? raw : {}

  const rawPath = typeof source.outputPath === 'string' && source.outputPath.trim()
    ? source.outputPath.trim()
    : DEFAULT_CONFIG.outputPath

  const rawInterval = Number(source.intervalMinutes)
  const intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.min(Math.max(Math.round(rawInterval), 1), 1440)
    : DEFAULT_CONFIG.intervalMinutes

  return {
    outputPath: expandHome(rawPath, homedir),
    outputPathRaw: rawPath,
    intervalMinutes,
    endpoint: resolveEndpoint(source.endpoint),
    // A checkbox cannot produce a bad value, and a hand-edited file must not
    // break a reading over this one: whatever is there is coerced, never refused.
    expandAll: Boolean(source.expandAll),
    // Absent means the default, which is *on* here - Boolean(undefined) alone
    // would silence a fresh install's notifications.
    notify: source.notify == null ? DEFAULT_CONFIG.notify : Boolean(source.notify),
    notifySound: source.notifySound == null ? DEFAULT_CONFIG.notifySound : Boolean(source.notifySound),
    claudePath: typeof source.claudePath === 'string' && source.claudePath.trim()
      ? expandHome(source.claudePath.trim(), homedir)
      : DEFAULT_CONFIG.claudePath,
  }
}

/**
 * What the settings window must refuse before resolveConfig papers over it:
 * resolveConfig silently drops a bad endpoint and clamps a bad interval, which
 * is right for a hand-edited file and wrong for a form. Returns the names of
 * the offending fields, empty when everything is acceptable.
 */
function configProblems(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const problems = []

  // Absent means "no upload"; anything else must be a string, and a non-empty
  // one must be an http(s) URL - the same rule as outputPath below.
  if (source.endpoint != null && typeof source.endpoint !== 'string') {
    problems.push('endpoint')
  } else if (typeof source.endpoint === 'string' && source.endpoint.trim() && !resolveEndpoint(source.endpoint)) {
    problems.push('endpoint')
  }

  const rawInterval = source.intervalMinutes
  const interval = typeof rawInterval === 'number'
    ? rawInterval
    : typeof rawInterval === 'string' && rawInterval.trim() ? Number(rawInterval) : NaN
  if (!Number.isFinite(interval) || interval < 1 || interval > 1440) problems.push('intervalMinutes')

  if (typeof source.outputPath !== 'string' || !source.outputPath.trim()) problems.push('outputPath')

  return problems
}

// --- Identity ---

// What the user reads: tray tooltip, window titles. productName says the same
// thing to the OS (Start menu, installed apps, Task Manager).
const APP_NAME = 'Claude Usage'

// The userData folder every install since 1.0.0 keeps its claude.ai sessions in.
// Electron derives userData from productName, which is no longer this string,
// so main.js pins it here - letting it follow productName logs everyone out.
const USER_DATA_FOLDER = 'claude-usage'

// --- Accounts ---

// The partition every 1.0.x install already holds its claude.ai session in. The
// `default` account id maps onto it so an upgrade does not log anyone out - same
// gravity as USER_DATA_FOLDER.
const DEFAULT_PARTITION = 'persist:claudeai'
const MIGRATED_ACCOUNT_ID = 'default'

function partitionFor(id) {
  return id === MIGRATED_ACCOUNT_ID ? DEFAULT_PARTITION : DEFAULT_PARTITION + '-' + id
}

// Electron keeps a `persist:<name>` session in userData/Partitions/<name>. Only
// the names this app ever creates match: `claudeai` for the migrated account,
// `claudeai-` plus newAccountId()'s 8 hex characters for every other one.
const PARTITION_DIR = /^claudeai(-[0-9a-f]{8})?$/i

/**
 * The Partitions/ folders no account owns any more. Removing an account wipes
 * its cookies but cannot delete the folder of a session still open, and an
 * abandoned add-account attempt leaves one too: measured at 13 to 22 MB each.
 * Only a folder named like ours is ever a candidate, and the comparison
 * ignores case, as Windows does. The caller must only act on it with an
 * accounts.json that accountsFileTrusted() accepts.
 */
function orphanPartitionDirs(dirNames, accountIds) {
  const owned = new Set(
    (Array.isArray(accountIds) ? accountIds : [])
      .filter(id => typeof id === 'string' && id)
      .map(id => partitionFor(id).slice('persist:'.length).toLowerCase())
  )
  return (Array.isArray(dirNames) ? dirNames : [])
    .filter(name => typeof name === 'string' && PARTITION_DIR.test(name) && !owned.has(name.toLowerCase()))
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Normalise accounts.json. A *missing* file means an upgrade from a
 * single-account version, so it migrates to the historical session; a file
 * holding an empty list means the user removed their last account and must be
 * left empty. An unreadable file reaches us as `null` too: starting from the
 * historical session is the only outcome that preserves a live login.
 */
function resolveAccounts(raw) {
  if (raw == null) {
    return {
      activeId: MIGRATED_ACCOUNT_ID,
      accounts: [{ id: MIGRATED_ACCOUNT_ID, label: null, orgId: null }],
    }
  }

  const source = typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const entries = Array.isArray(source.accounts) ? source.accounts : []
  const seen = new Set()
  const accounts = []

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const id = cleanString(entry.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const account = { id, label: cleanString(entry.label), orgId: cleanString(entry.orgId) }
    // Only a watch that can run is kept: a broken one is dropped, never half-applied.
    const watch = resolveWatch(entry.watch)
    if (watch) account.watch = watch
    accounts.push(account)
  }

  const activeId = accounts.some(a => a.id === source.activeId)
    ? source.activeId
    : accounts.length > 0 ? accounts[0].id : null

  return { activeId, accounts }
}

// --- Artifact watch ---
//
// An account can keep a claude.ai artifact open in a hidden window and read a
// flag the page sets on its root element (`data-<flag>`). Each token of the
// flag is a job: when a new one appears, the agent runs the Claude Code CLI in
// the account's working directory, with the model and effort the page chose.

const WATCH_FLAG = /^[a-z][a-z0-9-]{0,39}$/
const MODEL_NAME = /^[a-z][a-z0-9.-]{0,39}$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/
const JOB_STAMP = /^[a-z0-9]{0,20}$/
const DEFAULT_WATCH = { prompt: 'travail.md', model: 'opus', effort: 'medium' }

/** Only claude.ai pages, over https: the hidden window carries the account's cookies. */
function watchUrl(value) {
  const text = cleanString(value)
  if (!text) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && url.hostname === 'claude.ai' ? url.href : null
  } catch {
    return null
  }
}

/** Absolute (POSIX or Windows) or home-relative: the CLI must never start in the agent's own folder. */
function isRootedDir(value) {
  return /^(~([\\/]|$)|\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
}

/** A path relative to the working directory, that cannot climb out of it. */
function isInnerPath(value) {
  return !isRootedDir(value) && !value.split(/[\\/]/).some(part => part === '..')
}

/**
 * Normalise an account's `watch` entry, or null when it cannot run: no
 * claude.ai artifact, no flag, no rooted working directory, or a prompt file
 * outside that directory. A bad model or effort falls back to the default
 * rather than reaching the CLI's command line.
 */
function resolveWatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const url = watchUrl(raw.url)
  const flag = (cleanString(raw.flag) || '').toLowerCase()
  const workDir = cleanString(raw.workDir)
  const prompt = cleanString(raw.prompt) || DEFAULT_WATCH.prompt
  if (!url || !WATCH_FLAG.test(flag) || !workDir || !isRootedDir(workDir) || !isInnerPath(prompt)) return null
  const model = cleanString(raw.model)
  const effort = cleanString(raw.effort)
  return {
    url,
    flag,
    workDir,
    prompt,
    // The Claude Code account the CLI runs as: its config folder. Empty means
    // the CLI's own default login, which may not be this claude.ai account.
    claudeConfigDir: cleanString(raw.claudeConfigDir) || '',
    model: model && MODEL_NAME.test(model) ? model : DEFAULT_WATCH.model,
    effort: EFFORTS.includes(effort) ? effort : DEFAULT_WATCH.effort,
    allowedTools: cleanString(raw.allowedTools) || '',
    // Extra variables for the CLI, set by hand. Claude Code only offers some
    // tools (ArtifactData) to an entrypoint it knows, CLAUDE_CODE_ENTRYPOINT.
    env: watchEnv(raw.env),
    // `auto` lets Claude Code's own safety check judge each action, which is
    // what allows writes to the artifact's database; bypassPermissions, which
    // skips every check, is refused for an agent nobody watches.
    permissionMode: PERMISSION_MODES.includes(raw.permissionMode) ? raw.permissionMode : 'acceptEdits',
  }
}

const PERMISSION_MODES = ['acceptEdits', 'auto', 'dontAsk', 'plan', 'manual']

/** Upper-case names and string values only: anything else is dropped, never coerced. */
function watchEnv(raw) {
  const env = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return env
  for (const [name, value] of Object.entries(raw)) {
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(name) && typeof value === 'string') env[name] = value
  }
  return env
}

/** The script run in each frame of the watched page: the flag, or null where it is absent. */
function flagScript(flag) {
  return '(() => document.documentElement.getAttribute(' + JSON.stringify('data-' + flag) + '))()'
}

/** The first frame that carries the flag wins, an empty flag included; null when none does. */
function pickFlag(values) {
  const found = (Array.isArray(values) ? values : []).find(v => typeof v === 'string')
  return found === undefined ? null : found
}

/**
 * The jobs a flag holds, one per space-separated token `id|model|effort|stamp`.
 * Model and effort may be left empty for the account defaults; a token with an
 * odd part is dropped whole, so nothing unchecked reaches the CLI.
 */
function parseFlag(value) {
  if (typeof value !== 'string') return []
  const jobs = []
  for (const token of value.trim().split(/\s+/)) {
    if (!token) continue
    const [id, model = '', effort = '', stamp = ''] = token.split('|')
    if (!JOB_ID.test(id) || (model && !MODEL_NAME.test(model)) || (effort && !EFFORTS.includes(effort)) || !JOB_STAMP.test(stamp)) continue
    jobs.push({ id, model, effort, stamp, token })
  }
  return jobs
}

/** The jobs of a flag not launched yet: a thread answered again comes back with a new stamp. */
function newJobs(launched, value) {
  return parseFlag(value).filter(job => !launched.has(job.token))
}

/** The CLI's arguments for one job; the prompt itself goes on stdin. */
function claudeArgs(watch, job) {
  const args = ['-p', '--model', job.model || watch.model, '--effort', job.effort || watch.effort, '--permission-mode', watch.permissionMode || 'acceptEdits']
  if (watch.allowedTools) args.push('--allowedTools', watch.allowedTools)
  return args
}

/**
 * Whether accounts.json, as parsed, may be taken at its word by the orphan
 * cleanup: an object holding an account list that resolveAccounts keeps whole.
 * A missing, unreadable or listless file falls back to a list that would
 * disown live sessions, and an entry dropped on the way in (bad id, duplicate)
 * means this is not a file the app wrote.
 */
function accountsFileTrusted(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.accounts)) return false
  return resolveAccounts(raw).accounts.length === raw.accounts.length
}

/**
 * Pick which organization to query. claude.ai stores the active one in the
 * `lastActiveOrg` cookie; otherwise prefer an org that can actually chat.
 */
function pickOrganization(orgs, preferredUuid) {
  if (!Array.isArray(orgs)) return null
  const valid = orgs.filter(o => o && typeof o.uuid === 'string' && o.uuid)
  if (valid.length === 0) return null

  const preferred = preferredUuid && valid.find(o => o.uuid === preferredUuid)
  if (preferred) return preferred.uuid

  const chatCapable = valid.find(o =>
    Array.isArray(o.capabilities) && o.capabilities.includes('chat')
  )
  if (chatCapable) return chatCapable.uuid

  return valid[0].uuid
}

/** 401/403 mean the claude.ai session is gone and the user must log in again. */
function isAuthFailure(status) {
  return status === 401 || status === 403
}

/**
 * Sanity check before writing: keeps us from overwriting a good file with an
 * error page or an empty body.
 */
function hasUsageShape(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  if (Array.isArray(payload.limits) && payload.limits.length > 0) return true
  return Boolean(
    payload.five_hour || payload.seven_day || payload.seven_day_sonnet ||
    payload.seven_day_opus || payload.seven_day_cowork
  )
}

// --- Gauges (ported from the Chrome extension popup) ---

// `limitKind` reads the gauge from the `limits[]` array when the top-level key is absent
const GAUGE_CONFIG = [
  { key: 'five_hour', limitKind: 'session', label: 'Session (5h)', color: '#D4956A' },
  { key: 'seven_day', limitKind: 'weekly_all', label: 'Weekly - All models', color: '#64B5F6' },
  { key: 'seven_day_sonnet', label: 'Weekly - Sonnet', color: '#8BB8E0' },
  { key: 'seven_day_opus', label: 'Weekly - Opus', color: '#FFB74D' },
  { key: 'seven_day_cowork', label: 'Weekly - Cowork', color: '#81C784' },
]

const MODEL_COLORS = {
  fable: '#BA68C8',
  mythos: '#F06292',
  opus: '#FFB74D',
  sonnet: '#64B5F6',
  haiku: '#81C784',
}

function modelColor(label) {
  const name = String(label).toLowerCase()
  const family = Object.keys(MODEL_COLORS).find(f => name.includes(f))
  return family ? MODEL_COLORS[family] : '#8BB8E0'
}

function limitsOf(payload) {
  return Array.isArray(payload.limits) ? payload.limits : []
}

function findLimit(payload, kind) {
  const limit = limitsOf(payload).find(l => l && l.kind === kind && l.percent != null)
  return limit ? { utilization: limit.percent, resets_at: limit.resets_at } : null
}

// Per-model weekly limits only live in `limits[]` since the Fable 5.1 payload
function scopedGauges(payload) {
  return limitsOf(payload)
    .filter(l => l && l.kind === 'weekly_scoped' && l.percent != null)
    .map(l => {
      const label = (l.scope && ((l.scope.model && l.scope.model.display_name) || l.scope.surface)) || null
      if (!label) return null
      return {
        key: `weekly_scoped_${label}`,
        label: `Weekly - ${label}`,
        color: modelColor(label),
        data: { utilization: l.percent, resets_at: l.resets_at },
      }
    })
    .filter(Boolean)
}

const DAY_UNIT = { en: 'd', fr: 'j' }

/** Human-readable countdown until a reset timestamp; days from 24 h on ("143h06" reads badly). */
function formatResetTime(isoDate, now = Date.now(), language = 'en') {
  if (!isoDate) return ''
  const target = new Date(isoDate).getTime()
  if (!Number.isFinite(target)) return ''
  const diff = target - now
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return `${h}h${String(m).padStart(2, '0')}`
  const days = `${Math.floor(h / 24)}${DAY_UNIT[language] || DAY_UNIT.en}`
  return h % 24 ? `${days} ${h % 24}h` : days
}

/** The reset instant as a number, or null - `null` and a malformed date alike. */
function resetTimestamp(isoDate) {
  if (!isoDate) return null
  const at = new Date(isoDate).getTime()
  return Number.isFinite(at) ? at : null
}

/**
 * Flatten a usage payload into render-ready gauges, so the panel renderer
 * stays a dumb view over this list.
 */
function buildGauges(payload, now = Date.now(), language = 'en') {
  if (!payload || typeof payload !== 'object') return []

  return GAUGE_CONFIG
    .map(g => {
      const top = payload[g.key] && payload[g.key].utilization != null ? payload[g.key] : null
      const data = top || (g.limitKind ? findLimit(payload, g.limitKind) : null)
      return data ? { ...g, data } : null
    })
    .filter(Boolean)
    .concat(scopedGauges(payload))
    .map(g => ({
      key: g.key,
      label: g.label,
      color: g.color,
      percent: Math.min(Math.max(Math.round(g.data.utilization), 0), 100),
      reset: formatResetTime(g.data.resets_at, now, language),
      // The formatted string cannot be compared; pickCountdown has to know
      // which of two full gauges frees the account last.
      resetAt: resetTimestamp(g.data.resets_at),
    }))
}

// --- Quota alerts ---

// claude.ai reports a utilization percentage; buildGauges rounds and clamps it,
// so a full quota is exactly 100 and nothing can sit above it.
const EXHAUSTED_PERCENT = 100

function isExhausted(gauge) {
  return Boolean(gauge) && gauge.percent >= EXHAUSTED_PERCENT
}

/**
 * What crossed between two readings of the *same* account. A gauge with no
 * previous entry is deliberately silent: that covers the first reading after a
 * launch (every gauge is new, and announcing a quota that was already full at
 * boot would be noise) and a `weekly_scoped` gauge that only appears once its
 * model has been used. A gauge already at 100% cannot re-fire either - it is
 * re-armed only by coming back down, so an oscillation at the boundary cannot
 * spam, and no debounce is needed.
 */
function diffGaugeAlerts(previous, next) {
  const before = new Map(
    (Array.isArray(previous) ? previous : []).filter(Boolean).map(g => [g.key, g])
  )
  const alerts = { exhausted: [], restored: [] }

  for (const gauge of (Array.isArray(next) ? next : []).filter(Boolean)) {
    const was = before.get(gauge.key)
    if (!was) continue
    if (!isExhausted(was) && isExhausted(gauge)) alerts.exhausted.push(gauge)
    else if (isExhausted(was) && !isExhausted(gauge)) alerts.restored.push(gauge)
  }

  return alerts
}

/**
 * The one countdown a collapsed block is worth showing: how long until the
 * account is usable again. A full gauge wins over an empty one - a session that
 * resets in 3 h frees nothing while the weekly is at 100% - and among the full
 * ones, the furthest reset, since that is the one that unblocks last. Nothing
 * full: the session, the only limit that moves on a human timescale.
 */
function pickCountdown(gauges) {
  const list = (Array.isArray(gauges) ? gauges : []).filter(Boolean)
  const full = list.filter(g => isExhausted(g) && g.resetAt != null)

  if (full.length > 0) {
    return full.reduce((furthest, g) => (g.resetAt > furthest.resetAt ? g : furthest)).reset || ''
  }

  const session = list.find(g => g.key === 'five_hour')
  return (session && session.reset) || ''
}

/**
 * The collapsed block's one line, structured rather than joined: the panel has
 * to paint the full percentages red, which a single string cannot express. The
 * tray tooltip keeps summarizeGauges - plain text by nature.
 */
function buildSummary(gauges) {
  const list = (Array.isArray(gauges) ? gauges : []).filter(Boolean)
  return {
    countdown: pickCountdown(list),
    values: list.map(g => ({ percent: g.percent, exhausted: isExhausted(g) })),
  }
}

// --- Account presentation ---

/** The one-line digest a collapsed account block shows: "42% · 17%". */
function summarizeGauges(gauges) {
  if (!Array.isArray(gauges) || gauges.length === 0) return ''
  return gauges.map(g => `${g.percent}%`).join(' · ')
}

/**
 * One status for the tray icon and the panel pill. Anything that needs the user
 * wins over the active account's own state: a healthy perso account must not
 * hide an expired pro one.
 */
function aggregateStatus(accounts, activeId) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : []
  if (list.length === 0) return 'login'
  for (const status of ['error', 'login', 'syncing']) {
    if (list.some(a => a.status === status)) return status
  }
  const active = list.find(a => a.id === activeId)
  return (active && active.status) || 'idle'
}

/**
 * The display name of an account: the organization its reading came from.
 * claude.ai names a personal org "<email>'s Organization", which eats the whole
 * width of a 320 px block header, so that suffix is dropped - unless dropping it
 * would leave nothing, which means the name was only the suffix.
 */
function organizationName(orgs, orgId) {
  if (!Array.isArray(orgs)) return null
  const org = orgs.find(o => o && o.uuid === orgId)
  if (!org) return null
  if (typeof org.name !== 'string' || !org.name.trim()) return null

  const name = org.name.trim()
  const stripped = name.replace(/['’]s Organi[sz]ation$/i, '').trim()
  return stripped || name
}

function gaugeDetail(gauges) {
  return (Array.isArray(gauges) ? gauges : [])
    .map(g => `${String(g.label || '').replace('Weekly - ', '')} ${g.percent}%`)
    .join(' · ')
}

/**
 * Tray tooltip. With one account it stays as detailed as it was in 1.0.x; with
 * several, one line per account answers the only question worth hovering for -
 * which one still has room.
 */
function buildTooltip(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : []
  if (list.length === 0) return APP_NAME

  if (list.length === 1) {
    const only = list[0]
    return [APP_NAME, only.message, gaugeDetail(only.gauges)].filter(Boolean).join('\n')
  }

  return [APP_NAME].concat(list.map(account => {
    const name = account.label || account.id
    const summary = summarizeGauges(account.gauges)
    return `${name} - ${summary || account.message || ''}`.trim()
  })).join('\n')
}

// --- i18n ---
//
// The agent follows the system locale: French for a French desktop, English
// everywhere else. Both dictionaries are asserted to hold the same keys by the
// test suite, so a string can never be added to one and forgotten in the other.

const MESSAGES = {
  en: {
    noReading: 'No reading yet',
    reading: 'Reading…',
    readAt: 'Read at {time}',
    failed: 'Failed: {error}',
    sessionExpired: 'Session expired',
    loginRequired: 'Login required',
    reconnectRequested: 'Reconnection requested',
    loginPrompt: '{reason} - log in from the window',
    loggedIn: 'Logged in - reading…',
    sent: 'Sent',
    sendFailed: 'Send failed: {error}',
    unreachable: 'claude.ai unreachable',
    fetchTimeout: '{path} did not answer in time',
    fetchFailed: '{path} unreachable ({error})',
    orgsResponded: '/api/organizations answered {status}',
    noOrg: 'no organization on this account',
    usageResponded: '/usage answered {status} with no usable data',
    loginWindowTitle: 'Claude Usage - sign in',
    trayGauges: 'Show gauges',
    traySync: 'Sync now',
    trayRelogin: 'Log in again…',
    trayOpenJson: 'Open the JSON folder',
    trayOpenConfig: 'Open the config',
    trayOpenLog: 'Open the log',
    trayAutostart: 'Start at login',
    trayQuit: 'Quit',
    traySettings: 'Settings…',
    trayAddAccount: 'Add an account…',
    noAccount: 'No account yet',
    accountUnnamed: 'Unnamed account',
    loginBusy: 'A login is already in progress on another account',
    panelEmpty: 'No reading yet',
    panelSync: 'Sync now',
    panelSettings: 'Settings',
    panelMinimize: 'Minimize',
    panelRelogin: 'Log in again',
    panelLogin: 'Log in', // an account that has never been connected
    panelAddAccount: 'Add an account',
    panelRemoveAccount: 'Delete this account',
    panelConfirmDelete: 'Delete',
    panelCancel: 'Cancel',
    panelActivate: 'Switch to this account',
    panelQuit: 'Quit',
    panelPending: 'pending',
    panelReset: 'reset {time}',
    panelCountdown: 'Usable again in {time}',
    notifyExhaustedTitle: '{account} : quota exhausted',
    notifyExhaustedBody: '{gauge}\nFull - back in {time}',
    notifyExhaustedBodyUnknown: '{gauge}\nFull',
    notifyRestoredTitle: '{account} : quota back',
    notifyRestoredBody: '{gauge}\nDown to {percent}%',
    configWindowTitle: 'Claude Usage - settings',
    configEndpoint: 'Upload URL',
    configEndpointHint: 'The JSON is POSTed to this http(s) address after each reading. Empty: write the file only.',
    configInterval: 'Interval (minutes)',
    configIntervalHint: 'Between 1 and 1440.',
    configOutputPath: 'Output file',
    configOutputPathHint: 'Where the JSON is written. A leading ~ is your home folder.',
    configExpandAll: 'Expand every account',
    configExpandAllHint: 'Show all the gauges at once. Otherwise only the active account is expanded.',
    configNotify: 'Notify me',
    configNotifyHint: 'A desktop notification when a quota fills up, and when it frees again.',
    configNotifySound: 'Notification sound',
    configNotifySoundHint: 'Uses the system notification sound. Unchecked, the notification stays silent.',
    configSave: 'Save',
    configCancel: 'Cancel',
    configInvalidEndpoint: 'Must be an http:// or https:// URL',
    configInvalidInterval: 'Must be a number between 1 and 1440',
    configInvalidPath: 'A file path is required',
    configWriteFailed: 'Could not write the config: {error}',
  },
  fr: {
    noReading: 'Aucun relevé',
    reading: 'Relevé en cours…',
    readAt: 'Relevé à {time}',
    failed: 'Échec : {error}',
    sessionExpired: 'Session expirée',
    loginRequired: 'Connexion requise',
    reconnectRequested: 'Reconnexion demandée',
    loginPrompt: '{reason} - connecte-toi dans la fenêtre',
    loggedIn: 'Connecté - relevé en cours…',
    sent: 'Envoyé',
    sendFailed: 'Envoi échoué : {error}',
    unreachable: 'claude.ai injoignable',
    fetchTimeout: '{path} n’a pas répondu à temps',
    fetchFailed: '{path} injoignable ({error})',
    orgsResponded: '/api/organizations a répondu {status}',
    noOrg: 'aucune organisation sur ce compte',
    usageResponded: '/usage a répondu {status} sans données exploitables',
    loginWindowTitle: 'Claude Usage - connexion',
    trayGauges: 'Voir les jauges',
    traySync: 'Relever maintenant',
    trayRelogin: 'Se reconnecter…',
    trayOpenJson: 'Ouvrir le dossier du JSON',
    trayOpenConfig: 'Ouvrir la config',
    trayOpenLog: 'Ouvrir le log',
    trayAutostart: 'Lancer au démarrage',
    trayQuit: 'Quitter',
    traySettings: 'Paramètres…',
    trayAddAccount: 'Ajouter un compte…',
    noAccount: 'Aucun compte suivi',
    accountUnnamed: 'Compte sans nom',
    loginBusy: 'Une connexion est déjà en cours sur un autre compte',
    panelEmpty: 'Pas encore de relevé',
    panelSync: 'Relever maintenant',
    panelSettings: 'Paramètres',
    panelMinimize: 'Réduire',
    panelRelogin: 'Se reconnecter',
    panelLogin: 'Se connecter', // un compte qui n'a jamais été connecté
    panelAddAccount: 'Ajouter un compte',
    panelRemoveAccount: 'Supprimer ce compte',
    panelConfirmDelete: 'Supprimer',
    panelCancel: 'Annuler',
    panelActivate: 'Basculer sur ce compte',
    panelQuit: 'Quitter',
    panelPending: 'en attente',
    panelReset: 'reset {time}',
    panelCountdown: 'De nouveau utilisable dans {time}',
    notifyExhaustedTitle: '{account} : quota épuisé',
    notifyExhaustedBody: '{gauge}\n100% - revient dans {time}',
    notifyExhaustedBodyUnknown: '{gauge}\n100%',
    notifyRestoredTitle: '{account} : quota revenu',
    notifyRestoredBody: '{gauge}\nRedescendu à {percent}%',
    configWindowTitle: 'Claude Usage - paramètres',
    configEndpoint: 'URL d’envoi',
    configEndpointHint: 'Le JSON est envoyé en POST à cette adresse http(s) après chaque relevé. Vide : le fichier seulement.',
    configInterval: 'Intervalle (minutes)',
    configIntervalHint: 'Entre 1 et 1440.',
    configOutputPath: 'Fichier de sortie',
    configOutputPathHint: 'Où écrire le JSON. Un ~ en tête désigne ton dossier personnel.',
    configExpandAll: 'Déplier tous les comptes',
    configExpandAllHint: 'Affiche toutes les jauges d’un coup. Sinon seul le compte actif est déplié.',
    configNotify: 'Me prévenir',
    configNotifyHint: 'Une notification du bureau quand un quota se remplit, et quand il se libère.',
    configNotifySound: 'Son de la notification',
    configNotifySoundHint: 'Utilise le son de notification du système. Décoché, la notification reste muette.',
    configSave: 'Enregistrer',
    configCancel: 'Annuler',
    configInvalidEndpoint: 'Doit être une URL http:// ou https://',
    configInvalidInterval: 'Doit être un nombre entre 1 et 1440',
    configInvalidPath: 'Un chemin de fichier est requis',
    configWriteFailed: 'Écriture de la config impossible : {error}',
  },
}

/** Any French-speaking locale gets French; everything else falls back to English. */
function pickLanguage(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

/**
 * Build the translator for a locale. Unknown keys come back as the key itself,
 * so a missing string is visible rather than silently empty.
 */
function createTranslator(locale) {
  const dictionary = MESSAGES[pickLanguage(locale)]
  return function translate(key, params) {
    const template = dictionary[key]
    if (template === undefined) return key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    )
  }
}

module.exports = {
  expandHome,
  MESSAGES,
  pickLanguage,
  createTranslator,
  DEFAULT_CONFIG,
  resolveConfig,
  resolveEndpoint,
  configProblems,
  APP_NAME,
  USER_DATA_FOLDER,
  MIGRATED_ACCOUNT_ID,
  partitionFor,
  orphanPartitionDirs,
  resolveAccounts,
  accountsFileTrusted,
  resolveWatch,
  flagScript,
  pickFlag,
  parseFlag,
  newJobs,
  claudeArgs,
  pickOrganization,
  isAuthFailure,
  hasUsageShape,
  formatResetTime,
  buildGauges,
  modelColor,
  summarizeGauges,
  EXHAUSTED_PERCENT,
  diffGaugeAlerts,
  pickCountdown,
  buildSummary,
  aggregateStatus,
  organizationName,
  buildTooltip,
}
