import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react'

export const ToastContext = createContext(null)

const TOAST_TYPES = {
  success: {
    icon: CheckCircle,
    bg: 'bg-green-50',
    border: 'border-green-200',
    iconColor: 'text-green-500',
    titleColor: 'text-green-800',
    msgColor: 'text-green-700',
  },
  error: {
    icon: XCircle,
    bg: 'bg-red-50',
    border: 'border-red-200',
    iconColor: 'text-red-500',
    titleColor: 'text-red-800',
    msgColor: 'text-red-700',
  },
  warning: {
    icon: AlertCircle,
    bg: 'bg-yellow-50',
    border: 'border-yellow-200',
    iconColor: 'text-yellow-500',
    titleColor: 'text-yellow-800',
    msgColor: 'text-yellow-700',
  },
  info: {
    icon: Info,
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    iconColor: 'text-blue-500',
    titleColor: 'text-blue-800',
    msgColor: 'text-blue-700',
  },
}

function ToastItem({ toast, onRemove }) {
  const [exiting, setExiting] = useState(false)
  const config = TOAST_TYPES[toast.type] || TOAST_TYPES.info
  const Icon = config.icon

  const handleClose = useCallback(() => {
    setExiting(true)
    setTimeout(() => onRemove(toast.id), 300)
  }, [toast.id, onRemove])

  useEffect(() => {
    const timer = setTimeout(() => {
      handleClose()
    }, toast.duration || 4000)
    return () => clearTimeout(timer)
  }, [handleClose, toast.duration])

  return (
    <div
      className={`
        flex items-start gap-3 p-4 rounded-xl border shadow-lg max-w-sm w-full
        ${config.bg} ${config.border}
        ${exiting ? 'toast-exit' : 'toast-enter'}
      `}
    >
      <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${config.iconColor}`} />
      <div className="flex-1 min-w-0">
        {toast.title && (
          <p className={`text-sm font-semibold ${config.titleColor}`}>
            {toast.title}
          </p>
        )}
        {toast.message && (
          <p className={`text-sm ${config.msgColor} ${toast.title ? 'mt-0.5' : ''}`}>
            {toast.message}
          </p>
        )}
      </div>
      <button
        onClick={handleClose}
        className={`flex-shrink-0 ${config.iconColor} opacity-60 hover:opacity-100 transition-opacity`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback(({ type = 'info', title, message, duration = 4000 }) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2)
    setToasts((prev) => [...prev, { id, type, title, message, duration }])
  }, [])

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = {
    success: (message, title) => addToast({ type: 'success', title, message }),
    error: (message, title) => addToast({ type: 'error', title, message }),
    warning: (message, title) => addToast({ type: 'warning', title, message }),
    info: (message, title) => addToast({ type: 'info', title, message }),
  }

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        <div className="pointer-events-auto flex flex-col gap-2">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onRemove={removeToast} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  )
}
