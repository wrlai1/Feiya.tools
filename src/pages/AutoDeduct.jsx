import React from 'react'
import { Minus, Check, Bell } from 'lucide-react'
import { useToast } from '../hooks/useToast.js'

const FEATURES = [
  'Automatic inventory deduction when shipments are dispatched',
  'Bulk deduct from tracking CSV — match SKUs to inventory automatically',
  'Smart duplicate detection to prevent double-deductions',
  'Scheduled deductions with configurable delay and approval gates',
  'Full deduction history with rollback capability',
  'Low-stock threshold alerts triggered immediately after deduction',
]

export default function AutoDeduct() {
  const toast = useToast()

  return (
    <div className="max-w-2xl mx-auto">
      <div className="card p-12 text-center">
        {/* Icon */}
        <div className="w-20 h-20 bg-orange-100 rounded-3xl flex items-center justify-center mx-auto mb-6">
          <Minus className="w-10 h-10 text-orange-600" />
        </div>

        {/* Title */}
        <div className="inline-flex items-center gap-2 bg-orange-100 text-orange-700 text-xs font-semibold px-3 py-1 rounded-full mb-4">
          Coming Soon
        </div>
        <h2 className="text-2xl font-bold text-slate-800 mb-3">Auto Deduct</h2>
        <p className="text-slate-500 leading-relaxed mb-2">
          Eliminate manual inventory adjustments by automatically deducting stock quantities as orders are shipped.
        </p>
        <p className="text-slate-400 text-sm mb-8">
          Upload your tracking data and the system will intelligently match shipments to SKUs and deduct inventory in real time.
        </p>

        {/* Features */}
        <div className="bg-slate-50 rounded-xl p-5 text-left mb-8">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            What's included
          </p>
          <ul className="space-y-2.5">
            {FEATURES.map((f, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
                <div className="w-5 h-5 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Check className="w-3 h-3 text-orange-600" />
                </div>
                {f}
              </li>
            ))}
          </ul>
        </div>

        {/* CTA */}
        <button
          onClick={() => toast.info("You'll be notified when this feature is available!", 'Notification Set')}
          className="inline-flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-medium px-6 py-3 rounded-lg transition-colors"
        >
          <Bell className="w-4 h-4" />
          Notify Me When Ready
        </button>
      </div>
    </div>
  )
}
