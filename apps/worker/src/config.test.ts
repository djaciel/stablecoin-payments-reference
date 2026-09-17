import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTemporalConfig } from './config'

// The worker reads these variables and nothing else, so what happens when one is missing
// or empty decides where a misconfigured container ends up pointing.
const VARIABLES = ['TEMPORAL_ADDRESS', 'TEMPORAL_PORT', 'TEMPORAL_NAMESPACE', 'TEMPORAL_TASK_QUEUE'] as const

function clearTemporalEnv(): void {
  for (const name of VARIABLES) {
    delete process.env[name]
  }
}

// Before, because a developer whose shell exports TEMPORAL_TASK_QUEUE would otherwise see
// this suite fail on their machine and nowhere else. After, so it leaks into no other one.
beforeEach(clearTemporalEnv)
afterEach(clearTemporalEnv)

describe('readTemporalConfig', () => {
  it('falls back to the host-machine view when nothing is set', () => {
    expect(readTemporalConfig()).toEqual({
      address: 'localhost:7233',
      namespace: 'default',
      taskQueue: 'payments',
    })
  })

  it('takes the environment over the defaults, which is what compose relies on', () => {
    process.env['TEMPORAL_ADDRESS'] = 'temporal:7233'
    process.env['TEMPORAL_NAMESPACE'] = 'payments-demo'
    process.env['TEMPORAL_TASK_QUEUE'] = 'payments-test'

    expect(readTemporalConfig()).toEqual({
      address: 'temporal:7233',
      namespace: 'payments-demo',
      taskQueue: 'payments-test',
    })
  })

  it('builds the host-machine address from TEMPORAL_PORT, which TEMPORAL_ADDRESS overrides', () => {
    process.env['TEMPORAL_PORT'] = '17233'
    expect(readTemporalConfig().address).toBe('localhost:17233')

    process.env['TEMPORAL_ADDRESS'] = 'temporal:7233'
    expect(readTemporalConfig().address).toBe('temporal:7233')
  })

  it('treats an empty variable as unset, not as an empty queue name', () => {
    process.env['TEMPORAL_TASK_QUEUE'] = ''

    expect(readTemporalConfig().taskQueue).toBe('payments')
  })
})
