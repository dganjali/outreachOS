import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ConfirmProvider } from './context/ConfirmContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ProtectedRoute } from './components/ProtectedRoute';
import { PublicOnlyRoute } from './components/PublicOnlyRoute';
import { OnboardingRoute } from './components/OnboardingRoute';
import { AppLayout } from './components/AppLayout';

// Route-level code splitting. Each page is its own chunk so the initial load no
// longer ships every page (notably the Three.js-heavy Landing scene) up front.
const Landing = lazy(() => import('./pages/Landing').then((m) => ({ default: m.Landing })));
const SignIn = lazy(() => import('./pages/SignIn').then((m) => ({ default: m.SignIn })));
const SignUp = lazy(() => import('./pages/SignUp').then((m) => ({ default: m.SignUp })));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword').then((m) => ({ default: m.ForgotPassword })));
const CheckEmail = lazy(() => import('./pages/CheckEmail').then((m) => ({ default: m.CheckEmail })));
const AuthAction = lazy(() => import('./pages/AuthAction').then((m) => ({ default: m.AuthAction })));
const Onboarding = lazy(() => import('./pages/Onboarding').then((m) => ({ default: m.Onboarding })));
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Missions = lazy(() => import('./pages/Missions').then((m) => ({ default: m.Missions })));
const MissionNew = lazy(() => import('./pages/MissionNew').then((m) => ({ default: m.MissionNew })));
const MissionPage = lazy(() => import('./pages/MissionPage').then((m) => ({ default: m.MissionPage })));
const MissionRun = lazy(() => import('./pages/MissionRun').then((m) => ({ default: m.MissionRun })));
const Inbox = lazy(() => import('./pages/Inbox').then((m) => ({ default: m.Inbox })));
const Me = lazy(() => import('./pages/Me').then((m) => ({ default: m.Me })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const Privacy = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Terms })));
// Internal QA-only scaffolding. Gated behind import.meta.env.DEV so the routes
// (and their chunks) never ship to production — `false && …` is statically
// dead in the prod build, letting Rollup tree-shake these imports out entirely.
const WizardPreview = lazy(() => import('./pages/_WizardPreview').then((m) => ({ default: m.WizardPreview })));
const FeedbackPreview = lazy(() => import('./pages/_FeedbackPreview').then((m) => ({ default: m.FeedbackPreview })));

function RouteFallback() {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      aria-busy="true"
    >
      <div
        style={{
          width: '1.5rem',
          height: '1.5rem',
          border: '2px solid hsl(var(--muted-foreground, 0 0% 60%) / 0.3)',
          borderTopColor: 'hsl(var(--primary, 217 91% 60%))',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const BASE_TITLE = 'OutreachOS';

// Per-route browser-tab title. Keeps the marketing title on the public landing
// page; everything else gets "Page · OutreachOS" so tabs/history are legible.
function titleForPath(pathname: string): string {
  if (pathname === '/') return `${BASE_TITLE} - Agentic cold outreach`;
  const exact: Record<string, string> = {
    '/sign-in': 'Sign in',
    '/sign-up': 'Sign up',
    '/forgot-password': 'Reset password',
    '/check-email': 'Check your email',
    '/auth/action': 'Account',
    '/onboarding': 'Get started',
    '/dashboard': 'Dashboard',
    '/missions': 'Missions',
    '/missions/new': 'New mission',
    '/inbox': 'Inbox',
    '/me': 'Me',
    '/settings': 'Settings',
    '/privacy': 'Privacy',
    '/terms': 'Terms',
  };
  let page = exact[pathname];
  if (!page) {
    if (/^\/missions\/[^/]+\/run\/?$/.test(pathname)) page = 'Running mission';
    else if (/^\/missions\/[^/]+\/?$/.test(pathname)) page = 'Mission';
  }
  return page ? `${page} · ${BASE_TITLE}` : BASE_TITLE;
}

function RouteTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = titleForPath(pathname);
  }, [pathname]);
  return null;
}

// Reset scroll to the top on every navigation. Without this, moving from a long
// scrolled page (e.g. a mission with many targets) to another keeps the old
// scroll offset, landing the user mid-page on the new screen.
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [pathname]);
  return null;
}

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <ConfirmProvider>
              <RouteTitle />
              <ScrollToTop />
              <Toaster theme="dark" position="bottom-right" richColors closeButton />
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route
                    path="/"
                    element={
                      <PublicOnlyRoute>
                        <Landing />
                      </PublicOnlyRoute>
                    }
                  />
                  <Route
                    path="/sign-in"
                    element={
                      <PublicOnlyRoute>
                        <SignIn />
                      </PublicOnlyRoute>
                    }
                  />
                  <Route
                    path="/sign-up"
                    element={
                      <PublicOnlyRoute>
                        <SignUp />
                      </PublicOnlyRoute>
                    }
                  />
                  <Route
                    path="/forgot-password"
                    element={
                      <PublicOnlyRoute>
                        <ForgotPassword />
                      </PublicOnlyRoute>
                    }
                  />
                  <Route path="/check-email" element={<CheckEmail />} />
                  {/* Firebase email action handler (verify email, password reset,
                      email recovery). Public + ungated - users may arrive here signed
                      out, on a different device. See AuthAction.tsx for why it exists. */}
                  <Route path="/auth/action" element={<AuthAction />} />
                  {import.meta.env.DEV && (
                    <>
                      <Route path="/wizard-preview" element={<WizardPreview />} />
                      <Route path="/feedback-preview" element={<FeedbackPreview />} />
                      <Route path="/mn-preview" element={<MissionNew />} />
                    </>
                  )}
                  <Route path="/privacy" element={<Privacy />} />
                  <Route path="/terms" element={<Terms />} />
                  <Route
                    path="/onboarding"
                    element={
                      <OnboardingRoute>
                        <Onboarding />
                      </OnboardingRoute>
                    }
                  />
                  <Route
                    path="/"
                    element={
                      <ProtectedRoute>
                        <AppLayout />
                      </ProtectedRoute>
                    }
                  >
                    <Route path="dashboard" element={<Dashboard />} />
                    <Route path="missions" element={<Missions />} />
                    <Route path="missions/new" element={<MissionNew />} />
                    <Route path="missions/:id" element={<MissionPage />} />
                    <Route path="missions/:id/run" element={<MissionRun />} />
                    <Route path="inbox" element={<Inbox />} />
                    <Route path="me" element={<Me />} />
                    <Route path="profile" element={<Navigate to="/me" replace />} />
                    <Route path="settings" element={<SettingsPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </ConfirmProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
