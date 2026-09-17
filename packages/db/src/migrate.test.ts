import { describe, expect, it } from 'vitest'
import { orderMigrationFiles } from './migrate'

// The order migrations run in is the whole contract of the runner: file 0002 must never
// land before 0001, whatever order the filesystem hands them over in.
describe('orderMigrationFiles', () => {
  it('sorts as text, which is the intended order because the prefixes are zero padded', () => {
    const entries = ['0010_ledger.sql', '0002_payments.sql', '0001_init.sql']
    expect(orderMigrationFiles(entries)).toEqual(['0001_init.sql', '0002_payments.sql', '0010_ledger.sql'])
  })

  it('ignores anything that is not a .sql file', () => {
    const entries = ['README.md', '0001_init.sql', '.DS_Store', 'notes.txt']
    expect(orderMigrationFiles(entries)).toEqual(['0001_init.sql'])
  })

  it('returns nothing for an empty directory', () => {
    expect(orderMigrationFiles([])).toEqual([])
  })
})
