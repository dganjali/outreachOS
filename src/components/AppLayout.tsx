import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Target,
  Activity,
  User,
  Settings as SettingsIcon,
  Plus,
  LogOut,
  Menu,
  ChevronsUpDown,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Logo } from './Logo';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/missions', label: 'Missions', icon: Target },
  { to: '/analytics', label: 'Analytics', icon: Activity },
  { to: '/me', label: 'Me', icon: User },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

// App-wide keyboard shortcuts, surfaced in the `?` help overlay. Single-key
// nav (guarded against firing while typing). Builds on the existing `/`-to-focus
// search on the Missions page.
const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'n', label: 'New mission' },
  { keys: 'd', label: 'Go to Dashboard' },
  { keys: 'm', label: 'Go to Missions' },
  { keys: '/', label: 'Search missions (on Missions)' },
  { keys: '?', label: 'Show this help' },
];

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <ul className="flex flex-col gap-2">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">{s.label}</span>
              <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs text-foreground">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Global single-key shortcuts. No-op while the user is typing in a field or
// holding a modifier (so it never hijacks browser/OS chords or text entry).
function useGlobalShortcuts(onToggleHelp: () => void, onCloseHelp: () => void) {
  const navigate = useNavigate();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCloseHelp();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable);
      if (typing) return;
      switch (e.key) {
        case '?':
          e.preventDefault();
          onToggleHelp();
          break;
        case 'n':
          e.preventDefault();
          navigate('/missions/new');
          break;
        case 'd':
          navigate('/dashboard');
          break;
        case 'm':
          navigate('/missions');
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, onToggleHelp, onCloseHelp]);
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1 px-3">
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200',
              isActive
                ? 'bg-gradient-to-r from-sidebar-accent to-sidebar-accent/40 text-sidebar-accent-foreground shadow-[inset_0_1px_0_0_hsl(210_40%_98%/0.05)]'
                : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_0_hsl(153_45%_46%/0.7)]" />
              )}
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                )}
                strokeWidth={2}
              />
              <span>{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarBrand() {
  return (
    <div className="flex h-14 items-center px-5">
      <Logo size={22} to="/dashboard" variant="mono-light" />
    </div>
  );
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const { user, profile, signOut } = useAuth();
  useGlobalShortcuts(
    () => setHelpOpen((v) => !v),
    () => setHelpOpen(false)
  );
  const displayName = profile?.name || user?.email || 'User';
  const email = user?.email || '';
  const initial = displayName.trim().charAt(0).toUpperCase();

  return (
    <div className="app-canvas min-h-dvh text-foreground">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-sidebar-border bg-gradient-to-b from-sidebar to-background md:flex">
        <SidebarBrand />
        <div className="mt-2 flex-1 overflow-y-auto pb-4">
          <NavItems />
        </div>
      </aside>

      <div className="relative z-10 flex min-h-dvh flex-col md:pl-60">
        {/* Topbar */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border/70 bg-background/70 px-4 backdrop-blur-xl md:px-6">
          <div className="flex items-center gap-2">
            {/* Mobile nav trigger */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 border-sidebar-border bg-sidebar p-0">
                <SidebarBrand />
                <div className="mt-2">
                  <NavItems onNavigate={() => setMobileOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>
            <div className="md:hidden">
              <Logo size={20} to="/dashboard" variant="mono-light" withWordmark={false} />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button asChild size="sm" className="btn-glow gap-1.5 border-0 font-semibold text-primary-foreground">
              <Link to="/missions/new">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">New mission</span>
                <span className="sm:hidden">New</span>
              </Link>
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-9 gap-2 rounded-full border border-border/70 bg-secondary/40 pl-1 pr-2.5 text-sm font-medium text-foreground/90 transition-colors hover:border-border hover:bg-secondary hover:text-foreground data-[state=open]:border-border data-[state=open]:bg-secondary"
                >
                  <Avatar className="h-7 w-7 ring-1 ring-border/60">
                    <AvatarFallback className="bg-gradient-to-br from-primary/30 to-primary/5 text-xs font-semibold text-primary">
                      {initial}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden max-w-[10rem] truncate sm:inline">{displayName}</span>
                  <ChevronsUpDown className="hidden h-3.5 w-3.5 opacity-50 sm:inline" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
                  {email && <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/me">
                    <User className="mr-2 h-4 w-4" /> Me
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/settings">
                    <SettingsIcon className="mr-2 h-4 w-4" /> Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => signOut()}
                  className="text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </div>
        </main>
      </div>

      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
