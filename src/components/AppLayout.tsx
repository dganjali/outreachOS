import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Target,
  Inbox as InboxIcon,
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
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
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
  { to: '/inbox', label: 'Inbox', icon: InboxIcon },
  { to: '/me', label: 'Me', icon: User },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

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
              'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150',
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
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
  const { user, profile, signOut } = useAuth();
  const displayName = profile?.name || user?.email || 'User';
  const email = user?.email || '';
  const initial = displayName.trim().charAt(0).toUpperCase();

  return (
    <div className="app-canvas min-h-dvh text-foreground">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <SidebarBrand />
        <div className="mt-2 flex-1 overflow-y-auto pb-4">
          <NavItems />
        </div>
      </aside>

      <div className="relative z-10 flex min-h-dvh flex-col md:pl-60">
        {/* Topbar */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-background px-4 md:px-6">
          <div className="flex items-center gap-2">
            {/* Mobile nav trigger */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 border-sidebar-border bg-sidebar p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
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
                    <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
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
    </div>
  );
}
