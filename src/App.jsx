import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { ToastProvider } from './components/Toast.jsx'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import Layout from './components/Layout.jsx'
import LoginPage from './pages/LoginPage.jsx'
import Dashboard from './pages/Dashboard.jsx'
import InventoryCheck from './pages/InventoryCheck.jsx'
import TrackingPage from './pages/TrackingPage.jsx'
import NotesPage from './pages/NotesPage.jsx'
import StockManagement from './pages/StockManagement.jsx'
import AutoDeduct from './pages/AutoDeduct.jsx'
import AutoDeductHistory from './pages/AutoDeductHistory.jsx'
import MetricsAnalytics from './pages/MetricsAnalytics.jsx'
import NewProductTracker from './pages/NewProductTracker.jsx'
import AutoGenerate from './pages/AutoGenerate.jsx'
import AdminUsers from './pages/AdminUsers.jsx'
import TimeClockPage from './pages/TimeClockPage.jsx'
import AdminTimeReport from './pages/AdminTimeReport.jsx'
import ReturnsReceiving from './pages/ReturnsReceiving.jsx'

// Full-page spinner shown while verifying token on first load
function SplashLoader() {
  return (
    <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center shadow-2xl">
          <span className="text-white font-bold text-2xl">F</span>
        </div>
        <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
    </div>
  )
}

// Require login — redirect to /login if not authenticated.
// DEV-ONLY: ?mock=1 skips auth for local UI preview. import.meta.env.DEV is false in
// production builds, so this branch is stripped out — it can never bypass auth in prod.
function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('mock') === '1') return children
  if (loading) return <SplashLoader />
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />
  return children
}

// Admin-only gate — regular users are redirected to /tracking
function RequireAdmin({ children }) {
  const { user } = useAuth()
  const location = useLocation()
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('mock') === '1') return children
  if (user?.role !== 'admin') return <Navigate to="/tracking" replace />
  return children
}

// Redirect already-logged-in users away from /login
function GuestOnly({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <SplashLoader />
  if (user) return <Navigate to={user.role === 'admin' ? '/' : '/tracking'} replace />
  return children
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />

      {/* Protected */}
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<RequireAdmin><Dashboard /></RequireAdmin>} />
        <Route path="inventory" element={<RequireAdmin><InventoryCheck /></RequireAdmin>} />
        <Route path="tracking" element={<TrackingPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="stock" element={<RequireAdmin><StockManagement /></RequireAdmin>} />
        <Route path="auto-deduct" element={<RequireAdmin><AutoDeduct /></RequireAdmin>} />
        <Route path="auto-deduct/history" element={<RequireAdmin><AutoDeductHistory /></RequireAdmin>} />
        <Route path="returns" element={<ReturnsReceiving />} />
        <Route path="analytics" element={<RequireAdmin><MetricsAnalytics /></RequireAdmin>} />
        <Route path="new-products" element={<RequireAdmin><NewProductTracker /></RequireAdmin>} />
        <Route path="auto-generate" element={<RequireAdmin><AutoGenerate /></RequireAdmin>} />
        <Route path="users" element={<RequireAdmin><AdminUsers /></RequireAdmin>} />
        <Route path="timeclock" element={<TimeClockPage />} />
        <Route path="time-report" element={<RequireAdmin><AdminTimeReport /></RequireAdmin>} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  )
}
