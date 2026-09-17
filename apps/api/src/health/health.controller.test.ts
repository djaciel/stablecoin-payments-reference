// This controller is the template every later module copies, and its answer is what
// compose, a load balancer and the README's curl read: 200 only after a real query, 503
// with that exact body when the database is gone. Both halves are pinned here.
import 'reflect-metadata'
import { Logger, ServiceUnavailableException } from '@nestjs/common'
import type { Pool } from '@payments/db'
import { describe, expect, it } from 'vitest'
import { HealthController } from './health.controller'

/** No Nest container and no database: the controller is a class, so it is built by hand. */
function controllerWith(query: () => Promise<unknown>): HealthController {
  return new HealthController({ query } as unknown as Pool)
}

describe('HealthController', () => {
  it('answers ok when the pool can run a query', async () => {
    const controller = controllerWith(() => Promise.resolve({ rows: [{ '?column?': 1 }] }))

    await expect(controller.check()).resolves.toEqual({ status: 'ok', database: 'up' })
  })

  it('answers 503 with the degraded body when the query fails', async () => {
    // The controller logs the failure through Nest's logger. Silenced so a passing test
    // run stays free of red stack traces that mean nothing.
    Logger.overrideLogger(false)
    const controller = controllerWith(() => Promise.reject(new Error('connection refused')))

    const thrown: unknown = await controller.check().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(ServiceUnavailableException)
    const failure = thrown as ServiceUnavailableException
    expect(failure.getStatus()).toBe(503)
    expect(failure.getResponse()).toEqual({ status: 'degraded', database: 'unreachable' })
  })
})
