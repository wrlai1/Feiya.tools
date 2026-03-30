import React, { useState } from 'react'
import { X, Eye, EyeOff, AlertCircle, Check } from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'

export default function ChangePasswordModal({ onClose }) {
  const { changePassword } = useAuth()
  const toast = useToast()

  const [current, setCurrent]   = useState('')
  const [next, setNext]         = useState('')
  const [confirm, setConfirm]   = useState('')
  const [showCur, setShowCur]   = useState(false)
  const [showNew, setShowNew]   = useState(false)
  const [error, setError]       = useState('')
  const [saving, setSaving]     = useState(false)

  const mismatch = next && confirm && next !== confirm

  async function handleSubmit(e) {
    e.preventDefault()
    if (mismatch) return
    setError('')
    setSaving(true)
    try {
      await changePassword(current, next)
      toast.success('Password updated successfully')
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">Change Password</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </div>
          )}

          {/* Current password */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Current Password</label>
            <div className="relative">
              <input type={showCur ? 'text' : 'password'} value={current} onChange={e => setCurrent(e.target.value)}
                placeholder="Current password" required className="input-base w-full pr-10" />
              <button type="button" onClick={() => setShowCur(v => !v)} tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                {showCur ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* New password */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">New Password</label>
            <div className="relative">
              <input type={showNew ? 'text' : 'password'} value={next} onChange={e => setNext(e.target.value)}
                placeholder="New password (min 6 chars)" required minLength={6} className="input-base w-full pr-10" />
              <button type="button" onClick={() => setShowNew(v => !v)} tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Confirm new password */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Confirm New Password</label>
            <div className="relative">
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat new password" required
                className={`input-base w-full pr-10 ${mismatch ? 'border-red-400 focus:ring-red-300' : ''}`} />
              {confirm && !mismatch && <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />}
            </div>
            {mismatch && <p className="text-xs text-red-600 mt-1">Passwords do not match</p>}
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving || !!mismatch || !current || !next || !confirm}
              className="btn-primary flex-1 justify-center disabled:opacity-50">
              {saving ? 'Saving…' : 'Update Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
