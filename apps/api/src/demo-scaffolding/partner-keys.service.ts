/**
 * Demo scaffolding: the keys of wallets the company does NOT control.
 *
 * In a real system the partners hold their own wallets and the company never sees a key of
 * theirs. This demo has no second company to play that part, so it keeps a second seed and
 * signs for them — which is exactly why this seed lives here, in the api, and never in the
 * signer: the signer's one job is the company seed, and a service holding both would erase
 * the boundary the architecture exists to teach.
 */

import { constants } from 'node:fs'
import { access, chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import { deriveAccount } from '@payments/chain'
import type { HDAccount } from 'viem'
import { english, generateMnemonic } from 'viem/accounts'

/** The file inside the partner keys directory. One seed, one file, one line. */
const SEED_FILE = 'partner.seed'

/** Owner read/write only. Nobody else on the machine, not even the group. */
const SEED_FILE_MODE = 0o600

/**
 * Index 0 of the partner seed: the single wallet every partner pays from. The company seed
 * calls the same index the treasury (`TREASURY_ADDRESS_INDEX`), so it gets its own name
 * here. One shared sender on purpose — it is what makes "you know who paid by where the
 * money came in, never by who sent it" visible in the demo.
 */
const PARTNER_WALLET_INDEX = 0

/**
 * The partner seed, and the only object in this repo that holds it.
 *
 * Deliberately a near-copy of `apps/signer/src/keys/keys.service.ts`, not an import of it:
 * the ~40 lines of file mechanics below are cheaper than a shared seed service that would
 * put both seeds behind one door. Do not "fix" this into a common module.
 */
export class PartnerKeysService {
  private static readonly logger = new Logger(PartnerKeysService.name)

  /**
   * `#mnemonic`, not `private mnemonic`: TypeScript's `private` is a compile-time promise,
   * so the phrase would still show up in `JSON.stringify(service)` and in any error
   * reporter that walks an object's properties. A JavaScript private field does not.
   */
  readonly #mnemonic: string

  private constructor(mnemonic: string) {
    this.#mnemonic = mnemonic
  }

  /**
   * Reads the seed from `keysDir`, generating it on first start.
   *
   * Called from the module's provider factory, so a missing or unusable directory stops the
   * api before it listens instead of failing later, one endpoint at a time.
   */
  static async load(keysDir: string): Promise<PartnerKeysService> {
    await requireWritableDirectory(keysDir)

    const file = join(keysDir, SEED_FILE)
    const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined
      }
      throw new Error(`the seed file ${file} exists but could not be read: ${error.message}`, { cause: error })
    })

    const mnemonic = existing === undefined ? await generateSeedFile(file) : existing.trim()
    const service = new PartnerKeysService(mnemonic)

    // Deriving now turns "the file is unreadable garbage" into a startup failure instead of
    // a 500 on the first request.
    const wallet = service.partnerWallet()

    PartnerKeysService.logger.log(`partner wallet address: ${wallet.address}`)
    PartnerKeysService.logger.log(`the partner seed is at ${file}, generated on this machine and gitignored`)
    PartnerKeysService.logger.warn('testnet only: this seed is generated for a demo on Base Sepolia')
    PartnerKeysService.logger.warn(
      'demo scaffolding: these keys stand in for wallets the company does not control, and exist only so one machine can play both sides',
    )

    return service
  }

  /** The shared sender: every partner pays the company from this one address. */
  partnerWallet(): HDAccount {
    return deriveAccount(this.#mnemonic, PARTNER_WALLET_INDEX)
  }

  /**
   * The payout address of partner `index` — where the company pays what it owes them.
   *
   * Index 0 is refused here and not only at the HTTP edge: nothing inside the process
   * should be able to hand out the shared wallet as one partner's payout address.
   */
  payoutAccount(index: number): HDAccount {
    if (!Number.isInteger(index) || index <= PARTNER_WALLET_INDEX) {
      throw new Error(
        `a payout index is a whole number of 1 or more, got: ${String(index)}. Index ${PARTNER_WALLET_INDEX} is the shared partner wallet and is never one partner's payout address.`,
      )
    }
    return deriveAccount(this.#mnemonic, index)
  }
}

/**
 * Generates the seed and writes it, returning the mnemonic.
 *
 * Stored as the bare phrase and nothing else, so it can be pasted into a wallet to inspect
 * the demo's money by hand.
 */
async function generateSeedFile(file: string): Promise<string> {
  const mnemonic = generateMnemonic(english)

  // `wx` fails instead of overwriting: two processes racing on first start must never
  // destroy a seed that already holds funds. The partner wallet is funded from the
  // treasury, so losing this file means funding it again.
  await writeFile(file, `${mnemonic}\n`, { encoding: 'utf8', mode: SEED_FILE_MODE, flag: 'wx' })

  // `mode` above applies only when the file is created, and the process umask can still
  // narrow it. An explicit chmod is the only way to know what the permissions are.
  await chmod(file, SEED_FILE_MODE)

  return mnemonic
}

/**
 * The api refuses to start without a writable partner keys directory, and says what to fix.
 *
 * A missing directory is not created here: forget the bind mount and the seed is written
 * inside the container, so `docker compose down` throws away the partner wallet the demo
 * just funded. The only correct fix is on the host.
 */
async function requireWritableDirectory(keysDir: string): Promise<void> {
  const problem = await directoryProblem(keysDir)
  if (problem === undefined) {
    return
  }

  throw new Error(
    [
      `the api needs a keys directory to hold the partner seed, and this one ${problem}.`,
      `  PARTNER_KEYS_DIR is ${keysDir}.`,
      '  Inside docker compose this directory comes from the bind mount `./.keys/partner:/partner-keys`',
      '  in docker-compose.yml — check that the line is there and that ./.keys/partner exists on',
      '  your machine. Running the api directly: set PARTNER_KEYS_DIR to a directory you can write to.',
    ].join('\n'),
  )
}

/** `undefined` when the directory is usable; otherwise the half-sentence the error prints. */
async function directoryProblem(keysDir: string): Promise<string | undefined> {
  const stats = await stat(keysDir).catch(() => undefined)
  if (stats === undefined) {
    return 'does not exist'
  }
  // A file where the directory should be fails at the first write with a bare ENOTDIR,
  // which says nothing about the bind mount that is actually wrong.
  if (!stats.isDirectory()) {
    return 'is a file, not a directory'
  }
  return access(keysDir, constants.W_OK | constants.X_OK).then(
    () => undefined,
    () => 'is not writable by the api',
  )
}
