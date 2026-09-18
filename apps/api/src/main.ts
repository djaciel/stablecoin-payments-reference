import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { readEnv } from '@payments/domain'
import { AppModule } from './app.module'

const DEFAULT_PORT = '3000'

/**
 * The only place that reads PORT. Everything else receives the number.
 */
function readPort(): number {
  const raw = readEnv('PORT', DEFAULT_PORT)
  const port = Number(raw)
  // Without this check a typo becomes NaN and Node quietly binds a random free port.
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive whole number, got: ${raw}`)
  }
  return port
}

async function main(): Promise<void> {
  // Read the environment before anything is built: an invalid PORT has to fail here, not
  // after Nest has wired the DI container and `DbModule` has already opened a pool.
  const port = readPort()

  // Nest's own logger, on purpose: it already prints the routes it mapped and the modules
  // it started, which is exactly what you want to read in `docker compose logs api`.
  const app = await NestFactory.create(AppModule)

  // PID 1 is a special case in Linux: a process with no handler of its own does NOT get
  // the default "die on SIGTERM" behaviour, so `docker compose stop` would wait ten
  // seconds and then kill the container. This asks Nest for its own signal handlers, and
  // it is also what makes a module's shutdown hooks run before the process leaves.
  app.enableShutdownHooks()

  // 0.0.0.0 so the container is reachable from the host, not only from inside it.
  await app.listen(port, '0.0.0.0')
  new Logger('main').log(`api listening on 0.0.0.0:${port} — health at GET /health`)
}

main().catch((error: unknown) => {
  new Logger('main').error('the api could not start', error)
  process.exit(1)
})
