import { useEffect, useState } from 'react'
import { embedText, loadMapCache } from './bookMapData'
import { dequantize } from './embeddingStore'
import { computeAxisScores, loadAxisRefs } from './semanticAxes'
import type { Book } from './types'

/** 意味軸スコア [横, 縦]。横は +1 に近いほど技術寄り、縦は +1 に近いほど実践寄り */
export type AxisScore = [number, number]

/**
 * 意味軸スコアを、両端に対する割合（%）で示す（表示モードに関係なく同じ値）。
 * ライブラリ全体の中央値が50%で、どちらかの端に寄るほどその側の割合が大きくなる
 */
export function AxisMeters({ score, className = 'map-tooltip-axes' }: { score: AxisScore; className?: string }) {
  const pct = (v: number) => Math.round(Math.max(0, Math.min(1, (v + 1) / 2)) * 100)
  const rows = [{ left: '社会', right: '技術', value: pct(score[0]) }, { left: '理論', right: '実践', value: pct(score[1]) }]
  return <div className={className}>
    {rows.map(r => <div key={r.left} title={`${r.left} ${100 - r.value}% ・ ${r.right} ${r.value}%`}>
      <span className={r.value < 50 ? 'strong' : ''}>{r.left} {100 - r.value}%</span>
      <i><b style={{ left: `${r.value}%` }} /></i>
      <span className={r.value > 50 ? 'strong' : ''}>{r.value}% {r.right}</span>
    </div>)}
  </div>
}

/**
 * 本の詳細画面に出す意味軸メーター。分類マップと同じデータ・同じ計算（ライブラリ全体の中での相対位置）で求めるので、
 * マップのツールチップと同じ値になる。まだマップで計算されていない本では何も表示しない
 */
export function BookAxisMeters({ book, items }: { book: Book; items: Book[] }) {
  const [result, setResult] = useState<{ id: string; score: AxisScore | null } | null>(null)
  useEffect(() => {
    let active = true
    void (async () => {
      const cache = await loadMapCache()
      if (!cache?.model || !cache.entries[book.id] || !embedText(book)) return null
      const refs = await loadAxisRefs(cache.model)
      const list = items.flatMap(b => { const entry = cache.entries[b.id]; return entry && embedText(b) ? [{ id: b.id, vector: dequantize(entry.e), categoryId: b.categoryId, video: 'type' in b && b.type === 'youtube' }] : [] })
      return computeAxisScores(list, refs).get(book.id) ?? null
    })().catch(() => null).then(score => { if (active) setResult({ id: book.id, score }) })
    return () => { active = false }
  }, [book, items])
  const score = result?.id === book.id ? result.score : null
  if (!score) return null
  return <div className="book-axes" title="分類マップの「意味軸で配置」と同じ値です（ライブラリ全体の中での相対的な位置）">
    <small>意味軸（分類マップ）</small>
    <AxisMeters score={score} className="map-tooltip-axes book-axes-meters" />
  </div>
}
