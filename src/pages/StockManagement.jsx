import React from 'react'
import { Boxes, Check, Bell } from 'lucide-react'
import { useToast } from '../hooks/useToast.js'

const FEATURES = [
  'Real-time stock level synchronization across all warehouse locations',
  'Automatic reorder point alerts and purchase order generation',
  'Batch stock adjustment with full audit trail',
  'Multi-location transfer management with approval workflows',
  'Integration with inventory check for live stock visibility',
  'Historical stock trend reports and analytics',
]

export default function StockManagement() {
  const toast = useToast()

  return (
    <div className="max-w-2xl mx-auto">
      <div className="card p-12 text-center">
        {/* Icon */}
        <div className="w-20 h-20 bg-blue-100 rounded-3xl flex items-center justify-center mx-auto mb-6">
          <Boxes className="w-10 h-10 text-blue-600" />
        </div>

        {/* Title */}
        <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full mb-4">
          Coming Soon
        </div>
        <h2 className="text-2xl font-bold text-slate-800 mb-3">Stock Management</h2>
        <p className="text-slate-500 leading-relaxed mb-2">
          A comprehensive stock management module that gives you complete visibility and control over your warehouse inventory.
        </p>
        <p className="text-slate-400 text-sm mb-8">
          Manage stock levels, automate reorders, and track movements across all locations from a single dashboard.
        </p>

        {/* Features */}
        <div className="bg-slate-50 rounded-xl p-5 text-left mb-8">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            What's included
          </p>
          <ul className="space-y-2.5">
            {FEATURES.map((f, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
                <div className="w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Check className="w-3 h-3 text-blue-600" />
                </div>
                {f}
              </li>
            ))}
          </ul>
        </div>

        {/* CTA */}
        <button
          onClick={() => toast.info("You'll be notified when this feature is available!", 'Notification Set')}
          className="btn-primary mx-auto justify-center px-6 py-3"
        >
          <Bell className="w-4 h-4" />
          Notify Me When Ready
        </button>
      </div>
    </div>
  )
}
