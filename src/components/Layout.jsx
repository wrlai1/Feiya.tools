import React, { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import Header from './Header.jsx'
import CommandPalette from './CommandPalette.jsx'
import { sectionThemeForPath } from '../utils/sectionTheme.js'

function HashScroller() {
  const location = useLocation()

  useEffect(() => {
    if (!location.hash) return undefined

    let id
    try {
      id = decodeURIComponent(location.hash.slice(1))
    } catch {
      return undefined
    }

    let frame
    let attempts = 0
    const scrollToTarget = () => {
      const target = document.getElementById(id)
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      attempts += 1
      if (attempts < 8) frame = requestAnimationFrame(scrollToTarget)
    }
    frame = requestAnimationFrame(scrollToTarget)

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [location.hash, location.pathname])

  return null
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const location = useLocation()
  const sectionTheme = sectionThemeForPath(location.pathname)

  return (
    <div className={`flex h-screen overflow-hidden transition-colors duration-300 ${sectionTheme.page}`}>
      {/* Sidebar */}
      <Sidebar
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          onSidebarToggle={() => setSidebarCollapsed((value) => !value)}
          sidebarCollapsed={sidebarCollapsed}
          sectionTheme={sectionTheme}
        />

        <main className={`flex-1 overflow-y-auto px-4 py-5 transition-colors duration-300 sm:px-6 lg:px-8 lg:py-7 ${sectionTheme.page}`}>
          <HashScroller />
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}
