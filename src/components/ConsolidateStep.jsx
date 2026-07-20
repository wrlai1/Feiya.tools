import React, { useState, useCallback } from 'react'
import { Layers, Download, ChevronDown, ChevronUp, CheckCircle, AlertTriangle } from 'lucide-react'
import FileUploadZone from './FileUploadZone.jsx'
import { useToast } from '../hooks/useToast.js'
import { parseCSV } from '../utils/autoDeductEngine.js'
import { consolidateRows, toCSV } from '../utils/consolidateEngine.js'

/**
 * 第一步：合并原始导出。
 * 上传 Style+Quantity 的原始订单文件 → 浏览器里合并成 (style,color,size,QTY)
 * → 下载 consolidated / needs_review 两个 CSV → 人工清理后再回来跑 Auto Deduct。
 */
export default function ConsolidateStep() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState(null)   // { consolidated, needsReview, stats, baseName }

  const handleFile = useCallback(async (file) => {
    try {
      let rows
      if (/\.csv$/i.test(file.name)) {
        rows = parseCSV(await file.text())
      } else {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
        rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' })
      }
      const out = consolidateRows(rows)
      setResult({ ...out, baseName: file.name.replace(/\.(csv|xlsx?|xls)$/i, '') })
      const { stats } = out
      toast.success(
        `${stats.origRows} 行 → ${out.consolidated.length} 组 · QTY ${stats.qtyOk ? '守恒 ✓' : '不符 ⚠'} · ${stats.reviewRows} 行待检查`,
        '合并完成'
      )
    } catch (err) {
      toast.error(err.message, '合并失败')
    }
  }, [toast])

  const download = useCallback((rows, headers, suffix) => {
    const blob = new Blob(['﻿' + toCSV(rows, headers)], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${result.baseName}_${suffix}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [result])

  return (
    <div className="card overflow-hidden">
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-slate-50">
        <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Layers className="w-4 h-4 text-blue-500" />
          第一步（可选）：合并原始导出 → consolidated CSV
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-slate-100 pt-4">
          <FileUploadZone
            onFile={handleFile}
            accept=".csv,.xlsx,.xls"
            label="拖入原始订单导出（含 Style/SKU + Quantity 列）"
            sublabel="或点击选择文件"
            acceptedTypes="CSV, XLSX"
          />

          {result && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5">
                  {result.stats.qtyOk
                    ? <CheckCircle className="w-4 h-4 text-green-500" />
                    : <AlertTriangle className="w-4 h-4 text-red-500" />}
                  {result.stats.origRows} 行 → <b>{result.consolidated.length}</b> 组
                </span>
                <span className="text-slate-500">
                  QTY：{result.stats.origTotal.toLocaleString()}
                  {result.stats.expandedTotal !== result.stats.origTotal &&
                    ` → ${result.stats.expandedTotal.toLocaleString()}（set 展开后）`}
                </span>
                {result.stats.reviewRows > 0 && (
                  <span className="text-amber-600">⚠ {result.stats.reviewRows} 行解析存疑</span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button onClick={() => download(result.consolidated, ['style', 'color', 'size', 'QTY'], 'consolidated')}
                  className="btn-primary text-sm px-4 py-2">
                  <Download className="w-4 h-4" /> 下载 consolidated CSV
                </button>
                {result.needsReview.length > 0 && (
                  <button onClick={() => download(result.needsReview, ['raw_style', 'style', 'color', 'size', 'parse_issue', 'QTY'], 'needs_review')}
                    className="btn-secondary text-sm px-4 py-2">
                    <Download className="w-4 h-4" /> 下载 needs_review CSV（{result.needsReview.length}）
                  </button>
                )}
              </div>

              <p className="text-xs text-slate-400">
                下载后先清理（尤其 needs_review 里的行），确认无误再用下面的区域上传跑 Auto Deduct。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
