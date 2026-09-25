import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The article's words, checked against the repo's own files. The article is not in this
// repository, so its values are quoted here as literals, each next to the section it comes from.

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

describe("the article's vocabulary", () => {
  it('§6: a payment has exactly six states, in the database and in the api', () => {
    const states = ['CREATED', 'RESERVED', 'SENT', 'SETTLED', 'FAILED', 'REVIEW']

    const check = /\bstatus\s+text[^,]*?CHECK\s*\(status IN \(([^)]*)\)\)/.exec(stripSqlComments(read('migrations/0007_payments.sql')))
    expect(check, "§6: migrations/0007_payments.sql lost the payments status CHECK").not.toBeNull()
    expect(quotedList(check?.[1] ?? ''), "§6: the payments status CHECK must list the article's six states, no more").toEqual(states)

    const type = /interface PaymentView \{[\s\S]*?readonly status: ([^\n]+)/.exec(read('packages/domain/src/api.ts'))
    expect(quotedList(type?.[1] ?? ''), "§6: PaymentView's status in packages/domain/src/api.ts must be the article's six states").toEqual(states)
  })

  it('§4: a payment reference is PAY- and four digits, like PAY-4821', () => {
    const generator = /`PAY-\$\{String\(randomInt\(([\d_]+)\)\)\.padStart\((\d+), '0'\)\}`/.exec(read('apps/api/src/payments/create-payment.ts'))
    expect(generator, '§4: newReference() in apps/api/src/payments/create-payment.ts no longer builds PAY-XXXX').not.toBeNull()
    expect(Number(generator?.[1]?.replaceAll('_', '')), '§4: the reference draws from 0 to 9999').toBe(10_000)
    expect(Number(generator?.[2]), '§4: the reference pads to four digits').toBe(4)
  })

  it('§5: the three accounts carry the names the article uses, and Available cannot go negative', () => {
    const chart = read('migrations/0002_ledger.sql')
    const accounts = { 'treasury:available': 'Available', 'treasury:reserved': 'Reserved', 'partner:payable': 'Partner debt' }

    for (const [code, name] of Object.entries(accounts)) {
      const row = new RegExp(`\\('${code}',[^)]*,\\s*(true|false)\\),?\\s*-- "([^"]+)"`).exec(chart)
      expect(row?.[2], `§5: ${code} in migrations/0002_ledger.sql must be labelled "${name}"`).toBe(name)
      expect(read('apps/ui/src/admin/StartScreen.tsx'), `§5: the Start screen's Books card must show "${name}"`).toContain(`['${name}', treasury.ledger.`)
    }
    const available = /\('treasury:available',[^)]*,\s*(true|false)\)/.exec(chart)
    expect(available?.[1], '§5: treasury:available must have allows_negative = false ("available can never go negative")').toBe('false')
  })

  it("§5, §7, §9: the fixtures start from the article's figures", () => {
    const seed = read('packages/ledger/src/seed.ts')
    expect(seed, '§5: ARTICLE_TREASURY must be 10,000').toContain('ARTICLE_TREASURY: MinorUnits = toMinor(10_000)')
    expect(seed, '§7: ARTICLE_PARTNER_DEBT must be 1,000').toContain('ARTICLE_PARTNER_DEBT: MinorUnits = toMinor(1_000)')
    expect(seed, '§9: RACE_TREASURY must be 1,500').toContain('RACE_TREASURY: MinorUnits = toMinor(1_500)')
  })
})
