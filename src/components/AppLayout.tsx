import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Logo } from './Logo';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/missions', label: 'Missions' },
  { to: '/inbox', label: 'Inbox' },
  { to: '/profile', label: 'Profile' },
  { to: '/settings', label: 'Settings' },
];

export function AppLayout() {
  const [search, setSearch] = useState('');
  const [userOpen, setUserOpen] = useState(false);
  const { user, profile, signOut } = useAuth();
  const location = useLocation();

  return (
    <div className="app-root">
      <aside className="app-sidebar">
        <div className="app-sidebar-brand">
          <Logo size={24} to="/dashboard" />
        </div>
        <nav>
          {NAV.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={location.pathname === to ? 'active' : ''}
            >
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <input
            type="search"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
          <div className="app-user-menu">
            <button
              type="button"
              onClick={() => setUserOpen((o) => !o)}
              aria-expanded={userOpen}
              aria-haspopup="true"
            >
              {profile?.name || user?.email || 'User'}
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
                  <Link to="/profile" onClick={() => setUserOpen(false)}>
                    Profile
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
