import { useEffect, useState } from 'react'
import { Link, NavLink, Navigate, Outlet, Route, Routes, useMatch } from 'react-router-dom'
import type { Experiments } from '@payments/domain'
import { BLACKHOLE_WHERE, BreakItScreen, type ExperimentsContext } from '../admin/BreakItScreen'
import { PartnersScreen } from '../admin/PartnersScreen'
import { PayablesScreen } from '../admin/PayablesScreen'
import { StartScreen } from '../admin/StartScreen'
import { TransfersScreen } from '../admin/TransfersScreen'
import { getExperiments } from '../api/client'
import { usePolling } from '../api/usePolling'
import { PartnerHome } from '../partner/PartnerHome'

/**
 * The whole app: the shell every screen renders inside, and the routes the demo has.
 *
 * Both navigations live here, including the admin one, so the tree of screens is readable
 * in one file instead of two. Tabs rather than a side list: the admin side grows to several
 * screens and a row of tabs holds them without taking width from a table of addresses.
 */
export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">Stablecoin Payments Reference</span>
        <nav className="app-nav">
          <NavLink to="/admin" className={navClass}>
            Admin
          </NavLink>
          <NavLink to="/partner" className={navClass}>
            Partner
          </NavLink>
        </nav>
      </header>

      <p className="app-banner">Testnet demo. Keys are generated locally and hold test funds only.</p>

      <main className="app-main">
        <Routes>
          <Route path="/admin" element={<AdminScreens />}>
            <Route index element={<StartScreen />} />
            <Route path="partners" element={<PartnersScreen />} />
            <Route path="payables" element={<PayablesScreen />} />
            <Route path="transfers" element={<TransfersScreen />} />
            {/* A payment's story has its own address, so an invoice row can link straight to it. */}
            <Route path="transfers/:reference" element={<TransfersScreen />} />
            <Route path="break-it" element={<BreakItScreen />} />
          </Route>
          <Route path="/partner" element={<PartnerHome />} />
          {/* No landing page: `/` and anything unknown go to the company's side, where the demo starts. */}
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  )
}

/**
 * The company's screens, with their own row of tabs above whichever one is open, and the one poll
 * of the Break it flags: the banner on the other screens and the Break it cards both read it.
 *
 * Four tabs are the demo's flow, in order. Break it is not a fifth step, so it sits at the far end
 * of the same bar, behind a rule: a switch for the demo, next to the screens it breaks.
 */
function AdminScreens() {
  const polled = usePolling(getExperiments)
  // The poll and a switch on Break it both write here, so a change shows at once, banner included.
  const [experiments, showExperiments] = useState<Experiments | undefined>(undefined)
  // On Break it the banner would repeat the cards' own badges and link to the page already open.
  const onBreakIt = useMatch('/admin/break-it') !== null

  useEffect(() => {
    if (polled.data !== undefined) {
      showExperiments(polled.data)
    }
  }, [polled.data])

  const context: ExperimentsContext = { experiments, show: showExperiments }
  const armed = experiments === undefined ? [] : armedFlags(experiments)

  return (
    <>
      <nav className="sub-nav">
        {/* `end` so Start is not highlighted while a screen underneath /admin is open. */}
        <NavLink to="/admin" end className={navClass}>
          Start
        </NavLink>
        <NavLink to="/admin/partners" className={navClass}>
          Partners
        </NavLink>
        <NavLink to="/admin/payables" className={navClass}>
          Payables
        </NavLink>
        <NavLink to="/admin/transfers" className={navClass}>
          Transfers
        </NavLink>
        {/* Red while a switch is armed, so the demo control says so from wherever you are. */}
        <span className={armed.length > 0 ? 'sub-nav-lab is-armed' : 'sub-nav-lab'}>
          <NavLink to="/admin/break-it" className={navClass}>
            Break it
          </NavLink>
        </span>
      </nav>
      {polled.error !== undefined && (
        <p className="card-value is-bad flags-unavailable">
          The Break it switches are unavailable — {polled.error}.
          {experiments === undefined ? '' : " The banner and Break it show the api's last answer."}
        </p>
      )}
      {armed.length > 0 && !onBreakIt && (
        <p className="armed-banner">
          <Link to="/admin/break-it">Break it</Link> is armed: {armed.join('; ')}.
        </p>
      )}
      <Outlet context={context} />
    </>
  )
}

/** What the banner says for each flag that is armed. */
function armedFlags({ revertNextPayment, blackholeRpc }: Experiments): string[] {
  return [
    ...(revertNextPayment ? ['the next payment will revert'] : []),
    ...(blackholeRpc.enabled ? [`the node does not answer ${BLACKHOLE_WHERE[blackholeRpc.step]} (${blackholeRpc.step}), for every payment in flight`] : []),
  ]
}

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'app-nav-link is-active' : 'app-nav-link'
}
