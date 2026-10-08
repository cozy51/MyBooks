// 本の分類マップのデータ処理。
// 「タイトル＋要約」をEmbeddingでベクトル化し、UMAPで2次元に配置する。
// 結果（ベクトルと座標）はブラウザの IndexedDB と Google Drive の MyBooks-map.json に保存して再利用し、
// タイトルか要約が変わった本だけを再計算する。
import * as drive from './drive'
import { dequantize, driveJsonFile, EmbedError, fetchEmbeddings, hash, loadLocal, quantize, saveLocal, type VectorEntry } from './embeddingStore'
import type { Book } from './types'

export { EmbedError }

export const MAP_FILE_NAME = 'MyBooks-map.json'
const DB_KEY = 'book-map-v1'
const remoteFile = driveJsonFile<MapCache>(MAP_FILE_NAME, 'mybooks-map-drive-v1')
const BATCH = 100
/** 前回のUMAP以降に補間で配置した冊数がこれを超えたら、全体を配置し直す */
const relayoutThreshold = (size: number) => Math.max(20, Math.round(size * 0.15))

export type MapEntry = VectorEntry
export interface MapCache {
  version: 1
  /** Embeddingのモデル（例: gemini:gemini-embedding-001:256）。異なるモデルのベクトルは混ぜない */
  model: string
  updatedAt: string
  entries: Record<string, MapEntry>
  /** 本ごとの2次元座標（おおむね -1〜1） */
  layout: Record<string, [number, number]>
  layoutAt: string
  /** 前回UMAPで配置したときの冊数と、その後に補間で追加配置した冊数 */
  layoutSize: number
  placed: number
}

async function loadRemote(token: string): Promise<MapCache | null> {
  const data = await remoteFile.load(token)
  return data?.version === 1 && data.entries && data.layout ? data : null
}

const emptyCache = (): MapCache => ({ version: 1, model: '', updatedAt: '', entries: {}, layout: {}, layoutAt: '', layoutSize: 0, placed: 0 })

/** Embeddingに使うテキスト。要約が空ならタイトルだけ、タイトルが無ければ対象外（null） */
export function embedText(book: Book): string | null {
  const title = book.title.trim()
  if (!title) return null
  const memo = book.memo.trim()
  return memo ? `${title}\n${memo}` : title
}

/** 2つのキャッシュをまとめる。新しい方を基準にし、足りないベクトルをもう一方から補う */
function mergeCaches(a: MapCache | null, b: MapCache | null, hashes: Map<string, string>): MapCache | null {
  if (!a || !b) return a ?? b
  const [base, other] = a.updatedAt >= b.updatedAt ? [a, b] : [b, a]
  if (base.model && other.model && base.model !== other.model) return base
  const merged: MapCache = { ...base, model: base.model || other.model, entries: { ...base.entries }, layout: { ...base.layout } }
  for (const [id, entry] of Object.entries(other.entries)) {
    const h = hashes.get(id)
    if (h && entry.h === h && merged.entries[id]?.h !== h) { merged.entries[id] = entry; delete merged.layout[id] }
  }
  return merged
}

// ---- 2次元への配置 ----

/**
 * 座標を中心0・広がりがおおむね -1〜1 になるようにそろえる（縦横比は保つ）。
 * 少数の外れ値で全体が小さく縮まないよう、上下2%を除いた範囲で縮尺を決め、はみ出す点は枠の少し外側までに寄せる
 */
function normalizeCoords(coords: number[][]): [number, number][] {
  const range = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b), q = (r: number) => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * r))]
    return values.length >= 50 ? [q(0.02), q(0.98)] : [sorted[0], sorted[sorted.length - 1]]
  }
  const [x0, x1] = range(coords.map(c => c[0])), [y0, y1] = range(coords.map(c => c[1]))
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, span = Math.max(x1 - x0, y1 - y0) / 2 || 1
  const clamp = (v: number) => Math.max(-1.08, Math.min(1.08, v))
  return coords.map(([x, y]) => [round(clamp((x - cx) / span)), round(clamp((y - cy) / span))])
}
const round = (v: number) => Math.round(v * 10000) / 10000

let worker: Worker | null = null
/** UMAPをWeb Workerで実行する（画面を固めないため） */
function runUmap(vectors: Float32Array[], onProgress: (ratio: number) => void): Promise<[number, number][]> {
  if (vectors.length < 4) return Promise.resolve(vectors.map((_, i) => { const a = (i / vectors.length) * Math.PI * 2; return [round(Math.cos(a) * 0.5), round(Math.sin(a) * 0.5)] }))
  worker?.terminate()
  const w = worker = new Worker(new URL('./umapWorker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<{ progress?: number; coords?: number[][] }>) => {
      if (e.data.coords) { w.terminate(); if (worker === w) worker = null; resolve(normalizeCoords(e.data.coords)) }
      else if (e.data.progress !== undefined) onProgress(e.data.progress)
    }
    w.onerror = e => { w.terminate(); if (worker === w) worker = null; reject(new Error(`配置の計算に失敗しました（${e.message}）`)) }
    w.postMessage({ vectors: vectors.map(v => Array.from(v)) })
  })
}

/** 新しく加わった本を、内容が近い本（上位8冊）の座標の重み付き平均の位置に置く */
function placeNear(vector: Float32Array, placed: { v: Float32Array; p: [number, number] }[], seed: string): [number, number] {
  const near = placed.map(item => { let s = 0; for (let i = 0; i < vector.length; i++) s += vector[i] * item.v[i]; return { s, p: item.p } })
    .sort((a, b) => b.s - a.s).slice(0, 8)
  let x = 0, y = 0, total = 0
  for (const { s, p } of near) { const w = Math.exp(s * 12); x += p[0] * w; y += p[1] * w; total += w }
  // 同じ位置に重ならないよう、本ごとに決まった小さなずれを加える
  const r = parseInt(seed.slice(-4), 36) || 0
  const jitter = 0.012
  return [round(x / total + Math.cos(r) * jitter), round(y / total + Math.sin(r) * jitter)]
}

// ---- 全体の流れ ----

export type MapPhase = 'loading' | 'embedding' | 'layout' | 'ready'
export interface MapProgress { phase: MapPhase; done?: number; total?: number }

export interface UpdateResult { cache: MapCache; error?: EmbedError; driveError?: string }

let memoryCache: MapCache | null = null
let remoteChecked = false

/**
 * 本の一覧からマップを更新する。
 * 1. 保存済みのキャッシュ（ブラウザ・Drive）を読み込む
 * 2. タイトル・要約が変わった本だけEmbeddingを計算
 * 3. 座標が無い本を配置（多ければUMAPで全体を配置し直す）
 * 4. 変化があれば保存
 */
export function updateBookMap(books: Book[], onProgress: (p: MapProgress) => void, opts: { relayout?: boolean } = {}): Promise<UpdateResult> {
  // マップ画面と本の詳細画面から同時に呼ばれても、キャッシュを取り違えないよう1つずつ実行する
  const result = updateQueue.then(() => updateBookMapNow(books, onProgress, opts))
  updateQueue = result.catch(() => undefined)
  return result
}
let updateQueue: Promise<unknown> = Promise.resolve()

async function updateBookMapNow(books: Book[], onProgress: (p: MapProgress) => void, opts: { relayout?: boolean }): Promise<UpdateResult> {
  const hashes = new Map<string, string>(), texts = new Map<string, string>()
  for (const book of books) { const text = embedText(book); if (text) { texts.set(book.id, text); hashes.set(book.id, hash(text)) } }

  let driveError: string | undefined
  if (!memoryCache) { onProgress({ phase: 'loading' }); memoryCache = await loadLocal<MapCache>(DB_KEY) }
  const token = drive.storedToken()
  if (token && !remoteChecked) {
    try { memoryCache = mergeCaches(memoryCache, await loadRemote(token), hashes); remoteChecked = true } catch (e) { driveError = e instanceof Error ? e.message : String(e) }
  }
  let cache: MapCache = memoryCache ? { ...memoryCache, entries: { ...memoryCache.entries }, layout: { ...memoryCache.layout } } : emptyCache()
  let changed = false

  // 削除された本・対象外になった本を取り除く
  for (const id of Object.keys(cache.entries)) if (!hashes.has(id)) { delete cache.entries[id]; delete cache.layout[id]; changed = true }
  for (const id of Object.keys(cache.layout)) if (!cache.entries[id]) { delete cache.layout[id]; changed = true }

  // Embedding（変わった本だけ）
  let error: EmbedError | undefined
  let missing = [...hashes.keys()].filter(id => cache.entries[id]?.h !== hashes.get(id))
  for (let i = 0; i < missing.length; i += BATCH) {
    onProgress({ phase: 'embedding', done: i, total: missing.length })
    const ids = missing.slice(i, i + BATCH)
    let result
    try { result = await fetchEmbeddings(ids.map(id => texts.get(id)!)) } catch (e) { error = e instanceof EmbedError ? e : new EmbedError(String(e)); break }
    if (cache.model && cache.model !== result.model) {
      // モデルが変わったら、以前のベクトルとは比べられないので全冊を計算し直す
      cache = { ...emptyCache(), model: result.model }
      missing = [...hashes.keys()]; i = -BATCH; changed = true
      continue
    }
    cache.model = result.model
    ids.forEach((id, j) => { cache.entries[id] = { h: hashes.get(id)!, e: quantize(result.vectors[j]) }; delete cache.layout[id] })
    changed = true
  }

  // 配置
  const ids = Object.keys(cache.entries)
  const unplaced = ids.filter(id => !cache.layout[id])
  const placedCount = ids.length - unplaced.length
  const needsFull = ids.length > 0 && (opts.relayout || placedCount === 0 || cache.placed + unplaced.length > relayoutThreshold(cache.layoutSize))
  if (needsFull) {
    onProgress({ phase: 'layout', done: 0, total: 100 })
    const coords = await runUmap(ids.map(id => dequantize(cache.entries[id].e)), r => onProgress({ phase: 'layout', done: Math.round(r * 100), total: 100 }))
    cache.layout = Object.fromEntries(ids.map((id, i) => [id, coords[i]]))
    cache.layoutAt = new Date().toISOString(); cache.layoutSize = ids.length; cache.placed = 0
    changed = true
  } else if (unplaced.length) {
    const placed = ids.filter(id => cache.layout[id]).map(id => ({ v: dequantize(cache.entries[id].e), p: cache.layout[id] }))
    for (const id of unplaced) cache.layout[id] = placeNear(dequantize(cache.entries[id].e), placed, cache.entries[id].h)
    cache.placed += unplaced.length
    changed = true
  }

  if (changed) {
    cache.updatedAt = new Date().toISOString()
    await saveLocal(DB_KEY, cache)
    const current = drive.storedToken()
    if (current) { try { await remoteFile.save(current, cache) } catch (e) { driveError = e instanceof Error ? e.message : String(e) } }
  }
  memoryCache = cache
  onProgress({ phase: 'ready' })
  return { cache, error, driveError }
}

/** Driveに接続し直したときなどに、Drive上のマップデータをもう一度確認する */
export function recheckRemote() { remoteChecked = false }

// ---- 類似する本 ----

/** 保存済みのマップデータ（ベクトル）を読み込む。マップを開いていなくても使える */
export async function loadMapCache(): Promise<MapCache | null> {
  memoryCache ??= await loadLocal<MapCache>(DB_KEY)
  return memoryCache
}

export interface SimilarBook { book: Book; score: number }

/**
 * 内容（タイトル＋要約）が近い本を、マップと同じEmbeddingのコサイン類似度で探す。
 * この本のEmbeddingがまだ無い（未計算・内容の変更後）ときは null
 */
export async function findSimilarBooks(book: Book, books: Book[], limit = 10): Promise<SimilarBook[] | null> {
  memoryCache ??= await loadLocal<MapCache>(DB_KEY)
  const text = embedText(book)
  const entry = text && memoryCache?.entries[book.id]
  if (!memoryCache || !entry || entry.h !== hash(text)) return null
  const target = dequantize(entry.e)
  const results: SimilarBook[] = []
  for (const other of books) {
    if (other.id === book.id) continue
    const otherText = embedText(other), e = otherText && memoryCache.entries[other.id]
    if (!e || e.h !== hash(otherText)) continue
    const v = dequantize(e.e)
    let score = 0
    for (let i = 0; i < v.length; i++) score += v[i] * target[i]
    results.push({ book: other, score })
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}
