import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send,
  Download,
  Pencil,
  Trash2,
  Check,
  X,
  MessageSquare,
  User,
  RefreshCw,
} from 'lucide-react'
import { useLocalStorage } from '../hooks/useLocalStorage.js'
import { useToast } from '../hooks/useToast.js'
import { relativeTime } from '../utils/dateUtils.js'
import { fetchMessages, sendMessage, editMessage, deleteMessage } from '../utils/api.js'

const POLL_INTERVAL = 5000 // refresh every 5 seconds

const USER_COLORS = [
  { bg: 'bg-blue-500',    text: 'text-white', bubble: 'bg-blue-500 text-white'    },
  { bg: 'bg-emerald-500', text: 'text-white', bubble: 'bg-emerald-500 text-white' },
  { bg: 'bg-violet-500',  text: 'text-white', bubble: 'bg-violet-500 text-white'  },
  { bg: 'bg-rose-500',    text: 'text-white', bubble: 'bg-rose-500 text-white'    },
  { bg: 'bg-amber-500',   text: 'text-white', bubble: 'bg-amber-500 text-white'   },
  { bg: 'bg-cyan-500',    text: 'text-white', bubble: 'bg-cyan-500 text-white'    },
  { bg: 'bg-pink-500',    text: 'text-white', bubble: 'bg-pink-500 text-white'    },
  { bg: 'bg-indigo-500',  text: 'text-white', bubble: 'bg-indigo-500 text-white'  },
]

function getColorForUser(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
}

function getInitials(name) {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
}

function Avatar({ name, size = 'sm' }) {
  const color = getColorForUser(name)
  const sizeClass = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm'
  return (
    <div className={`${sizeClass} rounded-full ${color.bg} ${color.text} flex items-center justify-center font-semibold flex-shrink-0`}>
      {getInitials(name)}
    </div>
  )
}

function MessageBubble({ note, isOwn, onEdit, onDelete }) {
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(note.text)
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.setSelectionRange(editText.length, editText.length)
    }
  }, [isEditing])

  const handleSaveEdit = async () => {
    const trimmed = editText.trim()
    if (!trimmed || isSaving) return
    setIsSaving(true)
    try {
      await onEdit(note.id, trimmed)
      setIsEditing(false)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancelEdit = () => {
    setEditText(note.text)
    setIsEditing(false)
  }

  return (
    <div className={`flex items-end gap-2 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      <Avatar name={note.author} />

      <div className={`flex flex-col max-w-xs sm:max-w-md ${isOwn ? 'items-end' : 'items-start'}`}>
        <div className={`flex items-center gap-2 mb-1 text-xs text-slate-400 ${isOwn ? 'flex-row-reverse' : ''}`}>
          <span className="font-medium text-slate-600">{note.author}</span>
          <span>{relativeTime(note.timestamp)}</span>
          {note.edited && <span className="italic">(edited)</span>}
        </div>

        {isEditing ? (
          <div className="w-64">
            <textarea
              ref={inputRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveEdit() }
                if (e.key === 'Escape') handleCancelEdit()
              }}
              className="w-full px-3 py-2 text-sm border border-blue-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={2}
            />
            <div className="flex gap-1 mt-1 justify-end">
              <button onClick={handleCancelEdit} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={isSaving}
                className="p-1.5 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-50"
              >
                {isSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        ) : (
          <div className="group relative">
            <div
              className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
                isOwn
                  ? 'bg-blue-600 text-white rounded-br-md'
                  : 'bg-white text-slate-700 border border-slate-200 rounded-bl-md shadow-sm'
              }`}
            >
              {note.text}
            </div>

            {isOwn && (
              <div className={`flex gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end`}>
                <button
                  onClick={() => setIsEditing(true)}
                  className="p-1 rounded text-slate-400 hover:text-blue-500 hover:bg-slate-100 transition-colors"
                  title="Edit"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onDelete(note.id)}
                  className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-slate-100 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function JoinModal({ onJoin }) {
  const [name, setName] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    onJoin(trimmed)
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="card max-w-sm w-full p-8 text-center">
        <div className="w-16 h-16 bg-purple-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <MessageSquare className="w-8 h-8 text-purple-600" />
        </div>
        <h3 className="text-lg font-bold text-slate-800 mb-1">Join the chat</h3>
        <p className="text-sm text-slate-500 mb-6">
          Enter your name to start adding notes for the team
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-base text-center text-base"
            autoFocus
            maxLength={40}
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="btn-primary w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Join
          </button>
        </form>
      </div>
    </div>
  )
}

// Normalize a DB row → internal note shape
function toNote(row) {
  return {
    id: row.id,
    author: row.name,
    text: row.text,
    timestamp: row.created_at,
    edited: row.edited || false,
  }
}

export default function NotesPage() {
  const [notes, setNotes] = useState([])
  const [currentUser, setCurrentUser] = useLocalStorage('feiya_notes_user', null)
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)
  const toast = useToast()

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [notes.length])

  // Load messages + poll for updates every 5 s
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const rows = await fetchMessages()
        if (!cancelled) setNotes(rows.map(toNote))
      } catch {
        // silently fail on poll — connection issues shouldn't spam toasts
      }
    }

    load()
    const interval = setInterval(load, POLL_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const handleJoin = useCallback((name) => setCurrentUser(name), [setCurrentUser])

  const handleSend = useCallback(async () => {
    const text = inputText.trim()
    if (!text || !currentUser || isSending) return

    setIsSending(true)
    setInputText('')
    try {
      const row = await sendMessage(currentUser, text)
      setNotes((prev) => [...prev, toNote(row)])
    } catch (err) {
      toast.error(err.message, 'Send Failed')
      setInputText(text) // restore
    } finally {
      setIsSending(false)
      textareaRef.current?.focus()
    }
  }, [inputText, currentUser, isSending, toast])

  const handleEdit = useCallback(async (id, newText) => {
    try {
      const row = await editMessage(id, newText)
      setNotes((prev) => prev.map((n) => (n.id === id ? toNote(row) : n)))
    } catch (err) {
      toast.error(err.message, 'Edit Failed')
    }
  }, [toast])

  const handleDelete = useCallback(async (id) => {
    try {
      await deleteMessage(id)
      setNotes((prev) => prev.filter((n) => n.id !== id))
      toast.info('Message deleted')
    } catch (err) {
      toast.error(err.message, 'Delete Failed')
    }
  }, [toast])

  const handleExport = useCallback(() => {
    const json = JSON.stringify(notes, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `feiya_notes_${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success('Notes exported as JSON', 'Exported')
  }, [notes, toast])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!currentUser) {
    return <JoinModal onJoin={handleJoin} />
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 8rem)' }}>
      {/* Header */}
      <div className="card p-4 mb-4 flex items-center gap-3">
        <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-purple-600" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-slate-800">Low Inventory Notes</h2>
          <p className="text-xs text-slate-400">
            {notes.length} message{notes.length !== 1 ? 's' : ''} · You are{' '}
            <span className="font-medium text-slate-600">{currentUser}</span>
            <span className="text-slate-300 mx-1">·</span>
            <span className="text-green-500">Live</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} className="btn-secondary text-xs" disabled={notes.length === 0}>
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <button onClick={() => setCurrentUser(null)} className="btn-ghost text-xs">
            <User className="w-3.5 h-3.5" />
            Change name
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="card flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <MessageSquare className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm font-medium">No notes yet</p>
            <p className="text-xs mt-1">Be the first to add a low inventory note!</p>
          </div>
        ) : (
          <>
            {notes.map((note) => (
              <MessageBubble
                key={note.id}
                note={note}
                isOwn={note.author === currentUser}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input area */}
      <div className="card mt-4 p-3">
        <div className="flex items-end gap-2">
          <Avatar name={currentUser} />
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a note… (Enter to send, Shift+Enter for new line)"
              className="input-base resize-none min-h-[44px] max-h-32 pr-4"
              rows={1}
              style={{ height: 'auto' }}
              onInput={(e) => {
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px'
              }}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!inputText.trim() || isSending}
            className="w-10 h-10 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors flex-shrink-0"
          >
            {isSending
              ? <RefreshCw className="w-4 h-4 animate-spin" />
              : <Send className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-1.5 ml-10">
          Press Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
