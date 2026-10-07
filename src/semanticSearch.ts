// 意味検索（セマンティック検索）。
// 本ごとに「タイトル・著者・分類・要約」をまとめた検索用テキストをEmbeddingでベクトル化して保存しておき、
// 検索時は検索文だけをベクトル化して、保存済みのベクトルとのコサイン類似度で並べる。
// 分類マップ（bookMapData）のベクトル・座標とは別に、MyBooks-search.json と IndexedDB に保存する。
import * as drive from './drive'
import { categories } from './data'
import { dequantize, dot, driveJsonFile, EmbedError, fetchEmbeddings, hash, loadLocal, quantize, saveLocal, type VectorEntry } from './embeddingStore'
import type { Book, LibraryItem } from './types'

export const SEARCH_FILE_NAME = 'MyBooks-search.json'
const DB_KEY = 'search-index-v1'
const DIMENSIONS = 768
const BATCH = 100
const remoteFile = driveJsonFile<SearchIndex>(SEARCH_FILE_NAME, 'mybooks-search-drive-v1')

export interface SearchIndex {
  version: 1
  /** Embeddingのモデル（例: gemini:gemini-embedding-001:768）。検索文も同じモデルでベクトル化する */
  model: string
  updatedAt: string
  entries: Record<string, VectorEntry>
}
const emptyIndex = (): SearchIndex => ({ version: 1, model: '', updatedAt: '', entries: {} })

/** 分類の表示名（親分類 / 子分類） */
export function categoryName(id: string): string {
  const child = categories.find(c => c.id === id)
  const parent = categories.find(c => c.id === child?.parent)
  return [parent?.name, child?.name].filter(Boolean).join(' / ')
}

/** 検索用テキスト（タイトル・著者・分類・要約）。タイトルが無ければ対象外（null） */
export function searchText(book: Book): string | null {
  const title = book.title.trim()
  if (!title) return null
  const item = book as Partial<LibraryItem>
  return [title, book.author.trim(), categoryName(book.categoryId), book.memo.trim(), item.description?.trim(), item.tags?.join(' '), item.embeddingText?.trim()].filter(Boolean).join('\n')
}

// ---- 書籍側のベクトル（変わった本だけ計算する） ----

export interface IndexProgress { done: number; total: number }
export interface IndexResult { index: SearchIndex; error?: EmbedError; driveError?: string }

let memoryIndex: SearchIndex | null = null
let remoteChecked = false
let updateQueue: Promise<unknown> = Promise.resolve()

/** Driveに接続し直したときなどに、Drive上の検索データをもう一度確認する */
export function recheckSearchRemote() { remoteChecked = false }

/** 2つのインデックスをまとめる。新しい方を基準にし、今の本の内容と合うベクトルをもう一方から補う */
function mergeIndexes(a: SearchIndex | null, b: SearchIndex | null, hashes: Map<string, string>): SearchIndex | null {
  if (!a || !b) return a ?? b
  const [base, other] = a.updatedAt >= b.updatedAt ? [a, b] : [b, a]
  if (base.model && other.model && base.model !== other.model) return base
  const merged: SearchIndex = { ...base, model: base.model || other.model, entries: { ...base.entries } }
  for (const [id, entry] of Object.entries(other.entries)) {
    const h = hashes.get(id)
    if (h && entry.h === h && merged.entries[id]?.h !== h) merged.entries[id] = entry
  }
  return merged
}

/**
 * 本の一覧から検索用のベクトルを更新する。
 * 保存済み（ブラウザ・Drive）のベクトルを読み込み、検索用テキストが変わった本・追加された本だけEmbedding APIに送る
 */
export function updateSearchIndex(books: Book[], onProgress: (p: IndexProgress) => void = () => {}): Promise<IndexResult> {
  const result = updateQueue.then(() => updateNow(books, onProgress))
  updateQueue = result.catch(() => undefined)
  return result
}

async function updateNow(books: Book[], onProgress: (p: IndexProgress) => void): Promise<IndexResult> {
  const hashes = new Map<string, string>(), texts = new Map<string, string>()
  for (const book of books) { const text = searchText(book); if (text) { texts.set(book.id, text); hashes.set(book.id, hash(text)) } }

  let driveError: string | undefined
  memoryIndex ??= await loadLocal<SearchIndex>(DB_KEY)
  const token = drive.storedToken()
  if (token && !remoteChecked) {
    try {
      const remote = await remoteFile.load(token)
      memoryIndex = mergeIndexes(memoryIndex, remote?.version === 1 && remote.entries ? remote : null, hashes)
      remoteChecked = true
    } catch (e) { driveError = e instanceof Error ? e.message : String(e) }
  }
  let index: SearchIndex = memoryIndex ? { ...memoryIndex, entries: { ...memoryIndex.entries } } : emptyIndex()
  let changed = false

  for (const id of Object.keys(index.entries)) if (!hashes.has(id)) { delete index.entries[id]; changed = true }

  let error: EmbedError | undefined
  let missing = [...hashes.keys()].filter(id => index.entries[id]?.h !== hashes.get(id))
  for (let i = 0; i < missing.length; i += BATCH) {
    onProgress({ done: i, total: missing.length })
    const ids = missing.slice(i, i + BATCH)
    let result
    try { result = await fetchEmbeddings(ids.map(id => texts.get(id)!), { task: 'document', dimensions: DIMENSIONS }) } catch (e) { error = e instanceof EmbedError ? e : new EmbedError(String(e)); break }
    if (index.model && index.model !== result.model) {
      // モデルが変わったら、以前のベクトルとは比べられないので全冊を計算し直す
      index = { ...emptyIndex(), model: result.model }
      missing = [...hashes.keys()]; i = -BATCH; changed = true
      continue
    }
    index.model = result.model
    ids.forEach((id, j) => { index.entries[id] = { h: hashes.get(id)!, e: quantize(result.vectors[j]) } })
    changed = true
    // 途中で止まっても計算済みの分は使えるように、バッチごとにブラウザへ保存する
    memoryIndex = index
    await saveLocal(DB_KEY, { ...index, updatedAt: new Date().toISOString() })
  }

  if (changed) {
    index.updatedAt = new Date().toISOString()
    await saveLocal(DB_KEY, index)
    const current = drive.storedToken()
    if (current) { try { await remoteFile.save(current, index) } catch (e) { driveError = e instanceof Error ? e.message : String(e) } }
  }
  memoryIndex = index
  onProgress({ done: missing.length, total: missing.length })
  return { index, error, driveError }
}

/** 保存済みの検索用ベクトル（まだ読み込んでいなければブラウザから読む） */
export async function currentIndex(): Promise<SearchIndex | null> {
  memoryIndex ??= await loadLocal<SearchIndex>(DB_KEY)
  return memoryIndex
}

/** 検索用ベクトルを全冊計算し直す（モデルを変えずに作り直したいとき） */
export async function rebuildSearchIndex(books: Book[], onProgress?: (p: IndexProgress) => void): Promise<IndexResult> {
  await updateQueue
  memoryIndex = emptyIndex()
  remoteChecked = true // Drive上の古いデータで上書きしない
  return updateSearchIndex(books, onProgress)
}

// ---- 検索 ----

const queryCache = new Map<string, { model: string; vector: Float32Array }>()

/** 検索文をベクトル化する（同じ検索文は覚えておき、APIを呼ばない） */
export async function embedQuery(text: string): Promise<{ model: string; vector: Float32Array }> {
  const key = text.trim()
  const cached = queryCache.get(key)
  if (cached) return cached
  const { model, vectors } = await fetchEmbeddings([key], { task: 'query', dimensions: DIMENSIONS })
  const result = { model, vector: dequantize(quantize(vectors[0])) }
  queryCache.set(key, result)
  if (queryCache.size > 100) queryCache.delete(queryCache.keys().next().value!)
  return result
}

// 本のベクトルは検索のたびに展開しないよう、ハッシュごとに覚えておく
const vectorCache = new Map<string, { h: string; v: Float32Array }>()

/** 保存済みの本のベクトルと検索文のコサイン類似度（semanticScore）。ベクトルの無い本は含まない */
export function semanticScores(index: SearchIndex, books: Book[], query: Float32Array): Map<string, number> {
  const scores = new Map<string, number>()
  for (const book of books) {
    const entry = index.entries[book.id]
    if (!entry || entry.e.length === 0) continue
    let cached = vectorCache.get(book.id)
    if (!cached || cached.h !== entry.h) { cached = { h: entry.h, v: dequantize(entry.e) }; vectorCache.set(book.id, cached) }
    if (cached.v.length === query.length) scores.set(book.id, dot(cached.v, query))
  }
  return scores
}

// ---- キーワード一致（既存の文字列検索）とのハイブリッド ----

const normalize = (text: string) => text.normalize('NFKC').toLowerCase()

/**
 * キーワードの一致度（0〜1）。タイトルの完全一致 > タイトルの部分一致 > 著者 > そのほか（分類・要約・基準月）。
 * 空白で区切った語は、一部だけ一致しても少し加点する
 */
export function keywordScore(book: Book, query: string, haystack: string): number {
  const q = normalize(query.trim())
  if (!q) return 0
  const title = normalize(book.title.trim()), author = normalize(book.author)
  const compact = (s: string) => s.replace(/\s+/g, '')
  if (compact(title) === compact(q)) return 1
  if (title.includes(q)) return 0.85
  if (author.includes(q)) return 0.7
  if (normalize(haystack).includes(q)) return 0.5
  const words = q.split(/[\s、,，]+/).filter(Boolean)
  if (words.length < 2) return 0
  const text = normalize(haystack)
  const hits = words.filter(w => text.includes(w)).length
  return hits === words.length ? 0.45 : 0.3 * hits / words.length
}

/** 意味検索に向かない検索語（1文字だけ、基準月の YYYY-MM など）はキーワード検索だけにする */
export function wantsSemantic(query: string): boolean {
  const q = query.trim()
  return q.length >= 2 && !/^\d{4}(-\d{1,2})?$/.test(q)
}

export interface RankedBook { book: Book; semantic?: number; keyword: number; score: number }

/** 意味の近さを重視し、キーワードの一致を少し加点する */
const SEMANTIC_WEIGHT = 0.8, KEYWORD_WEIGHT = 0.2
/**
 * 意味だけで一致した本は、最上位からこの差までの本を、最大 SEMANTIC_LIMIT 冊まで結果に含める。
 * 1冊だけ飛び抜けて近いときでも、少なくとも SEMANTIC_MIN 冊は表示する
 */
const SEMANTIC_WINDOW = 0.12, SEMANTIC_LIMIT = 100, SEMANTIC_MIN = 10

/**
 * ハイブリッド検索の順位づけ。
 * キーワードが一致した本はすべて残し（従来の検索結果は消えない）、意味の近い本を加えて finalScore の高い順に並べる
 */
export function rankBooks(books: { book: Book; haystack: string }[], query: string, semantic: Map<string, number>): RankedBook[] {
  const items = books.map(({ book, haystack }) => ({ book, semantic: semantic.get(book.id), keyword: keywordScore(book, query, haystack) }))
  const semValues = items.flatMap(i => i.semantic === undefined ? [] : [i.semantic]).sort((a, b) => b - a)
  const top = semValues[0] ?? 0
  const nth = (n: number) => semValues[Math.min(n, semValues.length) - 1] ?? 0
  const cutoff = Math.min(Math.max(top - SEMANTIC_WINDOW, nth(SEMANTIC_LIMIT)), nth(SEMANTIC_MIN))
  return items
    .filter(i => i.keyword >= 0.45 || (i.semantic !== undefined && i.semantic >= cutoff))
    // ベクトルがまだ無い本は、キーワードの一致だけで意味検索の下限あたりに置く
    .map(i => ({ ...i, score: SEMANTIC_WEIGHT * (i.semantic ?? cutoff) + KEYWORD_WEIGHT * i.keyword }))
    .sort((a, b) => b.score - a.score)
}
