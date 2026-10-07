// AI選書。ユーザーが文章で書いた「今知りたいこと・困っていること」に合う本を、登録済みの本から選ぶ。
// 1. 意味検索と同じEmbedding（タイトル・著者・分類・要約）で、入力文と意味の近い本を候補として絞り込む（既存の意味検索のデータをそのまま使う）
// 2. 候補の本のデータ（タイトル・著者・分類・要約）だけを /api/ai-picks に渡し、AIが関連度・選定理由・関連するテーマ・得られそうなことを作る
//    （AIが本の内容を推測しないよう、根拠は MyBooks に保存されたデータだけに限る。要約からの抜き出しはサーバーで照合する）
import * as drive from './drive'
import { EmbedError } from './embeddingStore'
import { categoryName, embedQuery, semanticScores, updateSearchIndex, type IndexProgress } from './semanticSearch'
import type { Book } from './types'

/** AIに渡す候補の冊数（意味の近い順） */
const CANDIDATES = 15
export const MAX_QUERY = 1000

export interface PickTheme { interest: string; theme: string }
export interface AiPick {
  book: Book
  /** AIが判断した関連度（0〜100） */
  relevance: number
  /** 入力文と本のEmbeddingのコサイン類似度 */
  similarity?: number
  reason: string
  themes: PickTheme[]
  benefits: string[]
  /** 選定の根拠にした要約の部分（要約に実際に含まれる文だけ） */
  evidence: string[]
}

export type PickStage = { stage: 'index'; progress: IndexProgress | null } | { stage: 'search' } | { stage: 'ai'; candidates: number }

export class PickError extends Error {
  code: string
  constructor(message: string, code = '') { super(message); this.code = code }
}

/** 入力文に合う本を選ぶ */
export async function pickBooks(query: string, books: Book[], onStage: (s: PickStage) => void = () => {}, signal?: AbortSignal, indexItems: Book[] = books): Promise<AiPick[]> {
  const text = query.trim().slice(0, MAX_QUERY)
  if (!text) throw new PickError('知りたいことを入力してください。')
  const titled = books.filter(b => b.title.trim())
  if (!titled.length) throw new PickError('タイトルが登録された本がまだありません。', 'no_books')

  // 1. 書籍側のベクトル（意味検索と共通）を最新にする。追加・編集された本だけ計算する
  onStage({ stage: 'index', progress: null })
  const { index, error } = await updateSearchIndex(indexItems, p => onStage({ stage: 'index', progress: p.done < p.total ? p : null }))
  signal?.throwIfAborted()
  if (!index.model) throw new PickError(error?.message || '意味検索のデータを準備できませんでした。', error?.code)

  // 2. 入力文をベクトル化し、意味の近い本を候補にする
  onStage({ stage: 'search' })
  let vector: Float32Array
  try {
    const result = await embedQuery(text)
    if (result.model !== index.model) throw new PickError('Embeddingのモデルが変わったため、意味検索のデータを作り直しています。しばらくしてからもう一度お試しください。', 'model')
    vector = result.vector
  } catch (e) { throw e instanceof EmbedError ? new PickError(e.message, e.code) : e }
  signal?.throwIfAborted()
  const scores = semanticScores(index, titled, vector)
  const ranked = titled.filter(b => scores.has(b.id)).sort((a, b) => scores.get(b.id)! - scores.get(a.id)!)
  const candidates = balancedCandidates(ranked, CANDIDATES)
  if (!candidates.length) throw new PickError('意味検索のデータがある本がまだありません。しばらくしてからもう一度お試しください。')

  // 3. 候補の本のデータだけをAIに渡して選んでもらう
  onStage({ stage: 'ai', candidates: candidates.length })
  const token = drive.storedToken()
  let res: Response
  try {
    // サーバーは50秒で打ち切って応答するが、通信が切れた場合にも待ち続けないよう65秒で止める
    res = await fetch('/api/ai-picks', {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        query: text,
        books: candidates.map(b => ({ id: b.id, title: b.title.trim(), author: b.author.trim(), category: categoryName(b.categoryId), type: 'type' in b && b.type === 'youtube' ? 'youtube' : 'book', summary: recommendationSummary(b), similarity: Math.round(scores.get(b.id)! * 1000) / 1000 })),
      }),
    })
  } catch (e) {
    if (signal?.aborted) throw e
    if (e instanceof Error && e.name === 'TimeoutError') throw new PickError('AI選書が時間内に終わりませんでした。もう一度お試しください。', 'timeout')
    throw new PickError('AI選書のAPIに接続できませんでした。ネットワークを確認してください。', 'network')
  }
  const data = await res.json().catch(() => null) as { picks?: (Omit<AiPick, 'book' | 'similarity'> & { id: string })[]; error?: string; code?: string } | null
  if (res.status === 404 && !data) throw new PickError('AI選書のAPI（/api/ai-picks）が見つかりません。Vercelへのデプロイ、または npm run dev で起動してください。', 'not_found')
  if (!res.ok || !data?.picks) throw new PickError(data?.error || `AI選書に失敗しました（${res.status}）`, data?.code)
  const byId = new Map(candidates.map(b => [b.id, b]))
  return data.picks.flatMap(p => {
    const book = byId.get(p.id)
    return book ? [{ book, relevance: p.relevance, similarity: scores.get(book.id), reason: p.reason, themes: p.themes ?? [], benefits: p.benefits ?? [], evidence: p.evidence ?? [] }] : []
  })
}

/** Keep both media represented in the candidate pool without inventing relevance. */
export function balancedCandidates(ranked: Book[], limit: number): Book[] {
  const videos = ranked.filter(b => 'type' in b && b.type === 'youtube')
  const books = ranked.filter(b => !('type' in b) || b.type !== 'youtube')
  if (!videos.length || !books.length) return ranked.slice(0, limit)
  const half = Math.floor(limit / 2)
  const selected = new Set([...videos.slice(0, half), ...books.slice(0, half)])
  for (const item of ranked) { if (selected.size >= limit) break; selected.add(item) }
  return ranked.filter(b => selected.has(b))
}
export function recommendationSummary(book: Book): string {
  const item = book as Book & { description?: string; tags?: string[] }
  return [book.memo.trim(), item.description ? `概要欄: ${item.description.slice(0, 2500)}` : '', item.tags?.length ? `タグ: ${item.tags.join('・')}` : ''].filter(Boolean).join('\n')
}
