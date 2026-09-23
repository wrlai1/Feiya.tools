import React, { useRef, useState, useCallback } from 'react'
import { Upload, FileText, X } from 'lucide-react'

export default function FileUploadZone({
  onFile,
  accept = '.xlsx,.xls,.csv',
  label = 'Drag & drop your file here',
  sublabel = 'or click to browse',
  acceptedTypes = 'XLSX, XLS, CSV',
  currentFile = null,
  onClear,
  compact = false,
  multiple = false,
}) {
  const inputRef = useRef(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const handleFiles = useCallback(
    (files) => {
      const selected = [...(files || [])]
      if (!selected.length || !onFile) return
      onFile(multiple ? selected : selected[0])
    },
    [multiple, onFile]
  )

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault()
      setIsDragOver(false)
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles]
  )

  const handleInputChange = useCallback(
    (e) => {
      handleFiles(e.target.files)
      e.target.value = ''
    },
    [handleFiles]
  )

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  if (currentFile) {
    return (
      <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
        <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
          <FileText className="w-5 h-5 text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-blue-800 truncate">
            {currentFile.name}
          </p>
          <p className="text-xs text-blue-500 mt-0.5">
            {formatFileSize(currentFile.size)}
          </p>
        </div>
        {onClear && (
          <button
            onClick={onClear}
            className="p-1.5 text-blue-400 hover:text-blue-600 hover:bg-blue-100 rounded-lg transition-colors"
            title="Remove file"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className={`upload-zone rounded-xl ${compact ? 'p-4' : 'p-8'} text-center cursor-pointer select-none ${
        isDragOver ? 'drag-over' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={handleInputChange}
      />
      <div className={`flex flex-col items-center ${compact ? 'gap-2' : 'gap-3'}`}>
        <div
          className={`${compact ? 'w-10 h-10 rounded-xl' : 'w-14 h-14 rounded-2xl'} flex items-center justify-center transition-colors ${
            isDragOver ? 'bg-blue-100' : 'bg-slate-100'
          }`}
        >
          <Upload
            className={`${compact ? 'w-5 h-5' : 'w-7 h-7'} transition-colors ${
              isDragOver ? 'text-blue-500' : 'text-slate-400'
            }`}
          />
        </div>
        <div>
          <p
            className={`${compact ? 'text-sm' : 'text-base'} font-medium transition-colors ${
              isDragOver ? 'text-blue-700' : 'text-slate-600'
            }`}
          >
            {label}
          </p>
          <p className={`${compact ? 'text-xs' : 'text-sm'} text-slate-400 mt-1`}>
            {sublabel}
          </p>
        </div>
        <p className="text-xs text-slate-400 bg-slate-100 px-3 py-1 rounded-full">
          Accepted: {acceptedTypes}
        </p>
      </div>
    </div>
  )
}
