import { HealthCard } from '../app/HealthCard'

/**
 * What a partner sees. Today it is the shell and the same health card; the partner
 * selector and everything behind it arrive with the partner phase.
 */
export function PartnerHome() {
  return (
    <div className="cards">
      <HealthCard />

      <section className="card">
        <h2 className="card-title">Partner</h2>
        <p className="card-value">no partner selected</p>
        <p className="card-note">
          The partner selector arrives later, and with it the receivables, the deposit address and the button that
          pays one.
        </p>
      </section>
    </div>
  )
}
