// 本のEmbedding（ベクトル）を扱う共通処理。分類マップ（bookMapData）と意味検索（semanticSearch）で使う。
// ベクトルはブラウザの IndexedDB と Google Drive のJSONファイルに保存して再利用する。
import * as drive from './drive'

/** h: 元テキストのハッシュ / e: 正規化したベクトルを int8 に量子化して base64 にしたもの */
export interface VectorEntry { h: string; e: string }

/** 文字列の簡易ハッシュ（cyrb53）。テキストが変わったかの判定に使う */
export function hash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export function quantize(vector: number[]): string {
  const norm = Math.hypot(...vector) || 1
  const bytes = new Uint8Array(vector.length)
  vector.forEach((v, i) => { bytes[i] = Math.max(-127, Math.min(127, Math.round(v / norm * 127))) & 0xff })
  let binary = ''
  bytes.forEach(b => { binary += String.fromCharCode(b) })
  return btoa(binary)
}

/** 量子化したベクトルを、長さ1に正規化した Float32Array に戻す（内積＝コサイン類似度になる） */
export function dequantize(text: string): Float32Array {
  const binary = atob(text)
  const vector = new Float32Array(binary.length)
  let norm = 0
  for (let i = 0; i < binary.length; i++) { const v = (binary.charCodeAt(i) << 24 >> 24) / 127; vector[i] = v; norm += v * v }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < vector.length; i++) vector[i] /= norm
  return vector
}

/** 長さ1のベクトルどうしの内積（＝コサイン類似度） */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// ---- ブラウザ内の保存（IndexedDB。localStorageより大きなデータを置ける） ----

const DB_NAME = 'mybooks', DB_STORE = 'kv'
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
export async function loadLocal<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch { return null }
}
export async function saveLocal(key: string, value: unknown) {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch { /* 保存できなくても表示は続ける */ }
}

// ---- Google Drive への保存（別の端末でも再計算せずに使えるように） ----

interface DriveMeta { fileId?: string; modifiedTime?: string }

/** Drive上の1つのJSONファイル。metaKey には前回読み書きしたファイルIDと更新日時を localStorage に覚える */
export function driveJsonFile<T>(fileName: string, metaKey: string) {
  const meta = (): DriveMeta => { try { return JSON.parse(localStorage.getItem(metaKey) || '{}') } catch { return {} } }
  const setMeta = (value: DriveMeta) => { try { localStorage.setItem(metaKey, JSON.stringify(value)) } catch { /* noop */ } }
  return {
    /** Drive上のデータ。前回読み書きしたものから変わっていなければ null */
    async load(token: string): Promise<T | null> {
      const file = await drive.findNamedFile(token, fileName)
      if (!file) return null
      const m = meta()
      if (m.fileId === file.id && m.modifiedTime === file.modifiedTime) return null
      const data = await drive.readJsonFile<T>(token, file.id)
      setMeta({ fileId: file.id, modifiedTime: file.modifiedTime })
      return data
    },
    async save(token: string, data: T) {
      let id = meta().fileId
      try { if (id) { setMeta(await drive.writeJsonFile(token, fileName, data, id)); return } } catch (e) { if (e instanceof drive.DriveAuthError) throw e }
      // ファイルが削除されていた場合などは、フォルダから探し直すか新しく作る
      id = (await drive.findNamedFile(token, fileName))?.id
      const file = await drive.writeJsonFile(token, fileName, data, id)
      setMeta({ fileId: file.id, modifiedTime: file.modifiedTime })
    },
  }
}

// ---- Embedding（サーバーの /api/embed 経由。APIキーはブラウザに置かない） ----

export class EmbedError extends Error {
  code: string
  constructor(message: string, code = '') { super(message); this.code = code }
}

/** clustering: 分類マップ / document: 検索される本 / query: 検索文 */
export type EmbedTask = 'clustering' | 'document' | 'query'

export async function fetchEmbeddings(texts: string[], opts: { task?: EmbedTask; dimensions?: number } = {}): Promise<{ model: string; vectors: number[][] }> {
  for (let attempt = 0; ; attempt++) {
    const token = drive.storedToken()
    let res: Response
    try {
      res = await fetch('/api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ texts, ...opts }) })
    } catch { throw new EmbedError('Embedding APIに接続できませんでした。ネットワークを確認してください。', 'network') }
    const data = await res.json().catch(() => null) as { model?: string; vectors?: number[][]; error?: string; code?: string } | null
    if (res.ok && data?.model && data.vectors?.length === texts.length) return { model: data.model, vectors: data.vectors }
    if (res.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, 5000 * 2 ** attempt)); continue }
    if (res.status === 404 && !data) throw new EmbedError('Embedding API（/api/embed）が見つかりません。Vercelへのデプロイ、または npm run dev で起動してください。', 'not_found')
    throw new EmbedError(data?.error || `Embedding APIの呼び出しに失敗しました（${res.status}）`, data?.code)
  }
}
