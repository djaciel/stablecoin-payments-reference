import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The domain's words and example figures, checked against the repo's own files. The expected
// values are quoted here as literals, so a change in one place fails until it is made everywhere.

const ROOT = resolve(__dirname, '../../..')

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

function quotedList(list: string): string[] {
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '')
}

describe('the domain vocabulary', () => {
  it('a payment has exactly six states, in the database and in the api', () => {
    const states = ['CREATED', 'RESERVED', 'SENT', 'SETTLED', 'FAILED', 'REVIEW']

    const check = /\bstatus\s+text[^,]*?CHECK\s*\(status IN \(([^)]*)\)\)/.exec(stripSqlComments(read('migrations/0007_payments.sql')))
    expect(check, 'migrations/0007_payments.sql lost the payments status CHECK').not.toBeNull()
    expect(quotedList(check?.[1] ?? ''), 'payment states must be exactly CREATED, RESERVED, SENT, SETTLED, FAILED, REVIEW in the payments status CHECK').toEqual(states)

    const type = /interface PaymentView \{[\s\S]*?readonly status: ([^\n]+)/.exec(read('packages/domain/src/api.ts'))
    expect(quotedList(type?.[1] ?? ''), "payment states must be exactly CREATED, RESERVED, SENT, SETTLED, FAILED, REVIEW in PaymentView's status in packages/domain/src/api.ts").toEqual(states)
  })

  it('a payment reference is PAY- and four digits, like PAY-4821', () => {
    const generator = /`PAY-\$\{String\(randomInt\(([\d_]+)\)\)\.padStart\((\d+), '0'\)\}`/.exec(read('apps/api/src/payments/create-payment.ts'))
    expect(generator, 'newReference() in apps/api/src/payments/create-payment.ts no longer builds PAY-XXXX').not.toBeNull()
    expect(Number(generator?.[1]?.replaceAll('_', '')), 'the reference draws from 0 to 9999').toBe(10_000)
    expect(Number(generator?.[2]), 'the reference pads to four digits').toBe(4)
  })

  it('the three accounts carry their screen names, and Available cannot go negative', () => {
    const chart = read('migrations/0002_ledger.sql')
    const accounts = { 'treasury:available': 'Available', 'treasury:reserved': 'Reserved', 'partner:payable': 'Partner debt' }

    for (const [code, name] of Object.entries(accounts)) {
      const row = new RegExp(`\\('${code}',[^)]*,\\s*(true|false)\\),?\\s*-- "([^"]+)"`).exec(chart)
      expect(row?.[2], `${code} in migrations/0002_ledger.sql must be labelled "${name}"`).toBe(name)
      expect(read('apps/ui/src/admin/StartScreen.tsx'), `the Start screen's Books card must show "${name}"`).toContain(`['${name}', treasury.ledger.`)
    }
    const available = /\('treasury:available',[^)]*,\s*(true|false)\)/.exec(chart)
    expect(available?.[1], 'treasury:available must have allows_negative = false ("available can never go negative")').toBe('false')
  })

  it('the fixtures start from the example figures', () => {
    const seed = read('packages/ledger/src/seed.ts')
    expect(seed, 'EXAMPLE_TREASURY must be 10,000').toContain('EXAMPLE_TREASURY: MinorUnits = toMinor(10_000)')
    expect(seed, 'EXAMPLE_PARTNER_DEBT must be 1,000').toContain('EXAMPLE_PARTNER_DEBT: MinorUnits = toMinor(1_000)')
    expect(seed, 'RACE_TREASURY must be 1,500').toContain('RACE_TREASURY: MinorUnits = toMinor(1_500)')
  })
})
