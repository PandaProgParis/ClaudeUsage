import { describe, it, expect } from 'vitest'
import {
  MESSAGES,
  pickLanguage,
  createTranslator,
  resolveConfig,
  resolveEndpoint,
  pickOrganization,
  isAuthFailure,
  hasUsageShape,
  formatResetTime,
  buildGauges,
} from '../src/lib.js'

const HOME = 'C:/Users/tester'

describe('resolveConfig', () => {
  it('falls back to defaults when the file is missing or garbage', () => {
    for (const raw of [null, undefined, 'nope', 42, []]) {
      const cfg = resolveConfig(raw, HOME)
      expect(cfg.intervalMinutes).toBe(5)
      expect(cfg.outputPath).toBe('C:/Users/tester/.claude-cockpit/usage-live.json')
      expect(cfg.endpoint).toBe('')
    }
  })

  it('carries a valid endpoint through, and drops an invalid one', () => {
    expect(resolveConfig({ endpoint: 'http://localhost:6601/api/usage/inject' }, HOME).endpoint)
      .toBe('http://localhost:6601/api/usage/inject')
    expect(resolveConfig({ endpoint: 'nope' }, HOME).endpoint).toBe('')
  })

  it('expands a leading ~ in outputPath', () => {
    expect(resolveConfig({ outputPath: '~/usage.json' }, HOME).outputPath)
      .toBe('C:/Users/tester/usage.json')
    expect(resolveConfig({ outputPath: '~' }, HOME).outputPath).toBe(HOME)
  })

  it('leaves absolute paths alone', () => {
    expect(resolveConfig({ outputPath: 'D:/data/usage.json' }, HOME).outputPath)
      .toBe('D:/data/usage.json')
  })

  it('does not expand a ~ that is not a home prefix', () => {
    expect(resolveConfig({ outputPath: 'D:/~backup/usage.json' }, HOME).outputPath)
      .toBe('D:/~backup/usage.json')
  })

  it('clamps the interval to a sane range', () => {
    expect(resolveConfig({ intervalMinutes: 0 }, HOME).intervalMinutes).toBe(5)
    expect(resolveConfig({ intervalMinutes: -3 }, HOME).intervalMinutes).toBe(5)
    expect(resolveConfig({ intervalMinutes: 'abc' }, HOME).intervalMinutes).toBe(5)
    expect(resolveConfig({ intervalMinutes: 0.4 }, HOME).intervalMinutes).toBe(1)
    expect(resolveConfig({ intervalMinutes: 99999 }, HOME).intervalMinutes).toBe(1440)
    expect(resolveConfig({ intervalMinutes: 15 }, HOME).intervalMinutes).toBe(15)
  })
})

describe('i18n', () => {
  it('routes French locales to French and everything else to English', () => {
    expect(pickLanguage('fr')).toBe('fr')
    expect(pickLanguage('fr-FR')).toBe('fr')
    expect(pickLanguage('FR-ca')).toBe('fr')
    expect(pickLanguage('en-US')).toBe('en')
    expect(pickLanguage('de')).toBe('en')
    expect(pickLanguage(undefined)).toBe('en')
    expect(pickLanguage('')).toBe('en')
  })

  it('keeps both dictionaries on exactly the same keys', () => {
    expect(Object.keys(MESSAGES.fr).sort()).toEqual(Object.keys(MESSAGES.en).sort())
  })

  it('leaves no dictionary entry empty', () => {
    for (const [language, dictionary] of Object.entries(MESSAGES)) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(typeof value, language + '.' + key).toBe('string')
        expect(value.length, language + '.' + key).toBeGreaterThan(0)
      }
    }
  })

  it('interpolates named parameters', () => {
    expect(createTranslator('en')('readAt', { time: '21:30' })).toBe('Read at 21:30')
    expect(createTranslator('fr-FR')('readAt', { time: '21:30' })).toBe('Relevé à 21:30')
    expect(createTranslator('en')('usageResponded', { status: 500 }))
      .toBe('/usage answered 500 with no usable data')
  })

  it('leaves a placeholder alone when the parameter is missing', () => {
    expect(createTranslator('en')('readAt', {})).toBe('Read at {time}')
  })

  it('returns the key itself for an unknown string, so the gap is visible', () => {
    expect(createTranslator('en')('nopeNotAKey')).toBe('nopeNotAKey')
  })
})

describe('resolveEndpoint', () => {
  it('keeps http and https URLs, trimmed', () => {
    expect(resolveEndpoint(' http://localhost:6601/api/usage/inject '))
      .toBe('http://localhost:6601/api/usage/inject')
    expect(resolveEndpoint('https://example.com/hook')).toBe('https://example.com/hook')
  })

  it('drops anything that is not an http(s) URL', () => {
    expect(resolveEndpoint('file:///etc/passwd')).toBe('')
    expect(resolveEndpoint('javascript:alert(1)')).toBe('')
    expect(resolveEndpoint('localhost:6601')).toBe('')
    expect(resolveEndpoint('pas une url')).toBe('')
  })

  it('treats empty and non-strings as disabled', () => {
    expect(resolveEndpoint('')).toBe('')
    expect(resolveEndpoint('   ')).toBe('')
    expect(resolveEndpoint(null)).toBe('')
    expect(resolveEndpoint(42)).toBe('')
    expect(resolveEndpoint(undefined)).toBe('')
  })
})

describe('pickOrganization', () => {
  const orgs = [
    { uuid: 'aaa', capabilities: ['api'] },
    { uuid: 'bbb', capabilities: ['chat', 'claude_pro'] },
  ]

  it('honours the lastActiveOrg cookie when it matches', () => {
    expect(pickOrganization(orgs, 'aaa')).toBe('aaa')
  })

  it('ignores a stale cookie that matches no org', () => {
    expect(pickOrganization(orgs, 'zzz')).toBe('bbb')
  })

  it('prefers a chat-capable org when there is no cookie', () => {
    expect(pickOrganization(orgs, null)).toBe('bbb')
  })

  it('falls back to the first org when none advertises chat', () => {
    expect(pickOrganization([{ uuid: 'aaa' }, { uuid: 'ccc' }], null)).toBe('aaa')
  })

  it('returns null when there is nothing usable', () => {
    expect(pickOrganization(null, null)).toBeNull()
    expect(pickOrganization([], null)).toBeNull()
    expect(pickOrganization([{ name: 'no uuid' }, null], null)).toBeNull()
  })
})

describe('isAuthFailure', () => {
  it('flags only 401 and 403', () => {
    expect(isAuthFailure(401)).toBe(true)
    expect(isAuthFailure(403)).toBe(true)
    expect(isAuthFailure(200)).toBe(false)
    expect(isAuthFailure(500)).toBe(false)
  })
})

describe('hasUsageShape', () => {
  it('accepts a limits[] payload', () => {
    expect(hasUsageShape({ limits: [{ kind: 'session', percent: 12 }] })).toBe(true)
  })

  it('accepts a legacy top-level payload', () => {
    expect(hasUsageShape({ five_hour: { utilization: 3 } })).toBe(true)
  })

  it('rejects anything that is not a usage payload', () => {
    expect(hasUsageShape(null)).toBe(false)
    expect(hasUsageShape('<html>login</html>')).toBe(false)
    expect(hasUsageShape({})).toBe(false)
    expect(hasUsageShape({ limits: [] })).toBe(false)
    expect(hasUsageShape([{ limits: [1] }])).toBe(false)
  })
})

describe('formatResetTime', () => {
  const now = Date.parse('2026-09-12T10:00:00Z')

  it('renders minutes under an hour', () => {
    expect(formatResetTime('2026-09-12T10:42:00Z', now)).toBe('42min')
  })

  it('renders hours and zero-padded minutes', () => {
    expect(formatResetTime('2026-09-12T13:05:00Z', now)).toBe('3h05')
  })

  it('says now for a reset in the past', () => {
    expect(formatResetTime('2026-09-12T09:00:00Z', now)).toBe('now')
  })

  it('returns an empty string for missing or invalid dates', () => {
    expect(formatResetTime(null, now)).toBe('')
    expect(formatResetTime('not-a-date', now)).toBe('')
  })
})

describe('buildGauges', () => {
  const now = Date.parse('2026-09-12T10:00:00Z')

  it('reads the session and weekly gauges from limits[]', () => {
    const gauges = buildGauges({
      five_hour: null,
      seven_day: null,
      limits: [
        { kind: 'session', percent: 37, resets_at: '2026-09-12T12:00:00Z' },
        { kind: 'weekly_all', percent: 8, resets_at: null },
      ],
    }, now)

    expect(gauges.map(g => [g.label, g.percent, g.reset])).toEqual([
      ['Session (5h)', 37, '2h00'],
      ['Weekly — All models', 8, ''],
    ])
  })

  it('builds one gauge per weekly_scoped model, coloured by family', () => {
    const gauges = buildGauges({
      limits: [
        { kind: 'weekly_scoped', percent: 64, resets_at: null, scope: { model: { display_name: 'Opus 5' } } },
        { kind: 'weekly_scoped', percent: 12, resets_at: null, scope: { model: { display_name: 'Sonnet 5' } } },
      ],
    }, now)

    expect(gauges).toEqual([
      { key: 'weekly_scoped_Opus 5', label: 'Weekly — Opus 5', color: '#FFB74D', percent: 64, reset: '' },
      { key: 'weekly_scoped_Sonnet 5', label: 'Weekly — Sonnet 5', color: '#64B5F6', percent: 12, reset: '' },
    ])
  })

  it('prefers a top-level utilization over the limits[] entry', () => {
    const gauges = buildGauges({
      five_hour: { utilization: 90, resets_at: null },
      limits: [{ kind: 'session', percent: 10, resets_at: null }],
    }, now)
    expect(gauges[0].percent).toBe(90)
  })

  it('clamps percentages into 0..100', () => {
    const gauges = buildGauges({ limits: [{ kind: 'session', percent: 137.6, resets_at: null }] }, now)
    expect(gauges[0].percent).toBe(100)
  })

  it('skips scoped limits with no readable label', () => {
    const gauges = buildGauges({ limits: [{ kind: 'weekly_scoped', percent: 5, scope: {} }] }, now)
    expect(gauges).toEqual([])
  })

  it('returns nothing for an empty or absent payload', () => {
    expect(buildGauges(null, now)).toEqual([])
    expect(buildGauges({}, now)).toEqual([])
  })
})
