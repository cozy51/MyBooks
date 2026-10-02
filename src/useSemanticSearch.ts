import { useCallback, useEffect, useRef, useState } from 'react'
import type { EmbedError } from './embeddingStore'
import { currentIndex, embedQuery, rebuildSearchIndex, recheckSearchRemote, semanticScores, updateSearchIndex, wantsSemantic, type IndexProgress, type SearchIndex } from './semanticSearch'
import type { SyncStatus } from './useDriveSync'
import type { Book } from './types'

const QUERY_DELAY = 500
const INDEX_DELAY = 1500

export type SemanticState =
  | { status: 'off' }
  | { status: 'searching' }
  | { status: 'ready'; query: string; scores: Map<string, number> }
  | { status: 'error'; message: string; code: string }

/**
 * 意味検索の状態。
 * - 本の追加・編集のあと、検索用テキストが変わった本だけベクトルを更新する
 * - 検索文は入力が止まってから、検索文だけをEmbedding APIに送る
 */
export function useSemanticSearch(books: Book[], query: string, enabled: boolean, driveStatus: SyncStatus) {
  const [index, setIndex] = useState<SearchIndex | null>(null)
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  const [indexError, setIndexError] = useState<EmbedError | null>(null)
  // 検索文ごとの結果（どの検索文・どのインデックスに対する結果かを持ち、画面の状態はそこから決める）
  const [result, setResult] = useState<{ query: string; index: SearchIndex; state: SemanticState } | null>(null)
  const booksRef = useRef(books)
  useEffect(() => { booksRef.current = books }, [books])
  useEffect(() => { void currentIndex().then(saved => setIndex(i => i ?? saved)) }, [])

  // Google Driveに接続済み（またはDrive連携なし）のときだけ書籍側のベクトルを計算する（未ログインではAPIを使えないため）
  const connected = driveStatus === 'synced' || driveStatus === 'pending' || driveStatus === 'unavailable'
  const running = useRef(false), queued = useRef(false)
  const run = useCallback(async (rebuild = false) => {
    if (running.current) { queued.current = true; return }
    running.current = true
    try {
      for (let again = true; again; again = queued.current, queued.current = false) {
        const update = rebuild ? rebuildSearchIndex : updateSearchIndex
        rebuild = false
        const result = await update(booksRef.current, p => setProgress(p.done < p.total ? p : null))
        setIndex(result.index); setIndexError(result.error ?? null)
      }
    } finally { running.current = false; setProgress(null) }
  }, [])
  useEffect(() => {
    if (!enabled || !connected) return
    const timer = setTimeout(() => void run(), INDEX_DELAY)
    return () => clearTimeout(timer)
  }, [books, enabled, connected, run])
  useEffect(() => { if (connected) recheckSearchRemote() }, [connected])

  // 検索文のベクトル化と類似度の計算
  const text = query.trim()
  const active = enabled && wantsSemantic(text) && Boolean(index?.model)
  useEffect(() => {
    if (!active || !index) return
    let alive = true
    const timer = setTimeout(() => {
      embedQuery(text).then(({ model, vector }) => {
        if (!alive) return
        if (model !== index.model) { setResult({ query: text, index, state: { status: 'error', code: 'model', message: 'Embeddingのモデルが変わったため、意味検索のデータを作り直しています。しばらくしてからもう一度お試しください。' } }); void run(); return }
        setResult({ query: text, index, state: { status: 'ready', query: text, scores: semanticScores(index, booksRef.current, vector) } })
      }, (e: unknown) => {
        if (!alive) return
        const err = e as EmbedError
        setResult({ query: text, index, state: { status: 'error', message: err.message || String(e), code: err.code ?? '' } })
      })
    }, QUERY_DELAY)
    return () => { alive = false; clearTimeout(timer) }
  }, [active, text, index, run])
  // 本の編集でインデックスが更新されたときは、計算し直すまで前の結果を表示しておく（並びが一瞬崩れないように）
  const state: SemanticState = !active ? { status: 'off' } : result?.query === text ? result.state : { status: 'searching' }

  const indexed = index ? books.filter(b => index.entries[b.id]).length : 0
  return { state, progress, indexError, indexed, hasIndex: Boolean(index?.model), rebuild: () => void run(true) }
}
