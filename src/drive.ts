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
/** 全ページスキャンなど、アプリが作っていないファイルを読むための読み取り専用スコープ（要約のときだけ求める） */
const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const READ_TOKEN_KEY = 'mybooks-drive-read-token'
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'
const YOUTUBE_TOKEN_KEY = 'mybooks-youtube-token'
const API = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

export interface DriveFile { id: string; modifiedTime: string }
export class DriveAuthError extends Error {}
/** 保存先フォルダへのアクセスが許可されていない */
export class FolderAccessError extends Error {}

interface TokenResponse { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }
interface TokenClient { callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void; requestAccessToken: (o?: { prompt?: string }) => void }
interface CodeResponse { code?: string; scope?: string; error?: string; error_description?: string }
interface CodeClient { requestCode: () => void }
declare global {
  interface Window {
    google?: {
      accounts: { oauth2: {
        initTokenClient: (c: { client_id: string; scope: string; include_granted_scopes?: boolean; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }) => TokenClient
        initCodeClient: (c: { client_id: string; scope: string; ux_mode: 'popup'; include_granted_scopes?: boolean; callback: (r: CodeResponse) => void; error_callback?: (e: { type: string }) => void }) => CodeClient
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
  ViewId: { DOCS: string; DOCS_IMAGES: string; FOLDERS: string }
  DocsViewMode: { GRID: string; LIST: string }
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

function savedToken(key: string): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null') as { token: string; expiresAt: number } | null
    return saved && saved.expiresAt > Date.now() + 60_000 ? saved.token : null
  } catch { return null }
}

/** セッション中に保持しているトークン（期限切れなら null） */
export const storedToken = () => savedToken(TOKEN_KEY)
/** セッション中に保持している、読み取り専用スコープ付きのトークン（期限切れなら null） */
export const storedReadToken = () => savedToken(READ_TOKEN_KEY)

export const storedYouTubeToken = () => savedToken(YOUTUBE_TOKEN_KEY)
export function clearYouTubeToken() { sessionStorage.removeItem(YOUTUBE_TOKEN_KEY) }

export function clearToken() { try { sessionStorage.removeItem(YOUTUBE_TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(READ_TOKEN_KEY) } catch { /* noop */ } }

/** 受け取ったトークンを保存する（読み取り専用の権限も含んでいれば、要約用のトークンとしても使う） */
function saveToken(token: string, expiresIn: number | undefined, scope: string | undefined, key?: string) {
  const value = JSON.stringify({ token, expiresAt: Date.now() + (expiresIn ?? 3600) * 1000 })
  // YouTubeのトークンはDriveの保存・自動更新・通知に使用しない。
  const keys = key === YOUTUBE_TOKEN_KEY ? [YOUTUBE_TOKEN_KEY] : [TOKEN_KEY, ...(scope?.split(' ').includes(READ_SCOPE) ? [READ_TOKEN_KEY] : []), ...(key ? [key] : [])]
  try { for (const k of keys) sessionStorage.setItem(k, value) } catch { /* noop */ }
  if (key !== YOUTUBE_TOKEN_KEY) for (const listener of tokenListeners) listener(token)
}

// ---- ログインを保つ仕組み（サーバーの /api/auth がリフレッシュトークンを Cookie に保管する） ----
// ブラウザだけで受け取るトークンは1時間で切れるので、サーバーで新しいトークンを発行してもらい、ログインが切れないようにする。
// サーバーに GOOGLE_CLIENT_SECRET が設定されていなければ（not_configured）、従来どおりブラウザだけでログインする。
let serverAuth: boolean | undefined
let refreshing: Promise<string | null> | null = null
const tokenListeners = new Set<(token: string) => void>()
/** トークンを新しく受け取ったときに呼ばれる（自動更新・再接続で Drive の同期をやり直すため） */
export function onToken(listener: (token: string) => void) { tokenListeners.add(listener); return () => { tokenListeners.delete(listener) } }

async function authApi(body: object): Promise<{ status: number; data: TokenResponse & { code?: string } }> {
  const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

/** サーバーに保管したログインで、画面を出さずに新しいトークンを受け取る（ログインしていなければ null） */
export function refreshToken(): Promise<string | null> {
  if (!DRIVE_CLIENT_ID || serverAuth === false) return Promise.resolve(null)
  refreshing ??= (async () => {
    try {
      const { status, data } = await authApi({ action: 'refresh' })
      if (status === 501 || status === 404 || status === 405) { serverAuth = false; return null }
      serverAuth = true
      if (status !== 200 || !data.access_token) return null
      saveToken(data.access_token, data.expires_in, data.scope)
      return data.access_token
    } catch { return null } finally { refreshing = null }
  })()
  return refreshing
}

/** 使えるトークン。切れていれば、画面を出さずに受け取り直す（それでもなければ null） */
export async function currentToken(): Promise<string | null> {
  return storedToken() ?? await refreshToken()
}

// トークンが切れる5分前に、自動で受け取り直す
if (typeof window !== 'undefined' && DRIVE_CLIENT_ID) {
  setInterval(() => {
    if (serverAuth === false) return
    try {
      const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null') as { expiresAt: number } | null
      if (saved && saved.expiresAt - Date.now() < 5 * 60_000) void refreshToken()
    } catch { /* noop */ }
  }, 60_000)
}

/** ログイン画面（ポップアップ）を出して、サーバーにログインを保管してもらう */
async function signInWithServer(scope: string): Promise<string> {
  await loadGis()
  const oauth = window.google?.accounts.oauth2
  if (!oauth) throw new Error('Googleのログイン機能を読み込めませんでした')
  const code = await new Promise<string>((resolve, reject) => {
    oauth.initCodeClient({
      client_id: DRIVE_CLIENT_ID, scope, ux_mode: 'popup', include_granted_scopes: false,
      callback: r => r.code ? resolve(r.code) : reject(new Error('Googleの認証に失敗しました。もう一度ログインしてください。')),
      error_callback: e => reject(new Error(e.type === 'popup_closed' ? 'ログインがキャンセルされました' : 'ログイン画面を開けませんでした（ポップアップの許可を確認してください）')),
    }).requestCode()
  })
  const { status, data } = await authApi({ action: 'exchange', code })
  if (status !== 200 || !data.access_token) throw new Error((data as { error?: string }).error || `ログインできませんでした（${status}）`)
  saveToken(data.access_token, data.expires_in, data.scope)
  return data.access_token
}

const tokenClients = new Map<string, TokenClient>()
async function requestToken(scope: string, key: string): Promise<string> {
  // サーバーにログインを保管できるなら、そちらを使う（一度ログインすれば、それ以降はログインが切れない）
  const refreshed = key === YOUTUBE_TOKEN_KEY ? null : await refreshToken()
  const hasScope = () => key === READ_TOKEN_KEY ? storedReadToken() : key === YOUTUBE_TOKEN_KEY ? storedYouTubeToken() : storedToken()
  if (refreshed && hasScope()) return hasScope()!
  if (serverAuth && key !== YOUTUBE_TOKEN_KEY) {
    await signInWithServer(scope)
    const token = hasScope()
    if (!token) throw new Error(key === YOUTUBE_TOKEN_KEY ? 'YouTubeの読み取り権限が許可されませんでした。同期時に許可してください。' : '必要なGoogleの権限が許可されませんでした')
    return token
  }
  await loadGis()
  const oauth = window.google?.accounts.oauth2
  if (!oauth) throw new Error('Googleのログイン機能を読み込めませんでした')
  return new Promise((resolve, reject) => {
    let tokenClient = tokenClients.get(scope)
    if (!tokenClient) { tokenClient = oauth.initTokenClient({ client_id: DRIVE_CLIENT_ID, scope, include_granted_scopes: false, callback: () => {} }); tokenClients.set(scope, tokenClient) }
    tokenClient.callback = r => {
      if (!r.access_token) return reject(new Error('Googleの認証に失敗しました。もう一度ログインしてください。'))
      // 許可画面で一部の権限のチェックを外された場合は、許可されなかったものとして扱う
      const granted = r.scope?.split(' ') ?? []
      if (r.scope && !scope.split(' ').every(s => granted.includes(s))) return reject(new Error('必要な権限が許可されませんでした'))
      saveToken(r.access_token, r.expires_in, r.scope, key)
      resolve(r.access_token)
    }
    tokenClient.error_callback = e => reject(new Error(e.type === 'popup_closed' ? 'ログインがキャンセルされました' : 'ログイン画面を開けませんでした（ポップアップの許可を確認してください）'))
    tokenClient.requestAccessToken({ prompt: '' })
  })
}

/** Googleアカウントでログインしてアクセストークンを取得する（ボタン操作から呼ぶこと） */
export const signIn = () => requestToken(SCOPE, TOKEN_KEY)
/** Driveのファイルを読み取れるトークンを取得する（初回だけGoogleの許可画面が出て、2回目以降は自動）。ボタン操作から呼ぶこと */
export async function signInForRead(): Promise<string> {
  await requestToken(`${SCOPE} ${READ_SCOPE}`, READ_TOKEN_KEY)
  // サーバー経由のログインで読み取り専用の権限が許可されなかったときは、従来どおりファイルごとの許可に回す
  const read = storedReadToken()
  if (!read) throw new Error('読み取り専用の権限が許可されませんでした')
  return read
}

/** 同期ボタンからだけ要求する。Driveのサーバーセッションとは独立したGISトークンを使用する。 */
export async function signInForYouTube(): Promise<string> {
  if (!DRIVE_CLIENT_ID) throw new Error('YouTube連携にはGoogleログインの設定が必要です。設定画面の案内をご確認ください。')
  return storedYouTubeToken() ?? requestToken(YOUTUBE_SCOPE, YOUTUBE_TOKEN_KEY)
}

export function signOut() {
  const token = storedToken()
  clearToken()
  if (token) window.google?.accounts.oauth2.revoke(token)
  if (serverAuth) void authApi({ action: 'signout' }).catch(() => undefined)
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

/** フォルダをPickerで選んでもらい、このアプリにそのフォルダへのアクセスを許可する */
export async function grantFolderAccess(folderId = DATA_FOLDER_ID, label = 'MyBooks'): Promise<boolean> {
  if (!DRIVE_API_KEY || !DRIVE_APP_ID) throw new Error('フォルダの許可には VITE_GOOGLE_API_KEY と VITE_GOOGLE_APP_ID の設定が必要です（READMEを参照）')
  const id = await openPicker(picker => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setMimeTypes('application/vnd.google-apps.folder')
    return { view: view.setFileIds?.(folderId) ?? view, title: `「${label}」フォルダを選んで「選択」を押してください` }
  })
  if (id === null) return false
  if (id !== folderId) throw new Error(`選んだフォルダが「${label}」フォルダではありません。もう一度お試しください`)
  return true
}

/** ファイルをPickerで選んでもらい、このアプリにそのファイルの読み取りを許可する（drive.file スコープのため） */
export async function grantFileAccess(fileId: string, label: string): Promise<boolean> {
  if (!DRIVE_API_KEY || !DRIVE_APP_ID) throw new Error('ファイルの許可には VITE_GOOGLE_API_KEY と VITE_GOOGLE_APP_ID の設定が必要です（READMEを参照）')
  const id = await openPicker(picker => {
    const view = new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(false).setMode(picker.DocsViewMode.LIST)
    return { view: view.setFileIds?.(fileId) ?? view, title: `「${label}」のファイルを選んで「選択」を押してください` }
  })
  if (id === null) return false
  if (id !== fileId) throw new Error(`選んだファイルが「${label}」のファイルではありません。もう一度お試しください`)
  return true
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' }
/** ファイル名に使えない文字を置き換える */
const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || '表紙'

async function createImage(token: string, image: Blob, name: string, folderId: string): Promise<string> {
  const ext = IMAGE_EXT[image.type] ?? 'png'
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify({ name: `${safeName(name)}.${ext}`, parents: [folderId] })], { type: 'application/json' }))
  form.append('file', image)
  const res = await call(token, `${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', body: form })
  if (res.status === 403 || res.status === 404) throw new FolderAccessError('表紙フォルダへのアクセスが許可されていません')
  const { id } = await json<{ id: string }>(res)
  // アプリで表紙を表示できるよう「リンクを知っている全員が閲覧可」にする（失敗しても続行）
  await call(token, `${API}/${id}/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) }).catch(() => undefined)
  return id
}

/** 画像を表紙フォルダに「タイトル.拡張子」で保存し、そのファイルIDを返す。未許可なら許可を求めてから再試行 */
export async function uploadCoverImage(image: Blob, title: string, folderId: string): Promise<string | null> {
  const token = storedToken() ?? await signIn()
  try { return await createImage(token, image, title, folderId) } catch (e) {
    if (!(e instanceof FolderAccessError)) throw e
    if (!confirm('初回のみ、表紙フォルダへのアクセスを許可する必要があります。\nGoogleの選択画面で表紙フォルダを選んで「選択」を押してください。')) return null
    if (!await grantFolderAccess(folderId, '表紙')) return null
    return createImage(storedToken() ?? await signIn(), image, title, folderId)
  }
}

/** クリップボードの画像を読み取る（画像が無ければ null） */
export async function readClipboardImage(): Promise<Blob | null> {
  if (!navigator.clipboard?.read) throw new Error('このブラウザではボタンからの貼り付けに対応していません。画面上で Ctrl+V（⌘+V）を押して貼り付けてください')
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find(t => t.startsWith('image/'))
    if (type) return item.getType(type)
  }
  return null
}

// 本棚データ以外のJSONファイル（分類マップのキャッシュなど）を保存先フォルダに読み書きする。
// 本棚データの MyBooks-library.json とは別ファイルなので、こちらの失敗が本棚の保存に影響することはない。

/** 保存先フォルダ内の指定名のファイル（複数ある場合は最初に作られたもの） */
export async function findNamedFile(token: string, name: string): Promise<DriveFile | null> {
  const q = encodeURIComponent(`'${DATA_FOLDER_ID}' in parents and name='${name}' and trashed=false`)
  const res = await call(token, `${API}?q=${q}&spaces=drive&orderBy=createdTime&pageSize=1&fields=files(id,modifiedTime)`)
  return (await json<{ files: DriveFile[] }>(res)).files[0] ?? null
}

export async function readJsonFile<T>(token: string, id: string): Promise<T> {
  return json<T>(await call(token, `${API}/${id}?alt=media`))
}

/** JSONを保存する。id があれば上書き、なければ保存先フォルダに新規作成 */
export async function writeJsonFile(token: string, name: string, data: unknown, id?: string): Promise<DriveFile> {
  const text = JSON.stringify(data)
  if (id) return json(await call(token, `${UPLOAD}/${id}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text }))
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify({ name, mimeType: 'application/json', parents: [DATA_FOLDER_ID] })], { type: 'application/json' }))
  form.append('file', new Blob([text], { type: 'application/json' }))
  const res = await call(token, `${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', body: form })
  if (res.status === 403 || res.status === 404) throw new FolderAccessError('保存先のMyBooksフォルダへのアクセスが許可されていません')
  return json(res)
}
