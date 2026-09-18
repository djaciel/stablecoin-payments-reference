import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

const DEFAULT_PORT = 3001

/**
 * The signing service: the only process in this repo that touches the company seed.
 *
 * It is not published to your machine by compose — no `ports:` — so the only things that
 * can reach it are the other containers. Whatever it gains in convenience, an address
 * endpoint that anyone on the network can call is a key holder that anyone on the network
 * can call, and this service is the one component where that matters.
 */

/** The only place that reads PORT. Compose sets it to 3001; the api owns 3000. */
function readPort(): number {
  const raw = process.env['PORT']
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT
  }
  const port = Number(raw)
  // Without this check a typo becomes NaN and Node quietly binds a random free port.
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive whole number, got: ${raw}`)
  }
  return port
}

async function main(): Promise<void> {
  const port = readPort()

  // The seed is loaded while this resolves (KeysModule's factory). A missing or
  // unwritable keys directory throws here, before anything listens.
  //
  // `abortOnError: false` so that error reaches the catch at the bottom of this file.
  // Nest prints it once already, wrapped in twenty lines of its own injector stack, and
  // would then abort the process itself. This way the LAST line of `docker compose logs
  // signer` is the sentence that says which directory is missing — which is the line a
  // reader actually sees — at the cost of the message appearing twice.
  const app = await NestFactory.create(AppModule, { abortOnError: false })

  // PID 1 gets no default SIGTERM behaviour in Linux, so without this `docker compose
  // stop signer` waits ten seconds and then kills the container. Same reasoning as the
  // api; the signer holds no pool to close, but it will hold more than that later.
  app.enableShutdownHooks()

  await app.listen(port, '0.0.0.0')
  new Logger('main').log(`signer listening on 0.0.0.0:${port} — compose network only, no published port`)
}

main().catch((error: unknown) => {
  // The message matters here: this is where "you forgot the bind mount" is read.
  new Logger('main').error(`the signer could not start: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
