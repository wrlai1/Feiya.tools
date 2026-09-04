import React, { useState, useEffect, useCallback } from 'react'
import {
  Users, Plus, KeyRound, Trash2, ShieldCheck, User,
  AlertCircle, RefreshCw, Eye, EyeOff, X, Check,
  CalendarCheck, SlidersHorizontal,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../hooks/useToast.js'
import { formatLastUpdated } from '../utils/dateUtils.js'
import userPermissions from '../utils/userPermissions.js'

const {
  INVENTORY_CHECK_EDIT,
  INVENTORY_CHECK_VIEW,
  normalizeUserPermissions,
} = userPermissions

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
      <div className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white shadow-2xl">
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

function InventoryPermissionControls({ permissions, onChange, disabled = false }) {
  const selected = normalizeUserPermissions(permissions)
  const canView = selected.includes(INVENTORY_CHECK_VIEW)
  const canEdit = selected.includes(INVENTORY_CHECK_EDIT)
  const setAccess = (view, edit) => onChange(normalizeUserPermissions([
    ...(view ? [INVENTORY_CHECK_VIEW] : []),
    ...(edit ? [INVENTORY_CHECK_EDIT] : []),
  ]))

  return (
    <div className={`rounded-xl border p-4 ${disabled ? 'border-slate-100 bg-slate-50 opacity-60' : 'border-slate-200'}`}>
      <div>
        <p className="text-sm font-semibold text-slate-800">Inventory Check</p>
        <p className="mt-0.5 text-xs text-slate-500">Choose whether this user can see or change weekly inventory.</p>
      </div>
      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={canView}
          disabled={disabled}
          onChange={(event) => setAccess(event.target.checked, event.target.checked ? canEdit : false)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
        />
        <span>
          <span className="block text-sm font-medium text-slate-700">View</span>
          <span className="block text-xs text-slate-500">Search, inspect, and export inventory without changing it.</span>
        </span>
      </label>
      <label className="mt-3 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={canEdit}
          disabled={disabled}
          onChange={(event) => setAccess(canView || event.target.checked, event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
        />
        <span>
          <span className="block text-sm font-medium text-slate-700">Edit</span>
          <span className="block text-xs text-slate-500">Upload, add, edit, delete, and adjust quantities. Edit automatically includes View.</span>
        </span>
      </label>
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
  const [newAttendanceAccess, setNewAttendanceAccess] = useState(false)
  const [newPermissions, setNewPermissions] = useState([INVENTORY_CHECK_VIEW])
  const [resetPassword, setResetPassword] = useState('')
  const [permissionDraft, setPermissionDraft] = useState([])
  const [attendanceDraft, setAttendanceDraft] = useState(false)

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
    setNewAttendanceAccess(false)
    setNewPermissions([INVENTORY_CHECK_VIEW])
    setResetPassword('')
    setPermissionDraft([])
    setAttendanceDraft(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    setFormError('')
    setSaving(true)
    try {
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          role: newRole,
          attendanceAccess: newRole === 'user' && newAttendanceAccess,
          permissions: newRole === 'user' && !newAttendanceAccess ? newPermissions : [],
        }),
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

  async function handleAttendanceToggle(u) {
    try {
      await apiFetch(`/users?id=${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ attendanceAccess: !u.attendance_access }),
      }, getToken)
      toast.success(`${u.username} attendance-only access ${u.attendance_access ? 'disabled' : 'enabled'}`)
      loadUsers()
    } catch (err) {
      toast.error(err.message)
    }
  }

  function openPermissions(u) {
    setPermissionDraft(normalizeUserPermissions(u.permissions))
    setAttendanceDraft(Boolean(u.attendance_access))
    setModal({ type: 'permissions', user: u })
  }

  async function handlePermissions(e) {
    e.preventDefault()
    setFormError('')
    setSaving(true)
    try {
      await apiFetch(`/users?id=${modal.user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          attendanceAccess: attendanceDraft,
          permissions: attendanceDraft ? [] : permissionDraft,
        }),
      }, getToken)
      toast.success(`Access updated for "${modal.user.username}"`)
      closeModal()
      loadUsers()
    } catch (err) {
      setFormError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-6xl space-y-6">
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
                <th className="px-4 py-3 text-left font-semibold text-slate-500 uppercase tracking-wide text-xs">Factory Attendance</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-500 uppercase tracking-wide text-xs hidden lg:table-cell">Inventory Check</th>
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
                  <td className="hidden px-4 py-3 text-xs text-slate-500 lg:table-cell">
                    {u.role === 'admin'
                      ? 'Full access'
                      : u.attendance_access
                        ? 'Hidden'
                        : u.permissions?.includes(INVENTORY_CHECK_EDIT)
                          ? 'View + Edit'
                          : u.permissions?.includes(INVENTORY_CHECK_VIEW) ? 'View only' : 'No access'}
                  </td>
                  <td className="px-4 py-3">
                    {u.role === 'admin' ? (
                      <span className="text-xs text-slate-400">Included</span>
                    ) : (
                      <button onClick={() => handleAttendanceToggle(u)} className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${u.attendance_access ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        <CalendarCheck className="h-3 w-3" /> {u.attendance_access ? 'Attendance only' : 'Off'}
                      </button>
                    )}
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
                      {u.role !== 'admin' && (
                        <button
                          onClick={() => openPermissions(u)}
                          className="p-1.5 rounded-lg text-slate-400 hover:bg-violet-50 hover:text-violet-600 transition-colors"
                          title="Set access"
                        >
                          <SlidersHorizontal className="w-4 h-4" />
                        </button>
                      )}
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
            {newRole === 'user' && (
              <div className="space-y-3">
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border-2 p-3 transition-colors ${newAttendanceAccess ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200'}`}>
                  <input type="checkbox" checked={newAttendanceAccess} onChange={(event) => setNewAttendanceAccess(event.target.checked)} className="mt-0.5" />
                  <span><span className="block text-sm font-medium text-slate-700">Factory attendance only</span><span className="block text-xs text-slate-500">This account will only see TXT upload, attendance review, and payroll summaries.</span></span>
                </label>
                <InventoryPermissionControls permissions={newPermissions} onChange={setNewPermissions} disabled={newAttendanceAccess} />
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={closeModal} className="btn-secondary flex-1 justify-center">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center disabled:opacity-50">
                {saving ? 'Creating…' : 'Create User'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal?.type === 'permissions' && (
        <Modal title={`Access — ${modal.user.username}`} onClose={closeModal}>
          <form onSubmit={handlePermissions} className="space-y-4">
            {formError && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />{formError}
              </div>
            )}
            <label className={`flex cursor-pointer items-start gap-3 rounded-lg border-2 p-3 transition-colors ${attendanceDraft ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200'}`}>
              <input type="checkbox" checked={attendanceDraft} onChange={(event) => setAttendanceDraft(event.target.checked)} className="mt-0.5" />
              <span><span className="block text-sm font-medium text-slate-700">Factory attendance only</span><span className="block text-xs text-slate-500">When enabled, all other modules are hidden from this account.</span></span>
            </label>
            <InventoryPermissionControls permissions={permissionDraft} onChange={setPermissionDraft} disabled={attendanceDraft} />
            <p className="text-xs text-slate-500">Changes apply to the API immediately. The user may need to refresh the page to update the menu.</p>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={closeModal} className="btn-secondary flex-1 justify-center">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Access'}
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
