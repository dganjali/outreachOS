import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Logo } from './Logo';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/missions', label: 'Missions' },
  { to: '/inbox', label: 'Inbox' },
  { to: '/me', label: 'Me' },
  { to: '/settings', label: 'Settings' },
];

export function AppLayout() {
  const [userOpen, setUserOpen] = useState(false);
  const { user, profile, signOut } = useAuth();
  const displayName = profile?.name || user?.email || 'User';
  const initial = displayName.trim().charAt(0).toUpperCase();

  return (
    <div className="app-root">
      <aside className="app-sidebar">
        <div className="app-sidebar-brand">
          <Logo size={24} to="/dashboard" />
        </div>
        <nav>
          {NAV.map(({ to, label }) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <Link to="/missions/new" className="topbar-new">
            <span aria-hidden>+</span> New mission
          </Link>

          <div className="app-user-menu">
            <button
              type="button"
              className="app-user-trigger"
              onClick={() => setUserOpen((o) => !o)}
              aria-expanded={userOpen}
              aria-haspopup="true"
            >
              <span className="app-user-avatar" aria-hidden>{initial}</span>
              <span className="app-user-name">{displayName}</span>
            </button>
            {userOpen && (
              <>
                <div
                  className="app-overlay"
                  role="presentation"
                  onClick={() => setUserOpen(false)}
                  aria-hidden
                />
                <div role="menu" className="app-user-dropdown">
                  <Link to="/me" onClick={() => setUserOpen(false)}>
                    Me
                  </Link>
                  <Link to="/settings" onClick={() => setUserOpen(false)}>
                    Settings
                  </Link>
                  <button type="button" onClick={() => signOut()}>
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
