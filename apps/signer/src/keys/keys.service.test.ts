// The seed is the demo's money: the treasury address is funded by hand from a faucet, so
// "generated once, never overwritten, never leaked" is the contract these tests pin. They
// run against a real temporary directory, because file mode and "the file already exists"
// are exactly the parts a mocked filesystem would get wrong.
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { Logger, type LoggerService } from '@nestjs/common'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { KeysService } from './keys.service'

// The published Hardhat/anvil test mnemonic and the address it derives at index 0. NEVER
// a real seed: everyone on earth knows this phrase, which is exactly why it is safe here
// and reproducible outside this repo.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const TEST_TREASURY_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

let keysDir: string

/**
 * Every line the service logged during the current test.
 *
 * Silencing the logger keeps a test run tidy, but "the mnemonic is never logged" is a
 * claim about output, and a suite that throws the output away cannot make it: the
 * assertion would pass just as happily over a service that printed the seed. So the
 * lines are captured instead — out of the terminal, and within reach of an expectation.
 */
let logLines: string[] = []

/** Nest writes through whatever `overrideLogger` was given; this one writes to an array. */
const capturingLogger: LoggerService = {
  log: (message: unknown, ...rest: unknown[]) => logLines.push(formatted('log', message, rest)),
  error: (message: unknown, ...rest: unknown[]) => logLines.push(formatted('error', message, rest)),
  warn: (message: unknown, ...rest: unknown[]) => logLines.push(formatted('warn', message, rest)),
  debug: (message: unknown, ...rest: unknown[]) => logLines.push(formatted('debug', message, rest)),
  verbose: (message: unknown, ...rest: unknown[]) => logLines.push(formatted('verbose', message, rest)),
}

/** One line per call, level included, so a leak in a context argument is caught too. */
function formatted(level: string, message: unknown, rest: unknown[]): string {
  return [level, message, ...rest].map((part) => (typeof part === 'string' ? part : inspect(part))).join(' ')
}

beforeAll(() => {
  Logger.overrideLogger(capturingLogger)
})

beforeEach(async () => {
  logLines = []
  keysDir = await mkdtemp(join(tmpdir(), 'payments-keys-'))
})

afterEach(async () => {
  await rm(keysDir, { recursive: true, force: true })
})

describe('KeysService.load', () => {
  it('generates the seed on first start and writes it readable by its owner only', async () => {
    await KeysService.load(keysDir)

    const seedFile = join(keysDir, 'company.seed')
    const mode = (await stat(seedFile)).mode & 0o777
    expect(mode).toBe(0o600)
    // 12 words and nothing else: the file is the phrase, so it can be imported into a
    // wallet as it stands.
    expect((await readFile(seedFile, 'utf8')).trim().split(' ')).toHaveLength(12)
  })

  it('keeps the same treasury address across restarts', async () => {
    const first = await KeysService.load(keysDir)
    const second = await KeysService.load(keysDir)

    // This is what `docker compose down && up` has to preserve: a different address here
    // means the funded treasury is gone.
    expect(second.treasury().address).toBe(first.treasury().address)
  })

  it('reads an existing seed instead of generating a new one', async () => {
    await writeFile(join(keysDir, 'company.seed'), `${TEST_MNEMONIC}\n`, { mode: 0o600 })

    const service = await KeysService.load(keysDir)

    expect(service.treasury().address).toBe(TEST_TREASURY_ADDRESS)
  })

  it('refuses to start when the keys directory is missing, and says what to fix', async () => {
    const missing = join(keysDir, 'not-mounted')

    await expect(KeysService.load(missing)).rejects.toThrow(/does not exist/)
    // The message has to name the thing the reader can act on: the bind mount.
    await expect(KeysService.load(missing)).rejects.toThrow(/\.keys\/company:\/keys/)
  })

  it('logs the treasury address on every load, and no word of the mnemonic', async () => {
    const service = await KeysService.load(keysDir)
    const firstWord = await firstSeedWordOf(keysDir)

    expect(firstWord).not.toBe('')
    // The address is asserted first and for its own sake: it is what proves these lines
    // are the service's real output and not an empty array that would pass anything.
    expect(logLines.some((line) => line.includes(service.treasury().address))).toBe(true)
    // Whole words only. BIP-39 words are short and plain — `era` sits inside `generated`,
    // and a substring match would fail on a log line that leaked nothing.
    const leaked = new RegExp(`\\b${firstWord}\\b`)
    expect(logLines.filter((line) => leaked.test(line))).toEqual([])
  })

  it('hands out an account that signs without carrying the seed phrase', async () => {
    const service = await KeysService.load(keysDir)
    const firstWord = await firstSeedWordOf(keysDir)
    // What the signing endpoints hold while they work. It CAN sign — it is spending power
    // over the treasury — and that is exactly why it must not also be the whole seed: an
    // account that leaked would cost this one address, not every address the seed derives.
    const account = service.treasury()

    expect(firstWord).not.toBe('')
    expect(JSON.stringify(account)).not.toContain(firstWord)
    expect(inspect(account, { depth: 5 })).not.toContain(firstWord)
  })

  it('does not expose the mnemonic when the service is serialised or printed', async () => {
    const service = await KeysService.load(keysDir)
    // Read from disk rather than from the service: there is no way to get it out of the
    // service, which is the property under test.
    const firstWord = await firstSeedWordOf(keysDir)

    expect(firstWord).not.toBe('')
    expect(JSON.stringify(service)).not.toContain(firstWord)
    expect(inspect(service, { depth: 5 })).not.toContain(firstWord)
    expect(Object.keys(service)).toHaveLength(0)
  })
})

describe('KeysService addresses', () => {
  it('derives a stable, distinct address per deposit index', async () => {
    const service = await KeysService.load(keysDir)

    const first = service.depositAccount(1).address
    expect(service.depositAccount(1).address).toBe(first)
    expect(service.depositAccount(2).address).not.toBe(first)
    expect(first).not.toBe(service.treasury().address)
  })

  it('refuses to derive a deposit address at the treasury index', async () => {
    const service = await KeysService.load(keysDir)

    // Defended here and not only at the HTTP edge: nothing inside the process should be
    // able to hand out the treasury as a place for a partner to pay.
    expect(() => service.depositAccount(0)).toThrow(/treasury/)
    expect(() => service.depositAccount(-1)).toThrow(/whole number of 1 or more/)
  })
})

describe('the keys directory', () => {
  it('is not created by the signer', async () => {
    const missing = join(keysDir, 'not-mounted')

    await KeysService.load(missing).catch(() => undefined)

    // Creating it would hide a missing bind mount, and the seed would then live inside
    // the container: funded on Monday, gone on the next `docker compose down`.
    await expect(stat(missing)).rejects.toThrow()
    // Sanity: the failure above is about the missing directory, not about mkdir itself.
    await mkdir(missing)
    await expect(KeysService.load(missing)).resolves.toBeInstanceOf(KeysService)
  })
})

/** The generated seed is only known to the filesystem, so a leak check has to read it. */
async function firstSeedWordOf(directory: string): Promise<string> {
  return (await readFile(join(directory, 'company.seed'), 'utf8')).trim().split(' ')[0] ?? ''
}
