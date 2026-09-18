import { getHealth } from '../api/client'
import { usePolling } from '../api/usePolling'

/**
 * Is the api alive, and can it reach its database? Both screens show it, because on both
 * of them every other number on the page depends on the answer.
 */
export function HealthCard() {
  const health = usePolling(getHealth)

  return (
    <section className="card">
      <h2 className="card-title">API</h2>
      {health.error ? (
        <p className="card-value is-bad">unreachable — {health.error}</p>
      ) : (
        <p className="card-value">
          {health.data ? `${health.data.status} · database ${health.data.database}` : 'checking…'}
        </p>
      )}
      <p className="card-note">Refreshed every few seconds. Stop the api and watch this change.</p>
    </section>
  )
}
