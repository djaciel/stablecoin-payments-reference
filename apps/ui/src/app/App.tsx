import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { PartnersScreen } from '../admin/PartnersScreen'
import { StartScreen } from '../admin/StartScreen'
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
          </Route>
          <Route path="/partner" element={<PartnerHome />} />
          {/* No landing page: `/` and anything unknown go to the company's side, where the demo starts. */}
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  )
}

/** The company's screens, with their own row of tabs above whichever one is open. */
function AdminScreens() {
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
      </nav>
      <Outlet />
    </>
  )
}

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'app-nav-link is-active' : 'app-nav-link'
}
