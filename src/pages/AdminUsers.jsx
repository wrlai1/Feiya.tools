import React, { useState, useEffect, useCallback } from 'react'
import {
  Users, Plus, KeyRound, Trash2, ShieldCheck, User,
  AlertCircle, RefreshCw, Eye, EyeOff, X, Check,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'
import { formatLastUpdated } from '../utils/dateUtils.js'

const BASE = '/api'

function apiFetch(path, options, getToken) {
  const token = getToken()
  return fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options?.headers },
  }).then(async r => {
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  })
}

function RoleBadge({ role }) {
  return role === 'admin' ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
      <ShieldCheck className="w-3 h-3" /> Admin
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">
      <User className="w-3 h-3" /> User
    </span>
  )
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

function PasswordInput({ value, onChange, placeholder = 'Password' }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="input-base w-full pr-10"
        required
        minLength={6}
      />
      <button type="button" onClick={() => setShow(v => !v)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" tabIndex={-1}>
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  )
}

export default function AdminUsers() {
  const { getToken, user: me } = useAuth()
  const toast = useToast()
  const [users, setUsers]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [modal, setModal]         = useState(null) // 'create' | { type: 'reset', user } | { type: 'delete', user }
  const [formError, setFormError] = useState('')
  const [saving, setSaving]       = useState(false)

  // Form state
  const [newUsername, setNewUsername]     = useState('')
  const [newPassword, setNewPassword]     = useState('')
  const [newRole, setNewRole]             = useState('user')
  const [resetPassword, setResetPassword] = useState('')

  const loadUsers = useCallback(() => {
    setLoading(true)
    apiFetch('/users', {}, getToken)
      .then(setUsers)
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }, [getToken, toast])

  useEffect(() => { loadUsers() }, [loadUsers])

  function closeModal() {
    setModal(null)
    setFormError('')
    setNewUsername('')
    setNewPassword('')
    setNewRole('user')
    setResetPassword('')
  }

  async function handleCreate(e) {
    e.preventDefault()
    setFormError('')
    setSaving(true)
    try {
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
      }, getToken)
      toast.success(`User "${newUsername}" created`)
      closeModal()
      loadUsers()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleReset(e) {
    e.preventDefault()
    setFormError('')
    setSaving(true)
    try {
      await apiFetch(`/users?id=${modal.user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: resetPassword }),
      }, getToken)
      toast.success(`Password reset for "${modal.user.username}"`)
      closeModal()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setSaving(true)
    try {
      await apiFetch(`/users?id=${modal.user.id}`, { method: 'DELETE' }, getToken)
      toast.info(`User "${modal.user.username}" deleted`)
      closeModal()
      loadUsers()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleRoleToggle(u) {
    const newRole = u.role === 'admin' ? 'user' : 'admin'
    try {
      await apiFetch(`/users?id=${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      }, getToken)
      toast.success(`${u.username} is now ${newRole}`)
      loadUsers()
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">User Management</h2>
          <p className="text-sm text-slate-500 mt-0.5">{users.length} user{users.length !== 1 ? 's' : ''} total</p>
        </div>
        <button onClick={() => setModal('create')} className="btn-primary text-sm">
          <Plus className="w-4 h-4" /> Add User
        </button>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />
            <span className="ml-3 text-slate-500">Loading users…</span>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-4 py-3 text-left font-semibold text-slate-500 uppercase tracking-wide text-xs">Username</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-500 uppercase tracking-wide text-xs">Role</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-500 uppercase tracking-wide text-xs hidden sm:table-cell">Created by</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-500 uppercase tracking-wide text-xs hidden md:table-cell">Joined</th>
                <th className="px-4 py-3 text-right font-semibold text-slate-500 uppercase tracking-wide text-xs">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map(u => (
                <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${u.role === 'admin' ? 'bg-blue-600' : 'bg-slate-400'}`}>
                        {u.username[0].toUpperCase()}
                      </div>
                      <span className="font-medium text-slate-800">{u.username}</span>
                      {u.id === me?.id && <span className="text-xs text-slate-400">(you)</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => u.id !== me?.id && handleRoleToggle(u)}
                      disabled={u.id === me?.id}
                      title={u.id === me?.id ? "Can't change your own role" : `Click to make ${u.role === 'admin' ? 'regular user' : 'admin'}`}
                      className="disabled:cursor-not-allowed"
                    >
                      <RoleBadge role={u.role} />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-slate-500 hidden sm:table-cell">{u.created_by || '—'}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs hidden md:table-cell">{formatLastUpdated(u.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setModal({ type: 'reset', user: u })}
                        className="p-1.5 rounded-lg text-slate-400 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                        title="Reset password"
                      >
                        <KeyRound className="w-4 h-4" />
                      </button>
                      {u.id !== me?.id && (
                        <button
                          onClick={() => setModal({ type: 'delete', user: u })}
                          className="p-1.5 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          title="Delete user"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Create User Modal ── */}
      {modal === 'create' && (
        <Modal title="Add New User" onClose={closeModal}>
          <form onSubmit={handleCreate} className="space-y-4">
            {formError && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />{formError}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Username</label>
              <input type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)}
                placeholder="e.g. john" required className="input-base w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
              <PasswordInput value={newPassword} onChange={e => setNewPassword(e.target.value)} />
              <p className="text-xs text-slate-400 mt-1">Minimum 6 characters</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Role</label>
              <div className="flex gap-3">
                {['user', 'admin'].map(r => (
                  <label key={r} className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 cursor-pointer transition-colors ${newRole === r ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                    <input type="radio" name="role" value={r} checked={newRole === r} onChange={() => setNewRole(r)} className="sr-only" />
                    {r === 'admin' ? <ShieldCheck className="w-4 h-4 text-blue-600" /> : <User className="w-4 h-4 text-slate-500" />}
                    <span className="text-sm font-medium capitalize">{r}</span>
                    {newRole === r && <Check className="w-3.5 h-3.5 text-blue-600 ml-auto" />}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={closeModal} className="btn-secondary flex-1 justify-center">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center disabled:opacity-50">
                {saving ? 'Creating…' : 'Create User'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Reset Password Modal ── */}
      {modal?.type === 'reset' && (
        <Modal title={`Reset Password — ${modal.user.username}`} onClose={closeModal}>
          <form onSubmit={handleReset} className="space-y-4">
            {formError && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />{formError}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">New Password</label>
              <PasswordInput value={resetPassword} onChange={e => setResetPassword(e.target.value)} placeholder="New password" />
              <p className="text-xs text-slate-400 mt-1">Minimum 6 characters</p>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={closeModal} className="btn-secondary flex-1 justify-center">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center disabled:opacity-50">
                {saving ? 'Saving…' : 'Reset Password'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Delete Confirm Modal ── */}
      {modal?.type === 'delete' && (
        <Modal title="Delete User" onClose={closeModal}>
          <div className="space-y-4">
            {formError && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />{formError}
              </div>
            )}
            <p className="text-slate-600">
              Are you sure you want to delete <strong className="text-slate-800">{modal.user.username}</strong>?
              This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={closeModal} className="btn-secondary flex-1 justify-center">Cancel</button>
              <button
                onClick={handleDelete} disabled={saving}
                className="flex-1 justify-center inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                {saving ? 'Deleting…' : <><Trash2 className="w-4 h-4" /> Delete</>}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
