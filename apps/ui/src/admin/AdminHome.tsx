import { getTreasury } from '../api/client'
import { usePolling } from '../api/usePolling'
import { HealthCard } from '../app/HealthCard'

/**
 * The company's side of the demo. Today it proves the stack is alive and shows the one
 * address a human has to fund; the Start, Dashboard, Payables and Break-it screens are
 * added next to these cards.
 */
export function AdminHome() {
  const treasury = usePolling(getTreasury)

  return (
    <div className="cards">
      <HealthCard />

      <section className="card">
        <h2 className="card-title">Treasury address</h2>
        {treasury.error ? (
          <p className="card-value is-bad">unavailable — {treasury.error}</p>
        ) : (
          <p className="card-value is-address">{treasury.data ? treasury.data.address : 'reading…'}</p>
        )}
        <p className="card-note">
          Derived from the company seed by the signer. Fund it from a Base Sepolia faucet to run the demo.
        </p>
      </section>
    </div>
  )
}
