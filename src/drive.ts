// Google Drive へのデータ保存。
// Google Identity Services でアクセストークンを取得し、Drive API v3 で
// マイドライブ上の JSON ファイル1つに本棚全体を保存する。
// スコープは drive.file（このアプリが作成したファイルにだけアクセスできる）。
import type { Book } from './types'

export const DRIVE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || ''
export const DRIVE_API_KEY = import.meta.env.VITE_GOOGLE_API_KEY?.trim() || ''
export const DRIVE_APP_ID = import.meta.env.VITE_GOOGLE_APP_ID?.trim() || ''
export const DRIVE_FILE_NAME = 'MyBooks-library.json'
/** 本棚データを保存するフォルダ（マイドライブ > WebAppsData > MyBooks）。名前ではなくIDで指定する */
export const DATA_FOLDER_ID = import.meta.env.VITE_DRIVE_DATA_FOLDER_ID?.trim() || '12T2RtZHu_lpq8_zVeExmYHiAh_v7cKIW'
export const DATA_FOLDER_URL = `https://drive.google.com/drive/folders/${DATA_FOLDER_ID}`
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const TOKEN_KEY = 'mybooks-drive-token'
const API = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

export interface DriveFile { id: string; modifiedTime: string }
export class DriveAuthError extends Error {}
/** 保存先フォルダへのアクセスが許可されていない */
export class FolderAccessError extends Error {}

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }
interface TokenClient { callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void; requestAccessToken: (o?: { prompt?: string }) => void }
declare global {
  interface Window {
    google?: {
      accounts: { oauth2: {
        initTokenClient: (c: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }) => TokenClient
        revoke: (token: string, done?: () => void) => void
      } }
      picker?: PickerNamespace
    }
    gapi?: { load: (name: string, callback: () => void) => void }
  }
}

interface PickerResult { action: string; docs?: { id: string }[] }
interface PickerBuilder {
  addView(v: unknown): PickerBuilder; setOAuthToken(t: string): PickerBuilder; setDeveloperKey(k: string): PickerBuilder; setAppId(id: string): PickerBuilder
  setLocale(l: string): PickerBuilder; setTitle(t: string): PickerBuilder; setCallback(c: (r: PickerResult) => void): PickerBuilder
  build(): { setVisible(v: boolean): void }
}
interface DocsView { setParent(id: string): DocsView; setIncludeFolders(v: boolean): DocsView; setMode(m: string): DocsView; setMimeTypes(m: string): DocsView; setSelectFolderEnabled(v: boolean): DocsView; setFileIds?(ids: string): DocsView }
interface PickerNamespace {
  PickerBuilder: new () => PickerBuilder
  DocsView: new (viewId?: string) => DocsView
  ViewId: { DOCS_IMAGES: string; FOLDERS: string }
  DocsViewMode: { GRID: string }
  Action: { PICKED: string; CANCEL: string }
}

const scripts = new Map<string, Promise<void>>()
function loadScript(src: string) {
  let promise = scripts.get(src)
  if (!promise) {
    promise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = src
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => { scripts.delete(src); reject(new Error('Googleの機能を読み込めませんでした')) }
      document.head.appendChild(script)
    })
    scripts.set(src, promise)
  }
  return promise
}
const loadGis = () => loadScript('https://accounts.google.com/gsi/client')

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

/** 指定IDの保存ファイル。削除済み・見つからない・保存先フォルダ外の場合は null */
export async function getFile(token: string, id: string): Promise<DriveFile | null> {
  const res = await call(token, `${API}/${id}?fields=id,modifiedTime,trashed,parents`)
  if (res.status === 404) return null
  const file = await json<DriveFile & { trashed: boolean; parents?: string[] }>(res)
  return file.trashed || !file.parents?.includes(DATA_FOLDER_ID) ? null : { id: file.id, modifiedTime: file.modifiedTime }
}

/** 保存先フォルダ内の保存ファイルを探す（複数ある場合は最初に作られたもの） */
export async function findFile(token: string): Promise<DriveFile | null> {
  const q = encodeURIComponent(`'${DATA_FOLDER_ID}' in parents and name='${DRIVE_FILE_NAME}' and trashed=false`)
  const res = await call(token, `${API}?q=${q}&spaces=drive&orderBy=createdTime&pageSize=1&fields=files(id,modifiedTime)`)
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
  form.append('metadata', new Blob([JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json', parents: [DATA_FOLDER_ID] })], { type: 'application/json' }))
  form.append('file', new Blob([body(books)], { type: 'application/json' }))
  const res = await call(token, `${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', body: form })
  // drive.file スコープでは、アプリに許可されていないフォルダにはファイルを作れない
  if (res.status === 403 || res.status === 404) throw new FolderAccessError('保存先のMyBooksフォルダへのアクセスが許可されていません')
  return json(res)
}

export async function update(token: string, id: string, books: Book[]): Promise<DriveFile> {
  return json(await call(token, `${UPLOAD}/${id}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body(books) }))
}

async function openPicker(build: (picker: PickerNamespace) => { view: DocsView; title: string }): Promise<string | null> {
  const token = storedToken() ?? await signIn()
  await loadScript('https://apis.google.com/js/api.js')
  await new Promise<void>(resolve => window.gapi!.load('picker', resolve))
  const picker = window.google?.picker
  if (!picker) throw new Error('Googleのファイル選択画面を読み込めませんでした')
  const { view, title } = build(picker)
  return new Promise(resolve => {
    const builder = new picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(DRIVE_API_KEY).setLocale('ja').setTitle(title)
    if (DRIVE_APP_ID) builder.setAppId(DRIVE_APP_ID)
    builder.setCallback(r => {
      if (r.action === picker.Action.PICKED) resolve(r.docs?.[0]?.id ?? null)
      else if (r.action === picker.Action.CANCEL) resolve(null)
    }).build().setVisible(true)
  })
}

/** Google Picker で指定フォルダの画像を1つ選び、そのファイルIDを返す（キャンセル時は null） */
export function pickImage(folderId: string): Promise<string | null> {
  return openPicker(picker => ({
    view: new picker.DocsView(picker.ViewId.DOCS_IMAGES).setParent(folderId).setIncludeFolders(false).setMode(picker.DocsViewMode.GRID),
    title: '表紙画像を選択',
  }))
}

/** 保存先フォルダをPickerで選んでもらい、このアプリにそのフォルダへのアクセスを許可する */
export async function grantFolderAccess(): Promise<boolean> {
  if (!DRIVE_API_KEY || !DRIVE_APP_ID) throw new Error('フォルダの許可には VITE_GOOGLE_API_KEY と VITE_GOOGLE_APP_ID の設定が必要です（READMEを参照）')
  const id = await openPicker(picker => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setMimeTypes('application/vnd.google-apps.folder')
    return { view: view.setFileIds?.(DATA_FOLDER_ID) ?? view, title: '「MyBooks」フォルダを選んで「選択」を押してください' }
  })
  if (id === null) return false
  if (id !== DATA_FOLDER_ID) throw new Error('選んだフォルダが保存先のMyBooksフォルダではありません。もう一度お試しください')
  return true
}
