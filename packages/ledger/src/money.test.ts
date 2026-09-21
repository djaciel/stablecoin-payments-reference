import { describe, expect, it } from 'vitest'
import { toMinorFromDecimal } from './money'

// Where the article's money enters the system: an amount a person typed into a form.
describe('toMinorFromDecimal', () => {
  it('reads a typed amount into exact minor units', () => {
    expect(toMinorFromDecimal('0.50')).toBe(500_000n)
  })

  it('keeps every one of the six decimals USDC has', () => {
    expect(toMinorFromDecimal('1.234567')).toBe(1_234_567n)
  })

  it('refuses a seventh decimal instead of rounding it away', () => {
    expect(() => toMinorFromDecimal('1.2345678')).toThrow(RangeError)
  })

  it('refuses what is not a number', () => {
    expect(() => toMinorFromDecimal('abc')).toThrow(RangeError)
  })
})
