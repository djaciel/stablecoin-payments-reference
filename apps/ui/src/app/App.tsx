import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { AdminHome } from '../admin/AdminHome'
import { PartnerHome } from '../partner/PartnerHome'

/**
 * The whole app: the shell every screen renders inside, and the two routes the demo has.
 *
 * The shell is here rather than in its own file because it is a header, a banner and a
 * slot — splitting it out would mean opening two files to see one page. When the admin
 * side grows its own sub-navigation, that is the moment it earns a file.
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
          <Route path="/admin" element={<AdminHome />} />
          <Route path="/partner" element={<PartnerHome />} />
          {/* No landing page: `/` and anything unknown go to the company's side, where the demo starts. */}
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'app-nav-link is-active' : 'app-nav-link'
}
