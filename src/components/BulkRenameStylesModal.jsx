import React, { useId, useMemo, useState } from 'react'
import { ArrowRight, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useToast } from '../hooks/useToast.js'
import { MAX_STYLE_RENAMES, normalizeStyleRenames, parseStyleRenamePaste } from '../utils/styleRenames.js'
import { styleNameKey } from '../utils/styleNames.js'

const blankRow = () => ({ oldStyle: '', newStyle: '' })

export default function BulkRenameStylesModal({ inventoryRows, initialStyles = [], onClose, onDone, onSave }) {
  const [rows, setRows] = useState(() => initialStyles.length && initialStyles.length <= MAX_STYLE_RENAMES
    ? initialStyles.map(oldStyle => ({ oldStyle, newStyle: '' })) : [blankRow()])
  const [review, setReview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState('')
  const listId = useId()
  const toast = useToast()
  const styles = useMemo(() => [...new Set(inventoryRows.map(row => row.Style))].sort(), [inventoryRows])
  const plan = useMemo(() => {
    const entered = rows.filter(row => row.newStyle.trim() && row.newStyle.trim() !== row.oldStyle.trim())
    if (!entered.length) return { changes: [], affected: 0 }
    try {
      const changes = normalizeStyleRenames(entered)
      for (const { oldStyle, newStyle } of changes) {
        if (!styles.some(style => styleNameKey(style) === styleNameKey(oldStyle))) throw new Error(`找不到原名称：${oldStyle}`)
        if (styles.some(style => styleNameKey(style) === styleNameKey(newStyle) && styleNameKey(style) !== styleNameKey(oldStyle))) {
          throw new Error(`新名称已存在：${newStyle}。请使用不同的名称。`)
        }
      }
      const sourceKeys = new Set(changes.map(row => styleNameKey(row.oldStyle)))
      return { changes, affected: inventoryRows.filter(row => sourceKeys.has(styleNameKey(row.Style))).length }
    } catch (error) { return { changes: [], affected: 0, error: error.message } }
  }, [rows, styles, inventoryRows])

  const update = (index, field, value) => {
    setServerError('')
    setRows(current => current.map((row, i) => i === index ? { ...row, [field]: value } : row))
  }
  const paste = (event, index) => {
    const text = event.clipboardData.getData('text')
    if (!text.includes('\t')) return
    event.preventDefault()
    try {
      const changes = parseStyleRenamePaste(text)
      if (index + changes.length > MAX_STYLE_RENAMES) throw new Error(`一次最多修改 ${MAX_STYLE_RENAMES} 个款式`)
      setRows(current => {
        const next = [...current]
        changes.forEach((change, offset) => { next[index + offset] = change })
        return next
      })
      setServerError('')
    } catch (error) { toast.error(error.message, '粘贴失败') }
  }
  const save = async () => {
    if (saving || plan.error || !plan.changes.length) return
    setSaving(true)
    setServerError('')
    try {
      const result = await onSave(plan.changes)
      onDone(result)
      toast.success(`已修改 ${result.renamedStyles} 个款式，关联资料已同步`, '名称修改成功')
      onClose()
    } catch (error) { setServerError(error.message) }
    finally { setSaving(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby={listId + '-title'} className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-100 p-5">
          <div>
            <h3 id={listId + '-title'} className="font-semibold text-slate-900">批量修改 Style 名称</h3>
            <p className="mt-1 text-sm text-slate-500">库存、退货映射、报表和每日邮件同步更新，库存数量保持不变。</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="关闭批量改名" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-50"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-4 overflow-y-auto p-5">
          {!review ? (
            <>
              <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">可从 Excel 复制“原名称、新名称”两列，粘贴到原名称输入框。新名称留空的行不会修改。一次最多 {MAX_STYLE_RENAMES} 个款式。</p>
              <datalist id={listId}>{styles.map(style => <option key={style} value={style} />)}</datalist>
              <table className="w-full table-fixed text-sm">
                <thead><tr className="text-left text-slate-500"><th className="w-1/2 pb-2">原名称 / Old Style</th><th className="pb-2">新名称 / New Style</th><th className="w-10"><span className="sr-only">移除</span></th></tr></thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      <td className="pb-2 pr-2"><input aria-label={`第 ${index + 1} 行原名称`} list={listId} value={row.oldStyle} onChange={event => update(index, 'oldStyle', event.target.value)} onPaste={event => paste(event, index)} className="input-base w-full" placeholder="选择或输入现有款式" autoFocus={index === 0} /></td>
                      <td className="pb-2"><input aria-label={`第 ${index + 1} 行新名称`} value={row.newStyle} onChange={event => update(index, 'newStyle', event.target.value)} maxLength={100} className="input-base w-full" placeholder="留空表示不修改" /></td>
                      <td className="pb-2 pl-2"><button type="button" aria-label={`移除第 ${index + 1} 行`} onClick={() => setRows(current => current.length === 1 ? [blankRow()] : current.filter((_, i) => i !== index))} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" onClick={() => setRows(current => [...current, blankRow()])} disabled={rows.length >= MAX_STYLE_RENAMES} className="btn-secondary text-sm disabled:opacity-50"><Plus className="h-4 w-4" />添加一行</button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-700">请确认以下 {plan.changes.length} 个款式的新名称，涉及 {plan.affected} 条颜色／尺码库存记录。</p>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {plan.changes.map(change => <li key={change.oldStyle} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-3 text-sm"><span className="break-all text-slate-600">{change.oldStyle}</span><ArrowRight className="h-4 w-4 text-slate-400" /><span className="break-all font-semibold text-blue-700">{change.newStyle}</span></li>)}
              </ul>
              <p className="text-xs text-slate-500">所有修改一起保存。如果有重名或资料冲突，整批都不会修改。</p>
            </>
          )}
          {(plan.error || serverError) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{serverError || plan.error}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 p-5">
          <span className="text-sm text-slate-500">{plan.changes.length} 个款式 · {plan.affected} 条库存记录</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => { if (review) { setReview(false); setServerError('') } else onClose() }} disabled={saving} className="btn-secondary">{review ? '返回修改' : '取消'}</button>
            <button type="button" onClick={() => review ? save() : setReview(true)} disabled={saving || !!plan.error || !plan.changes.length} className="btn-primary disabled:opacity-50">
              {saving && <RefreshCw className="h-4 w-4 animate-spin" />}{saving ? '保存中…' : review ? `确认修改 ${plan.changes.length} 个款式` : '预览修改'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
