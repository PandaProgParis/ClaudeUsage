// Pure logic for the claude-usage agent — no Electron, no fs, no network.
// Everything here is unit-tested in test/lib.test.js.

const DEFAULT_CONFIG = {
  outputPath: '~/.claude-usage/usage.json',
  intervalMinutes: 5,
  endpoint: '', // empty = write the file only, post nothing
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
  // one must be an http(s) URL — the same rule as outputPath below.
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

// --- Accounts ---

// The partition every 1.0.x install already holds its claude.ai session in. The
// `default` account id maps onto it so an upgrade does not log anyone out — same
// gravity as renaming productName.
const DEFAULT_PARTITION = 'persist:claudeai'
const MIGRATED_ACCOUNT_ID = 'default'

function partitionFor(id) {
  return id === MIGRATED_ACCOUNT_ID ? DEFAULT_PARTITION : DEFAULT_PARTITION + '-' + id
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
    accounts.push({ id, label: cleanString(entry.label), orgId: cleanString(entry.orgId) })
  }

  const activeId = accounts.some(a => a.id === source.activeId)
    ? source.activeId
    : accounts.length > 0 ? accounts[0].id : null

  return { activeId, accounts }
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
  { key: 'seven_day', limitKind: 'weekly_all', label: 'Weekly — All models', color: '#64B5F6' },
  { key: 'seven_day_sonnet', label: 'Weekly — Sonnet', color: '#8BB8E0' },
  { key: 'seven_day_opus', label: 'Weekly — Opus', color: '#FFB74D' },
  { key: 'seven_day_cowork', label: 'Weekly — Cowork', color: '#81C784' },
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
        label: `Weekly — ${label}`,
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
    }))
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
    loginPrompt: '{reason} — log in from the window',
    loggedIn: 'Logged in — reading…',
    sent: 'Sent',
    sendFailed: 'Send failed: {error}',
    unreachable: 'claude.ai unreachable',
    fetchTimeout: '{path} did not answer in time',
    fetchFailed: '{path} unreachable ({error})',
    orgsResponded: '/api/organizations answered {status}',
    noOrg: 'no organization on this account',
    usageResponded: '/usage answered {status} with no usable data',
    loginWindowTitle: 'claude-usage — sign in',
    trayGauges: 'Show gauges',
    traySync: 'Sync now',
    trayRelogin: 'Log in again…',
    trayOpenJson: 'Open the JSON folder',
    trayOpenConfig: 'Open the config',
    trayOpenLog: 'Open the log',
    trayAutostart: 'Start at login',
    trayQuit: 'Quit',
    traySettings: 'Settings…',
    trayLogout: 'Log out',
    loggedOut: 'Logged out — reconnect to resume readings',
    panelEmpty: 'No reading yet',
    panelSync: 'Sync now',
    panelSettings: 'Settings',
    panelMinimize: 'Minimize',
    panelRelogin: 'Log in again',
    panelLogout: 'Log out',
    panelQuit: 'Quit',
    panelPending: 'pending',
    panelReset: 'reset {time}',
    configWindowTitle: 'claude-usage — settings',
    configEndpoint: 'Upload URL',
    configEndpointHint: 'The JSON is POSTed to this http(s) address after each reading. Empty: write the file only.',
    configInterval: 'Interval (minutes)',
    configIntervalHint: 'Between 1 and 1440.',
    configOutputPath: 'Output file',
    configOutputPathHint: 'Where the JSON is written. A leading ~ is your home folder.',
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
    loginPrompt: '{reason} — connecte-toi dans la fenêtre',
    loggedIn: 'Connecté — relevé en cours…',
    sent: 'Envoyé',
    sendFailed: 'Envoi échoué : {error}',
    unreachable: 'claude.ai injoignable',
    fetchTimeout: '{path} n’a pas répondu à temps',
    fetchFailed: '{path} injoignable ({error})',
    orgsResponded: '/api/organizations a répondu {status}',
    noOrg: 'aucune organisation sur ce compte',
    usageResponded: '/usage a répondu {status} sans données exploitables',
    loginWindowTitle: 'claude-usage — connexion',
    trayGauges: 'Voir les jauges',
    traySync: 'Relever maintenant',
    trayRelogin: 'Se reconnecter…',
    trayOpenJson: 'Ouvrir le dossier du JSON',
    trayOpenConfig: 'Ouvrir la config',
    trayOpenLog: 'Ouvrir le log',
    trayAutostart: 'Lancer au démarrage',
    trayQuit: 'Quitter',
    traySettings: 'Paramètres…',
    trayLogout: 'Déconnecter le compte',
    loggedOut: 'Compte déconnecté — reconnecte-toi pour reprendre les relevés',
    panelEmpty: 'Pas encore de relevé',
    panelSync: 'Relever maintenant',
    panelSettings: 'Paramètres',
    panelMinimize: 'Réduire',
    panelRelogin: 'Se reconnecter',
    panelLogout: 'Déconnecter le compte',
    panelQuit: 'Quitter',
    panelPending: 'en attente',
    panelReset: 'reset {time}',
    configWindowTitle: 'claude-usage — paramètres',
    configEndpoint: 'URL d’envoi',
    configEndpointHint: 'Le JSON est envoyé en POST à cette adresse http(s) après chaque relevé. Vide : le fichier seulement.',
    configInterval: 'Intervalle (minutes)',
    configIntervalHint: 'Entre 1 et 1440.',
    configOutputPath: 'Fichier de sortie',
    configOutputPathHint: 'Où écrire le JSON. Un ~ en tête désigne ton dossier personnel.',
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
  MESSAGES,
  pickLanguage,
  createTranslator,
  DEFAULT_CONFIG,
  resolveConfig,
  resolveEndpoint,
  configProblems,
  MIGRATED_ACCOUNT_ID,
  partitionFor,
  resolveAccounts,
  pickOrganization,
  isAuthFailure,
  hasUsageShape,
  formatResetTime,
  buildGauges,
  modelColor,
}
