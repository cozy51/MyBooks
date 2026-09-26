// Google Drive へのデータ保存。
// Google Identity Services でアクセストークンを取得し、Drive API v3 で
// マイドライブ上の JSON ファイル1つに本棚全体を保存する。
// スコープは drive.file（このアプリが作成したファイルにだけアクセスできる）。
import type { Book } from './types'

export const DRIVE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || ''
export const DRIVE_FILE_NAME = 'MyBooks-library.json'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const TOKEN_KEY = 'mybooks-drive-token'
const API = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

export interface DriveFile { id: string; modifiedTime: string }
export class DriveAuthError extends Error {}

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }
interface TokenClient { callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void; requestAccessToken: (o?: { prompt?: string }) => void }
declare global {
  interface Window { google?: { accounts: { oauth2: {
    initTokenClient: (c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }) => TokenClient
    revoke: (token: string, done?: () => void) => void
  } } } }
}

let gisPromise: Promise<void> | null = null
function loadGis() {
  gisPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => { gisPromise = null; reject(new Error('Googleのログイン機能を読み込めませんでした')) }
    document.head.appendChild(script)
  })
  return gisPromise
}

/** セッション中に保持しているトークン（期限切れなら null） */
export function storedToken(): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null') as { token: string; expiresAt: number } | null
    return saved && saved.expiresAt > Date.now() + 60_000 ? saved.token : null
  } catch { return null }
}

export function clearToken() { try { sessionStorage.removeItem(TOKEN_KEY) } catch { /* noop */ } }

let tokenClient: TokenClient | null = null
/** Googleアカウントでログインしてアクセストークンを取得する（ボタン操作から呼ぶこと） */
export async function signIn(): Promise<string> {
  await loadGis()
  const oauth = window.google?.accounts.oauth2
  if (!oauth) throw new Error('Googleのログイン機能を読み込めませんでした')
  return new Promise((resolve, reject) => {
    tokenClient ??= oauth.initTokenClient({ client_id: DRIVE_CLIENT_ID, scope: SCOPE, callback: () => {} })
    tokenClient.callback = r => {
      if (!r.access_token) return reject(new Error(r.error_description || r.error || 'ログインできませんでした'))
      try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 })) } catch { /* noop */ }
      resolve(r.access_token)
    }
    tokenClient.error_callback = e => reject(new Error(e.type === 'popup_closed' ? 'ログインがキャンセルされました' : 'ログイン画面を開けませんでした（ポップアップの許可を確認してください）'))
    tokenClient.requestAccessToken({ prompt: '' })
  })
}

export function signOut() {
  const token = storedToken()
  clearToken()
  if (token) window.google?.accounts.oauth2.revoke(token)
}

async function call(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
  if (res.status === 401) { clearToken(); throw new DriveAuthError('Googleのログインの有効期限が切れました') }
  return res
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`Google Driveとの通信に失敗しました（${res.status}）`)
  return res.json() as Promise<T>
}

/** 指定IDのファイル。削除済み・見つからない場合は null */
export async function getFile(token: string, id: string): Promise<DriveFile | null> {
  const res = await call(token, `${API}/${id}?fields=id,modifiedTime,trashed`)
  if (res.status === 404) return null
  const file = await json<DriveFile & { trashed: boolean }>(res)
  return file.trashed ? null : file
}

/** このアプリが作成した保存ファイルを探す */
export async function findFile(token: string): Promise<DriveFile | null> {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`)
  const res = await call(token, `${API}?q=${q}&spaces=drive&orderBy=modifiedTime desc&pageSize=1&fields=files(id,modifiedTime)`)
  return (await json<{ files: DriveFile[] }>(res)).files[0] ?? null
}

export async function download(token: string, id: string): Promise<Book[]> {
  const data = await json<unknown>(await call(token, `${API}/${id}?alt=media`))
  const books = Array.isArray(data) ? data : (data as { books?: unknown }).books
  if (!Array.isArray(books)) throw new Error('Google Driveのファイルの形式が正しくありません')
  return books as Book[]
}

const body = (books: Book[]) => JSON.stringify({ version: 1, savedAt: new Date().toISOString(), books }, null, 2)

export async function create(token: string, books: Book[]): Promise<DriveFile> {
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' })], { type: 'application/json' }))
  form.append('file', new Blob([body(books)], { type: 'application/json' }))
  return json(await call(token, `${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', body: form }))
}

export async function update(token: string, id: string, books: Book[]): Promise<DriveFile> {
  return json(await call(token, `${UPLOAD}/${id}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body(books) }))
}
