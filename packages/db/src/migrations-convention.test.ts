import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDirectory, orderMigrationFiles } from './migrate'

// The hard rule written at the top of migrations/0001_init.sql: a file that commits its
// own work ends the runner's transaction early, so a later failure leaves that file half
// applied with nothing recorded in schema_migrations.
//
// The regex only matches transaction control *as a statement* — at the start of a line or
// right after a `;`, and closed by its own `;` — because plpgsql function bodies use
// `BEGIN … END` as a block keyword and those arrive with Phase 2. `BEGIN` opening a block
// is never followed by a semicolon, so it does not match here.
const TRANSACTION_CONTROL = /(?:^|;)\s*(?:START\s+TRANSACTION|(?:BEGIN|COMMIT|ROLLBACK)(?:\s+(?:TRANSACTION|WORK))?\s*;)/im

/** Only real SQL counts: the convention is *documented* in `--` comments in every file. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

describe('migration files', () => {
  it('leave transaction control to the runner', async () => {
    const directory = migrationsDirectory()
    const files = orderMigrationFiles(await readdir(directory))
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const sql = stripComments(await readFile(join(directory, file), 'utf8'))
      expect(sql, `${file} opens or closes a transaction of its own`).not.toMatch(TRANSACTION_CONTROL)
    }
  })
})
