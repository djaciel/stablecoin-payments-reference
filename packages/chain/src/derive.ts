import type { HDAccount } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

/**
 * One seed, many addresses. A BIP-39 mnemonic is a master key from which an unlimited
 * number of accounts are derived deterministically: the same mnemonic and the same index
 * always produce the same address, on any machine, forever. That is what lets this repo
 * hand every partner its own deposit address while keeping exactly one secret.
 *
 * The path is `m/44'/60'/0'/0/n` — the Ethereum default, the one MetaMask and every other
 * wallet shows when it lists "Account 1, Account 2, ...". Staying on it means the seed
 * generated here can be imported into a wallet and the addresses will match, which is
 * worth a lot when a demo needs to be inspected by hand.
 */

/**
 * Index 0 is the treasury, in both seeds (see the spec's key model). It is never handed
 * out as a deposit or payout address, so partner indexes start at 1.
 */
export const TREASURY_ADDRESS_INDEX = 0

/**
 * Derives the account at `index` from `mnemonic`.
 *
 * The returned `HDAccount` can sign; whoever holds one holds spending power over that
 * address. Only the process that owns the seed calls this — for the company seed that is
 * `apps/signer`, and nothing else.
 */
export function deriveAccount(mnemonic: string, index: number): HDAccount {
  // viem would happily derive from a fractional or negative index by coercing it into the
  // path, which turns a caller's bug into a silent, unrecoverable address.
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`a derivation index is a whole number from 0 up, got: ${String(index)}`)
  }
  return mnemonicToAccount(mnemonic, { addressIndex: index })
}
