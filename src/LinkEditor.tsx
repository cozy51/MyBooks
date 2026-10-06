import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ChartPie, ClipboardPaste, ExternalLink, GripVertical, Headphones, Link2, MonitorPlay, Pencil, Presentation, ScanLine, Trash2, Video } from 'lucide-react'
import { CARD_LINK_LIMIT, LINK_PRESETS, canonicalLabel, isPreset, isScan, isUrl, presetsFirst, readClipboardUrl, sanitizeUrlInput, shortLabel } from './links'
import type { BookLink } from './types'

const ICONS: Record<string, typeof Link2> = { 'インフォグラフィック': ChartPie, '音声解説': Headphones, '動画解説': Video, '全ページスキャン': ScanLine, 'GeminiNotebookスライド': Presentation, 'GeminiNotebookスライド動画': MonitorPlay }
function LinkIcon({ label }: { label: string }) { const Icon = ICONS[canonicalLabel(label)] ?? Link2; return <Icon /> }

/** カード用：URLのあるリンクを先頭から最大6つ（固定のリンクは短い名前で表示） */
export function CardLinks({ links }: { links: BookLink[] }) {
  const shown = presetsFirst(links).filter(l => l.url).slice(0, CARD_LINK_LIMIT)
  if (!shown.length) return null
  return <div className="link-chips">{shown.map(l => <a key={l.id} href={l.url} target="_blank" rel="noreferrer" className={isScan(l) ? 'scan' : undefined} title={`${l.label || 'リンク'}\n${l.url}`}
    onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}><LinkIcon label={l.label} />{shortLabel(l.label)}</a>)}</div>
}

export function LinkEditor({ links, onChange }: { links: BookLink[]; onChange: (links: BookLink[]) => void }) {
  const [dragId, setDragId] = useState<string | null>(null)
  // 入力済みのURLは誤って書き換えないようロックし、鉛筆ボタンを押したときだけ編集できるようにする。
  // 空の欄（または打ちかけの欄）はすぐに入力でき、欄を離れると入力済みのURLは再びロックされる
  const [editing, setEditing] = useState<Set<string>>(() => new Set())
  const urlInputs = useRef(new Map<string, HTMLInputElement>())
  const setEditable = (id: string, on: boolean) => setEditing(prev => { if (prev.has(id) === on) return prev; const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next })
  const unlock = (id: string) => {
    setEditable(id, true)
    const input = urlInputs.current.get(id)
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
  }
  const move = (id: string, to: number) => {
    const from = links.findIndex(l => l.id === id)
    if (from < 0 || to < 0 || to >= links.length || from === to) return
    const next = [...links]; const [item] = next.splice(from, 1); next.splice(to, 0, item); onChange(presetsFirst(next))
  }
  const update = (id: string, patch: Partial<BookLink>) => onChange(links.map(l => l.id === id ? { ...l, ...patch } : l))
  // URL以外（日本語など）は入力させない。打ちかけの「https:」などは、欄を離れたときに消す
  const typeUrl = (id: string, value: string) => { const url = sanitizeUrlInput(value); if (url !== null) update(id, { url }) }
  const leaveUrl = (link: BookLink) => { setEditable(link.id, false); if (link.url && !isUrl(link.url)) update(link.id, { url: '' }) }
  const pasteUrl = async (id: string) => {
    const url = await readClipboardUrl()
    if (url) update(id, { url }); else alert('クリップボードにURLがありません')
  }

  // つまみ（⋮⋮）をドラッグして並べ替え。マウスとタッチの両方で動くようPointer Eventsを使う
  const startDrag = (id: string) => (e: PointerEvent<HTMLButtonElement>) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDragId(id) }
  const dragOver = (e: PointerEvent<HTMLButtonElement>) => {
    if (!dragId) return
    const row = document.elementsFromPoint(e.clientX, e.clientY).find((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.linkId)
    if (row && row.dataset.linkId !== dragId) move(dragId, links.findIndex(l => l.id === row.dataset.linkId))
  }
  const endDrag = () => setDragId(null)
  const keyMove = (id: string, index: number) => (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); move(id, index + (e.key === 'ArrowUp' ? -1 : 1)) }
  }

  return <>
    {links.length === 0 ? <p className="links-empty">関連リンクはまだありません。</p> : links.map((link, index) => {
      // 固定の欄は表示名を変えられず、決まった順から動かさない（URLは変更・削除できる）
      const fixed = isPreset(link)
      const locked = isUrl(link.url) && !editing.has(link.id)
      return <div className={`link-editor${dragId === link.id ? ' dragging' : ''}${fixed ? ' fixed' : ''}`} key={link.id} data-link-id={link.id}>
        {fixed ? <span className="drag-handle" aria-hidden="true" /> : <button type="button" className="drag-handle" aria-label={`「${link.label || 'リンク'}」を並べ替え（ドラッグ、または↑↓キー）`} title="ドラッグして並べ替え"
          onPointerDown={startDrag(link.id)} onPointerMove={dragOver} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={keyMove(link.id, index)}><GripVertical /></button>}
        {fixed ? <input value={link.label} readOnly className="label-fixed" title="この表示名は変更できません" />
          : <input value={link.label} onChange={e => { if (!LINK_PRESETS.includes(canonicalLabel(e.target.value))) update(link.id, { label: e.target.value }) }} placeholder="表示名" />}
        <span className={`url-field${locked ? ' locked' : ''}`}>
          {locked ? <button type="button" className="url-paste" onClick={() => unlock(link.id)} aria-label="URLを編集" title="URLを編集"><Pencil /></button>
            : <button type="button" className="url-paste" onClick={() => void pasteUrl(link.id)} aria-label="クリップボードのURLを貼り付け" title="クリップボードのURLを貼り付け"><ClipboardPaste /></button>}
          <input ref={el => { if (el) urlInputs.current.set(link.id, el); else urlInputs.current.delete(link.id) }} type="url" inputMode="url" autoComplete="off" spellCheck={false} value={link.url} readOnly={locked}
            title={locked ? 'URLを変更するときは左の鉛筆ボタンを押してください' : undefined}
            onFocus={() => { if (!isUrl(link.url)) setEditable(link.id, true) }} onChange={e => typeUrl(link.id, e.target.value)} onBlur={() => leaveUrl(link)} placeholder="https://..." /></span>
        {isUrl(link.url) ? <a href={link.url} target="_blank" rel="noreferrer" aria-label="新しいタブで開く"><ExternalLink /></a> : <span />}
        {fixed ? <span /> : <button type="button" className="link-delete" onClick={() => onChange(links.filter(l => l.id !== link.id))} aria-label="リンクを削除"><Trash2 /></button>}
      </div>
    })}
  </>
}

