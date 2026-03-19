import React, { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import {
  Package,
  Hash,
  AlertTriangle,
  MapPin,
  ArrowRight,
  Truck,
  MessageSquare,
  Clock,
} from 'lucide-react'
import KPICard from '../components/KPICard.jsx'
import { useLocalStorage } from '../hooks/useLocalStorage.js'
import { relativeTime, getGreeting } from '../utils/dateUtils.js'

const SAMPLE_CHART_DATA = [
  { location: 'Warehouse A', count: 342 },
  { location: 'Warehouse B', count: 218 },
  { location: 'Section C', count: 156 },
  { location: 'Storage D', count: 89 },
  { location: 'Floor E', count: 67 },
  { location: 'Zone F', count: 45 },
]

const SAMPLE_ACTIVITY = [
  { id: 1, text: 'Inventory file uploaded', time: new Date(Date.now() - 2 * 60000).toISOString(), type: 'upload' },
  { id: 2, text: 'Tracking CSV parsed — 48 entries', time: new Date(Date.now() - 15 * 60000).toISOString(), type: 'tracking' },
  { id: 3, text: 'Note added by Alice: "Reorder SKU-1023"', time: new Date(Date.now() - 42 * 60000).toISOString(), type: 'note' },
  { id: 4, text: 'Inventory search: "BLK-001"', time: new Date(Date.now() - 2 * 3600000).toISOString(), type: 'search' },
  { id: 5, text: 'CSV exported — 120 rows', time: new Date(Date.now() - 5 * 3600000).toISOString(), type: 'export' },
]

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2">
        <p className="text-xs font-semibold text-slate-700">{label}</p>
        <p className="text-sm text-blue-600 font-bold mt-0.5">
          {payload[0].value} items
        </p>
      </div>
    )
  }
  return null
}

export default function Dashboard() {
  const [inventoryData] = useLocalStorage('feiya_inventory', [])
  const [activityLog] = useLocalStorage('feiya_activity', SAMPLE_ACTIVITY)
  const [notes] = useLocalStorage('feiya_notes', [])

  const kpis = useMemo(() => {
    if (!inventoryData || inventoryData.length === 0) {
      return {
        totalSKUs: 0,
        totalItems: 0,
        lowStock: 0,
        locations: 0,
      }
    }

    const uniqueSKUs = new Set(inventoryData.map((r) => r.style)).size
    const totalItems = inventoryData.reduce((s, r) => s + (r.quantity || 0), 0)
    const lowStock = inventoryData.filter((r) => r.quantity < 10 && r.quantity >= 0).length
    const locations = new Set(inventoryData.map((r) => r.location).filter(Boolean)).size

    return { totalSKUs: uniqueSKUs, totalItems, lowStock, locations }
  }, [inventoryData])

  const chartData = useMemo(() => {
    if (!inventoryData || inventoryData.length === 0) return SAMPLE_CHART_DATA

    const byLocation = {}
    inventoryData.forEach((r) => {
      if (r.location) {
        byLocation[r.location] = (byLocation[r.location] || 0) + (r.quantity || 0)
      }
    })

    return Object.entries(byLocation)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([location, count]) => ({ location, count }))
  }, [inventoryData])

  const recentActivity = useMemo(() => {
    return [...activityLog].slice(-5).reverse()
  }, [activityLog])

  const activityTypeIcon = (type) => {
    switch (type) {
      case 'upload': return <Package className="w-4 h-4 text-blue-500" />
      case 'tracking': return <Truck className="w-4 h-4 text-teal-500" />
      case 'note': return <MessageSquare className="w-4 h-4 text-purple-500" />
      case 'search': return <Hash className="w-4 h-4 text-orange-500" />
      default: return <Clock className="w-4 h-4 text-slate-400" />
    }
  }

  const isDemo = !inventoryData || inventoryData.length === 0

  return (
    <div className="space-y-6 max-w-7xl">
      {/* Greeting */}
      <div>
        <h2 className="text-2xl font-bold text-slate-800">
          {getGreeting()}, Feiya Team 👋
        </h2>
        <p className="text-slate-500 text-sm mt-1">
          {isDemo
            ? "Welcome! Upload your inventory file to get started."
            : `You have ${kpis.lowStock} low stock alerts to review.`}
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Total SKUs"
          value={kpis.totalSKUs}
          subtitle={isDemo ? 'Upload inventory to populate' : 'Unique style numbers'}
          icon={Hash}
          color="blue"
        />
        <KPICard
          title="Total Items"
          value={kpis.totalItems}
          subtitle={isDemo ? 'Upload inventory to populate' : 'Across all locations'}
          icon={Package}
          color="teal"
        />
        <KPICard
          title="Low Stock Alerts"
          value={kpis.lowStock}
          subtitle="Items with quantity < 10"
          icon={AlertTriangle}
          color={kpis.lowStock > 0 ? 'orange' : 'green'}
        />
        <KPICard
          title="Active Locations"
          value={kpis.locations}
          subtitle="Warehouse locations"
          icon={MapPin}
          color="purple"
        />
      </div>

      {/* Chart + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Bar Chart */}
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-slate-800">Inventory by Location</h3>
              {isDemo && (
                <p className="text-xs text-slate-400 mt-0.5">Showing sample data</p>
              )}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis
                dataKey="location"
                tick={{ fontSize: 11, fill: '#94a3b8' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#94a3b8' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f1f5f9' }} />
              <Bar dataKey="count" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={48} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Recent Activity */}
        <div className="card p-5">
          <h3 className="font-semibold text-slate-800 mb-4">Recent Activity</h3>
          <div className="space-y-3">
            {recentActivity.length === 0 ? (
              <p className="text-sm text-slate-400 py-4 text-center">No activity yet</p>
            ) : (
              recentActivity.map((item, idx) => (
                <div key={item.id || idx} className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    {activityTypeIcon(item.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-700 leading-snug">{item.text}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {relativeTime(item.time)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="card p-5">
        <h3 className="font-semibold text-slate-800 mb-4">Quick Actions</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Link
            to="/inventory"
            className="flex items-center gap-3 p-4 rounded-xl bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors group"
          >
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-sm">
              <Package className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-blue-800">Check Inventory</p>
              <p className="text-xs text-blue-500">Upload & search stock</p>
            </div>
            <ArrowRight className="w-4 h-4 text-blue-400 group-hover:translate-x-1 transition-transform" />
          </Link>

          <Link
            to="/tracking"
            className="flex items-center gap-3 p-4 rounded-xl bg-teal-50 hover:bg-teal-100 border border-teal-200 transition-colors group"
          >
            <div className="w-10 h-10 rounded-xl bg-teal-600 flex items-center justify-center shadow-sm">
              <Truck className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-teal-800">Search Tracking</p>
              <p className="text-xs text-teal-500">Look up shipments</p>
            </div>
            <ArrowRight className="w-4 h-4 text-teal-400 group-hover:translate-x-1 transition-transform" />
          </Link>

          <Link
            to="/notes"
            className="flex items-center gap-3 p-4 rounded-xl bg-purple-50 hover:bg-purple-100 border border-purple-200 transition-colors group"
          >
            <div className="w-10 h-10 rounded-xl bg-purple-600 flex items-center justify-center shadow-sm">
              <MessageSquare className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-purple-800">Add Note</p>
              <p className="text-xs text-purple-500">Low inventory alerts</p>
            </div>
            <ArrowRight className="w-4 h-4 text-purple-400 group-hover:translate-x-1 transition-transform" />
          </Link>
        </div>
      </div>
    </div>
  )
}
