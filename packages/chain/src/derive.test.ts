// Derivation is the one thing in this repo that must never change its answer: the
// treasury address is funded by hand from a faucet, and every partner's deposit address
// is printed on a screen and paid to. A silent change of path or index would send money
// to an address nobody controls any more.
//
// So it is pinned to a public vector rather than to itself. The mnemonic below is the
// well-known test mnemonic that Hardhat and Foundry (anvil) use for their default
// accounts, and the two addresses are the first two accounts those tools print on every
// start — published, reproducible outside this repo, and useless for anything else since
// everyone on earth knows the seed.
import { describe, expect, it } from 'vitest'
import { TREASURY_ADDRESS_INDEX, deriveAccount } from './derive'

// The values below are written out here on purpose, and not imported from anywhere: this
// file is the pin, and a pin that imports the number it pins pins nothing.

/** NEVER a real seed: this exact phrase is the published test vector. */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

/** `m/44'/60'/0'/0/0` and `m/44'/60'/0'/0/1` of the mnemonic above. */
const TEST_VECTOR_ADDRESSES = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
] as const

describe('deriveAccount', () => {
  it('derives index 0 of the test mnemonic to its published address', () => {
    expect(deriveAccount(TEST_MNEMONIC, 0).address).toBe(TEST_VECTOR_ADDRESSES[0])
  })

  it('derives index 1 of the test mnemonic to its published address', () => {
    expect(deriveAccount(TEST_MNEMONIC, 1).address).toBe(TEST_VECTOR_ADDRESSES[1])
  })

  it('gives the treasury index the first address', () => {
    // The constant is what the signer and its callers agree on; this is the line that
    // fails if anyone ever "tidies" it to something other than 0.
    expect(deriveAccount(TEST_MNEMONIC, TREASURY_ADDRESS_INDEX).address).toBe(TEST_VECTOR_ADDRESSES[0])
  })

  it('refuses an index that is not a whole number from 0 up', () => {
    expect(() => deriveAccount(TEST_MNEMONIC, -1)).toThrow(/whole number from 0 up/)
    expect(() => deriveAccount(TEST_MNEMONIC, 1.5)).toThrow(/whole number from 0 up/)
    expect(() => deriveAccount(TEST_MNEMONIC, Number.NaN)).toThrow(/whole number from 0 up/)
  })
})
