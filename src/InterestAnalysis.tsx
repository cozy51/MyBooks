import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import * as drive from './drive'
import { hash } from './embeddingStore'
import { interestSnapshot, type InterestScope } from './interestAnalysis'
import type { LibraryItem, YouTubeVideo } from './types'
interface Analysis { summary: string; bookPattern: string; videoPattern: string; differences: string[]; limitations: string }
const CACHE = 'mybooks-interests-v1'
export function InterestAnalysis({ items, videos, onClose }: { items: LibraryItem[]; videos: YouTubeVideo[]; onClose: () => void }) {
  const [scope, setScope] = useState<InterestScope>('all'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [cache, setCache] = useState<Record<string, Analysis>>(() => { try { return JSON.parse(localStorage.getItem(CACHE) || '{}') } catch { return {} } })
  const snapshot = useMemo(() => interestSnapshot(items, videos, scope), [items, videos, scope])
  const key = hash(JSON.stringify(snapshot)), result = cache[key]
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [onClose])
  const run = async () => {
    if (busy || result) return
    const controller = new AbortController(); abort.current = controller
    setBusy(true); setError('')
    try {
      const token = await drive.currentToken()
      const res = await fetch('/api/library-interests', { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]), headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(snapshot) })
      const data = await res.json().catch(() => null) as { analysis?: Analysis; error?: string } | null
      if (!res.ok || !data?.analysis) throw new Error(data?.error || '興味分析に失敗しました。再試行してください。')
      const next = Object.fromEntries([...Object.entries(cache).slice(-9), [key, data.analysis]])
      setCache(next)
      try { localStorage.setItem(CACHE, JSON.stringify(next)) } catch { /* Display still works when cache storage is full. */ }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof TypeError ? 'AIに接続できませんでした。ネットワークを確認してください。' : e instanceof Error && e.name === 'TimeoutError' ? '興味分析が時間内に終わりませんでした。再試行してください。' : e instanceof Error ? e.message : '興味分析に失敗しました。') }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="興味分析"><div className="modal-head"><h2><Sparkles /> あなたの関心</h2><button className="icon-btn" aria-label="閉じる" onClick={onClose}><X /></button></div><div className="video-detail">
    <div className="library-tabs" role="group" aria-label="興味分析の対象">{(['all', 'book', 'youtube'] as const).map(s => <button key={s} disabled={busy} aria-pressed={scope === s} className={scope === s ? 'active' : ''} onClick={() => { setScope(s); setError('') }}>{s === 'all' ? '両方' : s === 'book' ? '本だけ' : 'YouTubeだけ'}</button>)}</div>
    <p>{snapshot.total}件の分類を集計しています。未解析・未分類の動画も件数に含みます。</p>
    <h3>分類の割合</h3>{snapshot.categories.map(c => <div className="interest-row" key={c.category}><span>{c.category}</span><progress max={100} value={c.percentage} /><strong>{c.percentage}%</strong><small>{c.count}件</small></div>)}
    <button className="primary-btn" disabled={busy || !!result || !snapshot.total} onClick={() => void run()}><Sparkles />{busy ? '分析中…' : result ? '保存済みのAI分析を表示中' : 'AIで関心と本・動画の違いを分析'}</button><p><small>AIには分類集計と媒体ごと最大30件のサンプルを送信します。分類の割合は全件から算出します。同じデータの結果は再利用します。</small></p>
    {error && <p role="alert">{error}</p>}{result && <><h3>あなたの関心</h3><p>{result.summary}</p><h4>本の選び方</h4><p>{result.bookPattern}</p><h4>YouTubeの選び方</h4><p>{result.videoPattern}</p><h4>本とYouTubeの違い</h4><ul>{result.differences.map((d, i) => <li key={i}>{d}</li>)}</ul><small>{result.limitations}</small></>}
  </div></section></div>
}
