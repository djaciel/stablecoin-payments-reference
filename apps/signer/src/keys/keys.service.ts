import { access, chmod, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import { TREASURY_ADDRESS_INDEX, deriveAccount } from '@payments/chain'
import type { HDAccount } from 'viem'
import { english, generateMnemonic } from 'viem/accounts'

/** The file inside the keys directory. One seed, one file, one line. */
const SEED_FILE = 'company.seed'

/** Owner read/write only. Nobody else on the machine, not even the group. */
const SEED_FILE_MODE = 0o600

/**
 * The company seed, and the only object in this repo that holds it.
 *
 * Everything else — the controllers, and the signing endpoints that arrive later — asks
 * this service for an account and receives an `HDAccount`. The mnemonic itself never
 * leaves this file: it is not logged, not returned by any endpoint, and not exposed by a
 * getter. That boundary is the point of running the signer as a separate service at all,
 * so it is worth defending in the smallest place, which is here.
 */
export class KeysService {
  private static readonly logger = new Logger(KeysService.name)

  /**
   * `#mnemonic`, not `private mnemonic`: TypeScript's `private` is a compile-time promise
   * and nothing more, so the phrase would still turn up in `JSON.stringify(service)`, in
   * `console.log(service)` and in any error reporter that walks an object's properties.
   * A JavaScript private field is invisible to all three.
   */
  readonly #mnemonic: string

  /** Private: the only way in is `load`, which guarantees the seed exists on disk. */
  private constructor(mnemonic: string) {
    this.#mnemonic = mnemonic
  }

  /**
   * Reads the seed from `keysDir`, generating it on first start.
   *
   * Called from the module's provider factory, so a failure here happens before the
   * server listens: a signer that cannot reach its seed must not answer requests, it
   * must die loudly enough that `docker compose logs signer` explains itself.
   */
  static async load(keysDir: string): Promise<KeysService> {
    await requireWritableDirectory(keysDir)

    const file = join(keysDir, SEED_FILE)
    const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined
      }
      throw new Error(`the seed file ${file} exists but could not be read: ${error.message}`, { cause: error })
    })

    const mnemonic = existing === undefined ? await generateSeedFile(file) : existing.trim()
    const service = new KeysService(mnemonic)

    // Deriving now turns "the file is unreadable garbage" into a startup failure instead
    // of a 500 on the first request.
    const treasury = service.treasury()

    KeysService.logger.log(`treasury address: ${treasury.address}`)
    KeysService.logger.log(`the company seed is at ${file}, generated on this machine and gitignored`)
    KeysService.logger.warn('testnet only: this seed is generated for a demo on Base Sepolia')
    KeysService.logger.warn('a real treasury key lives in custody infrastructure, never in a file next to the code')

    return service
  }

  /** Index 0 of the company seed: the address that holds the company's money. */
  treasury(): HDAccount {
    return deriveAccount(this.#mnemonic, TREASURY_ADDRESS_INDEX)
  }

  /**
   * The deposit address of partner `index` — where that partner pays what it owes.
   *
   * Index 0 is refused here and not only at the HTTP edge: a caller inside the process
   * must not be able to hand out the treasury address as a deposit address either.
   */
  depositAccount(index: number): HDAccount {
    if (!Number.isInteger(index) || index <= TREASURY_ADDRESS_INDEX) {
      throw new Error(
        `a deposit index is a whole number of 1 or more, got: ${String(index)}. Index ${TREASURY_ADDRESS_INDEX} is the treasury and is never used as a deposit address.`,
      )
    }
    return deriveAccount(this.#mnemonic, index)
  }
}

/**
 * Generates the seed and writes it, returning the mnemonic.
 *
 * Stored as the bare phrase and nothing else: what a reader sees when they open the file
 * is exactly what it is, and it can be pasted into a wallet to inspect the demo's money
 * by hand. `createdAt` and `network` metadata would only be true of the file, not of the
 * key, and this repo documents both in the README instead.
 */
async function generateSeedFile(file: string): Promise<string> {
  const mnemonic = generateMnemonic(english)

  // `wx` fails instead of overwriting: two processes racing on first start (or a rerun of
  // this function after a partial read) must never destroy a seed that already holds
  // funds. Losing this file means losing the treasury.
  await writeFile(file, `${mnemonic}\n`, { encoding: 'utf8', mode: SEED_FILE_MODE, flag: 'wx' })

  // `mode` above applies only when the file is created, and the process umask can still
  // narrow it. An explicit chmod is the only way to know what the permissions are
  // (v1 lesson, drift log "T-04").
  await chmod(file, SEED_FILE_MODE)

  return mnemonic
}

/**
 * The signer refuses to start without a writable keys directory, and says what to fix.
 *
 * The failure this catches is a real one: forget the bind mount and the seed is written
 * inside the container, so `docker compose down` throws away the treasury the tester just
 * funded from a faucet. That is also why a missing directory is not created here — the
 * only correct fix is on the host, and creating it silently hides the mistake.
 */
async function requireWritableDirectory(keysDir: string): Promise<void> {
  const advice = [
    `KEYS_DIR is ${keysDir}.`,
    'Inside docker compose this directory comes from the bind mount `./.keys/company:/keys`',
    'in docker-compose.yml — check that the line is there and that ./.keys/company exists on',
    'your machine. Running the signer directly: set KEYS_DIR to a directory you can write to.',
  ].join('\n  ')

  try {
    await access(keysDir, constants.W_OK | constants.X_OK)
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'does not exist' : 'is not writable by the signer'
    throw new Error(`the signer needs a keys directory to hold the company seed, and this one ${reason}.\n  ${advice}`, {
      cause: error,
    })
  }
}
