import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Dashboard from './pages/Dashboard.jsx'
import InventoryCheck from './pages/InventoryCheck.jsx'
import TrackingPage from './pages/TrackingPage.jsx'
import NotesPage from './pages/NotesPage.jsx'
import StockManagement from './pages/StockManagement.jsx'
import AutoDeduct from './pages/AutoDeduct.jsx'
import AutoGenerate from './pages/AutoGenerate.jsx'
import { ToastProvider } from './components/Toast.jsx'

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="inventory" element={<InventoryCheck />} />
            <Route path="tracking" element={<TrackingPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="stock" element={<StockManagement />} />
            <Route path="auto-deduct" element={<AutoDeduct />} />
            <Route path="auto-generate" element={<AutoGenerate />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  )
}
