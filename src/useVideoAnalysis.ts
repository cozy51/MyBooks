import { useEffect, useRef, useState } from 'react'
import * as drive from './drive'
import type { YouTubeVideo } from './types'
export function useVideoAnalysis(current: React.RefObject<YouTubeVideo[]>, update: (v: YouTubeVideo) => void) {
  const [pending, setPending] = useState<Set<string>>(new Set()), [message, setMessage] = useState(''), [failures, setFailures] = useState<Record<string, string>>({})
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const run = async (requested: YouTubeVideo[]) => {
    if (controller.current) return
    const ids = new Set(requested.map(v => v.videoId))
    const targets = current.current.filter(v => ids.has(v.videoId) && !v.analyzedAt)
    if (!targets.length) { setMessage('未解析の動画がありません。解析済みは再解析しません。'); return }
    if (targets.length > 1 && !confirm(`未解析の動画${targets.length}件をAI解析します。1件ずつ処理し、API料金が発生します。続けますか？`)) return
    const abort = new AbortController(); controller.current = abort
    setPending(new Set(targets.map(v => v.id)))
    let passed = 0, failed = 0
    try {
      for (const video of targets) {
        if (abort.signal.aborted) break
        setMessage(`AI解析中：${passed + failed + 1}/${targets.length}件（成功：${passed}件・失敗：${failed}件）`)
        try {
          const token = await drive.currentToken()
          const res = await fetch('/api/youtube-analyze', { method: 'POST', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(65_000)]), headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify({ videoId: video.videoId, title: video.title, channelTitle: video.channelTitle, description: video.description || '' }) })
          const data = await res.json().catch(() => null) as { analysis?: Partial<YouTubeVideo>; error?: string; code?: string } | null
          if (!res.ok || !data?.analysis?.summary) {
            const error = new Error(data?.error || '動画を解析できませんでした。再試行してください。')
            if ([401, 402, 429, 503].includes(res.status)) abort.abort()
            throw error
          }
          const latest = current.current.find(v => v.videoId === video.videoId)
          if (latest && !latest.analyzedAt) {
            const now = new Date().toISOString()
            // Only analysis fields may change. Identity and source metadata remain intact.
            const a = data.analysis
            update({ ...latest, summary: a.summary, keyPoints: a.keyPoints, category: a.category, subCategory: a.subCategory, tags: a.tags, concreteAbstractScore: a.concreteAbstractScore, technicalSocialScore: a.technicalSocialScore, recommendedFor: a.recommendedFor, aiComment: a.aiComment, embeddingText: a.embeddingText, analyzedAt: now, updatedAt: now })
          }
          passed++; setFailures(f => { const next = { ...f }; delete next[video.id]; return next })
        } catch (e) {
          if (abort.signal.aborted && e instanceof DOMException && e.name === 'AbortError') break
          failed++
          const error = e instanceof Error && !(e instanceof TypeError) ? e.name === 'TimeoutError' ? 'AI解析が時間内に終わりませんでした。再試行してください。' : e.message : 'AIに接続できませんでした。ネットワークを確認してください。'
          setFailures(f => ({ ...f, [video.id]: error }))
        } finally { setPending(s => { const next = new Set(s); next.delete(video.id); return next }) }
      }
      setMessage(`AI解析${abort.signal.aborted ? '停止' : '完了'}：成功 ${passed}件／失敗 ${failed}件／未実行 ${targets.length - passed - failed}件。失敗した動画は未解析のまま再試行できます。`)
    } finally { controller.current = null; setPending(new Set()) }
  }
  return { run, pending, message, failures, cancel: () => controller.current?.abort() }
}
