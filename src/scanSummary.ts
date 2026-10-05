// 全ページスキャンのファイルから要約を作る（サーバーの /api/summarize-scan 経由。APIキーはブラウザに置かない）
import { driveFileId } from './cover'
import { DRIVE_CLIENT_ID, grantFileAccess, refreshToken, signIn, signInForRead, storedReadToken, storedToken } from './drive'

/**
 * Driveのファイルを読むためのトークン。読み取り専用の許可（初回だけ）をもらえなければ、通常のログインのトークンを使う。
 * ログインのポップアップはボタン操作の直後でないと開けないので、ほかの処理を待つ前に呼んでおくこともできる
 */
export async function readToken(): Promise<string | null> {
  if (!DRIVE_CLIENT_ID) return null
  const saved = storedReadToken()
  if (saved) return saved
  try { return await signInForRead() } catch { return storedToken() ?? await signIn() }
}

interface ResponseData { summary?: string; error?: string; code?: string; file?: { name: string; state?: string } }

/** 要約を作れなかった理由（timeout: 時間切れ / failed: そのほかの失敗 / cancelled: 中止した / mismatch: スキャンが別の本だった） */
export type SummaryFailure = 'timeout' | 'failed' | 'cancelled' | 'mismatch'
export class SummaryError extends Error {
  kind: SummaryFailure
  constructor(kind: SummaryFailure, message: string, options?: ErrorOptions) { super(message, options); this.kind = kind }
}
const TIMEOUT_MESSAGE = '要約の作成が時間内に終わりませんでした。ページ数が多い場合は時間がかかります。もう一度お試しください。'
/**
 * 要約の進み具合（画面に「いまどの段階か・あとどのくらいか」を出すため）
 *   upload: Drive のファイルを Gemini へ転送 / processing: Gemini がファイルを読める状態にする / summarize: 要約を生成
 */
export type SummaryStage = 'upload' | 'processing' | 'summarize'
/** retry: 目安を過ぎて固まっていたので打ち切ってやり直した・一時的な失敗で待ってから再試行した（その段階での回数） */
export interface SummaryProgress { stage: SummaryStage; retries: number }
type Retried = () => void
const cancelled = () => new SummaryError('cancelled', '要約の作成を中止しました。')

/** 中止されたら途中で終わる待ち時間 */
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(cancelled())
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
  const stop = () => { clearTimeout(timer); reject(cancelled()) }
  signal?.addEventListener('abort', stop, { once: true })
})

/** 再試行すれば成功する見込みがある失敗（通信の途中切れ・相手側の一時的な障害・利用上限） */
const retryable = (r: { status: number; data: ResponseData | null }) => r.data?.code === 'temporary' || r.data?.code === 'rate_limited' || r.status === 503

/** 同時に作る要約の数（多い本をまとめて頼んだとき、全体の待ち時間を短くする） */
const PARALLEL = 2
let running = 0
const waiting: (() => void)[] = []
/** 空きができるまで待ってから task を行う（中止されたら、待つのをやめる） */
async function inTurn<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw cancelled()
  if (running < PARALLEL) running++
  else await new Promise<void>((resolve, reject) => {
    const go = () => { signal?.removeEventListener('abort', stop); running++; resolve() }
    const stop = () => { waiting.splice(waiting.indexOf(go), 1); reject(cancelled()) }
    waiting.push(go)
    signal?.addEventListener('abort', stop, { once: true })
  })
  try { return await task() } finally { running--; waiting.shift()?.() }
}

/** PDFのアップロード（DriveからGeminiへの転送）は1件ずつ行う（大きなPDFの転送が同時に走ると、通信が途中で切れやすいため） */
let uploading: Promise<unknown> = Promise.resolve()
function oneUploadAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = uploading.then(task, task)
  uploading = run.catch(() => undefined)
  return run
}

/** 今使えるトークン（順番待ちのあいだに切れていたら、画面を出さずに受け取り直す） */
async function freshToken(fallback: string | null): Promise<string | null> {
  const saved = storedReadToken() ?? storedToken()
  if (saved) return saved
  await refreshToken()
  return storedReadToken() ?? storedToken() ?? fallback
}

type Body = Record<string, unknown>

/**
 * 一時的な失敗なら、少し待って最大2回まで再試行する（利用上限のときは長めに待つ）。
 * ログインが切れていた・ファイルを読めなかったときは、トークンを受け取り直せたら1回だけやり直す
 */
async function requestWithRetry(body: Body, token: string | null, signal?: AbortSignal, onRetry?: Retried) {
  let result = await unstuck(body, token, signal, onRetry)
  if ((result.status === 401 || result.data?.code === 'needs_access') && await refreshToken()) {
    token = storedReadToken() ?? storedToken() ?? token
    result = await unstuck(body, token, signal, onRetry)
  }
  for (const attempt of [0, 1]) {
    if (result.ok || !retryable(result)) break
    onRetry?.()
    await wait(result.data?.code === 'rate_limited' ? [30_000, 60_000][attempt] : [5_000, 20_000][attempt], signal)
    result = await unstuck(body, token, signal, onRetry)
  }
  return result
}

/**
 * 段階ごとの「ふだんならこの時間で終わる」目安。これを大きく過ぎた依頼は、サーバーかGeminiの側で固まっていることが多く、
 * 打ち切ってやり直すとすぐに終わるので、自動で打ち切ってやり直す（最大2回。最後の1回は、サーバーの制限時間いっぱいまで待つ）
 */
export const STALL_LIMIT: Record<string, number> = { upload: 150_000, status: 30_000, summarize: 120_000 }
const STALL_RETRIES = 2

async function unstuck(body: Body, token: string | null, signal?: AbortSignal, onRetry?: Retried) {
  const limit = STALL_LIMIT[String(body.step)]
  if (limit) {
    for (let i = 0; i < STALL_RETRIES; i++) {
      const result = await request(body, token, signal, limit)
      if (result.data?.code !== 'stalled') return result
      onRetry?.()
    }
  }
  return request(body, token, signal)
}

/** limit: この時間で応答がなければ打ち切る（既定は、サーバーが約280秒で打ち切って応答するので、それより少し長く待つ） */
async function request(body: Body, token: string | null, signal?: AbortSignal, limit = 300_000): Promise<{ ok: boolean; status: number; data: ResponseData | null }> {
  let res: Response
  try {
    const timeout = AbortSignal.timeout(limit)
    res = await fetch('/api/summarize-scan', { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  } catch (e) {
    if (signal?.aborted) throw cancelled()
    // 目安の時間で打ち切ったとき（stalled）は、呼び出し元がすぐにやり直す
    if (e instanceof Error && e.name === 'TimeoutError') return { ok: false, status: 504, data: { error: TIMEOUT_MESSAGE, code: limit < 300_000 ? 'stalled' : 'timeout' } }
    // 一時的に接続できなかっただけのこともあるので、再試行できるようにエラーにはしない
    return { ok: false, status: 0, data: { error: '要約を作るAPIに接続できませんでした。ネットワークを確認してください。', code: 'temporary' } }
  }
  const data = await res.json().catch(() => null) as ResponseData | null
  if (res.status === 404 && !data) throw new SummaryError('failed', '要約を作るAPI（/api/summarize-scan）が見つかりません。Vercelへのデプロイ、または npm run dev で起動してください。')
  if (res.status === 504) return { ok: false, status: 504, data: { ...data, error: data?.error || TIMEOUT_MESSAGE, code: 'timeout' } }
  return { ok: res.ok, status: res.status, data }
}

/** Gemini API の残高が尽きた（402）とき、その後しばらくは頼まずに同じ理由で失敗にする（順番待ちの本が1冊ずつ同じエラーを出し続けないように） */
let billingError: { message: string; at: number } | null = null

function failed(result: { status: number; data: ResponseData | null }): SummaryError {
  const message = result.data?.error || `要約を作れませんでした（${result.status}）`
  if (result.data?.code === 'billing') billingError = { message, at: Date.now() }
  return new SummaryError(result.data?.code === 'timeout' ? 'timeout' : result.data?.code === 'mismatch' ? 'mismatch' : 'failed', message)
}

// ---- アップロードしたファイルの記録 ----
// 時間切れ・失敗のあとにやり直すとき、Gemini へのアップロード（大きなPDFでは時間がかかる）を省くため、
// 全ページスキャンごとに、アップロード先のファイル名を覚えておく（Gemini は48時間で自動削除するので、それより短い間だけ使う）
const UPLOADS_KEY = 'mybooks-summary-uploads'
const UPLOAD_TTL = 40 * 60 * 60 * 1000
type Uploads = Record<string, { name: string; at: number }>
function loadUploads(): Uploads {
  try {
    const all = JSON.parse(localStorage.getItem(UPLOADS_KEY) || '{}') as Uploads
    return Object.fromEntries(Object.entries(all).filter(([, u]) => Date.now() - u.at < UPLOAD_TTL))
  } catch { return {} }
}
function saveUpload(key: string, name: string | null) {
  const all = loadUploads()
  if (name) all[key] = { name, at: Date.now() }; else delete all[key]
  try { localStorage.setItem(UPLOADS_KEY, JSON.stringify(all)) } catch { /* noop */ }
}

/**
 * 全ページスキャンのリンク先から要約を作る。
 * 時間切れになりにくいよう、サーバーには段階ごとに分けて頼む（それぞれに約5分の制限時間がある）。
 *   1. Drive のファイルを Gemini へアップロード（前にアップロード済みなら省く）
 *   2. Gemini が読める状態になるまで待つ
 *   3. 要約を作る（時間切れのときは、アップロードしたファイルのまま1回だけやり直す）
 * Driveのファイルは読み取り専用の許可（初回だけ）で読むので、ファイルごとの許可は要らない。
 * その許可がもらえず読めなかったときだけ、Pickerでそのファイルを許可してもらってから再試行する
 */
export async function summarizeScan(scanUrl: string, title: string, author: string, options: { signal?: AbortSignal; onStart?: () => void; onProgress?: (progress: SummaryProgress) => void } = {}): Promise<string> {
  const { signal, onStart, onProgress } = options
  // 段階が変わったとき・やり直したときに知らせる
  let current: SummaryProgress | undefined
  const stage = (next: SummaryStage) => { if (current?.stage !== next) { current = { stage: next, retries: 0 }; onProgress?.(current) } }
  const retried: Retried = () => { if (current) { current = { ...current, retries: current.retries + 1 }; onProgress?.(current) } }
  const fileId = driveFileId(scanUrl) ?? undefined
  const source = fileId ? { fileId } : { url: scanUrl }
  const uploadKey = fileId ?? scanUrl
  // ログインのポップアップはボタン操作の直後でないと開けないので、順番待ちの前に済ませる
  const token = await readToken()
  const queuedAt = Date.now()
  return inTurn(async () => {
    // 順番を待つあいだに中止されていれば、始めずに終わる
    if (signal?.aborted) throw cancelled()
    if (billingError && Date.now() - billingError.at < 60_000) throw new SummaryError('failed', billingError.message)
    onStart?.()
    // 順番を待つあいだにトークンが切れていたら、受け取り直してから使う（押したときのトークンを使い続けると、後ろの本ほど失敗する）
    const auth = await freshToken(token)

    // 1. アップロード（前回アップロードしたファイルが残っていれば使う）
    let name: string | undefined = loadUploads()[uploadKey]?.name
    let state: string | undefined
    if (name) {
      stage('processing')
      const status = await requestWithRetry({ step: 'status', name }, auth, signal, retried)
      state = status.ok ? status.data?.file?.state : undefined
      if (!state || state === 'FAILED') { saveUpload(uploadKey, null); name = undefined }
    }
    if (!name) {
      stage('upload')
      let result = await oneUploadAtATime(() => requestWithRetry({ step: 'upload', ...source }, auth, signal, retried))
      if (result.status === 401) throw new SummaryError('failed', 'Googleのログインが切れたため、要約を作れませんでした。「Driveに接続」でログインし直してから、もう一度お試しください。')
      // ファイルごとの許可（確認とGoogleの選択画面）は、ボタンを押してすぐのときだけ行う。
      // 順番待ちのあとに確認を出すと、そこで止まって後ろの本が進まなくなるので、失敗として次へ進む
      if (result.data?.code === 'needs_access' && fileId && DRIVE_CLIENT_ID && !storedReadToken() && Date.now() - queuedAt > 5_000) {
        throw new SummaryError('failed', '全ページスキャンのファイルを読めませんでした（ファイルへのアクセスの許可が必要です）。この本の詳細画面から要約を作ると、許可の画面が出ます。')
      }
      if (result.data?.code === 'needs_access' && fileId && DRIVE_CLIENT_ID && !storedReadToken()) {
        if (!confirm('全ページスキャンのファイルを読むために、初回のみファイルへのアクセスを許可する必要があります。\nGoogleの選択画面でそのファイルを選んで「選択」を押してください。')) throw new SummaryError('failed', 'ファイルへのアクセスが許可されなかったため、要約を作れませんでした。')
        if (!await grantFileAccess(fileId, '全ページスキャン')) throw new SummaryError('failed', 'ファイルへのアクセスが許可されなかったため、要約を作れませんでした。')
        const retryToken = storedToken() ?? await signIn()
        result = await oneUploadAtATime(() => requestWithRetry({ step: 'upload', ...source }, retryToken, signal, retried))
      }
      if (!result.ok || !result.data?.file) throw failed(result)
      name = result.data.file.name
      state = result.data.file.state
      saveUpload(uploadKey, name)
    }

    // 2. Gemini が読める状態（ACTIVE）になるまで待つ（最大10分。読める状態になったらすぐ次へ進めるよう、こまめに確かめる）
    const readyBy = Date.now() + 10 * 60_000
    if (state === 'PROCESSING') stage('processing')
    while (state === 'PROCESSING') {
      if (Date.now() > readyBy) throw new SummaryError('timeout', 'スキャンのファイルの準備が時間内に終わりませんでした。しばらくしてから、もう一度お試しください（アップロードはやり直さずに続きから行います）。')
      await wait(2_000, signal)
      const status = await requestWithRetry({ step: 'status', name }, auth, signal, retried)
      if (!status.ok) throw failed(status)
      state = status.data?.file?.state
    }
    if (state === 'FAILED') { saveUpload(uploadKey, null); throw new SummaryError('failed', 'このファイルは要約に使えませんでした（形式が対応していないなど）。') }

    // 3. 要約を作る（時間切れなら、アップロードしたファイルのまま1回だけやり直す）
    stage('summarize')
    let result = await requestWithRetry({ step: 'summarize', name, title, author }, storedReadToken() ?? storedToken() ?? auth, signal, retried)
    if (result.data?.code === 'timeout') { retried(); result = await requestWithRetry({ step: 'summarize', name, title, author }, storedReadToken() ?? storedToken() ?? auth, signal, retried) }
    // ファイルが消えていた・別の本だった（サーバーが削除済み）ときは、次はアップロードからやり直す
    if (result.data?.code === 'file_gone' || result.data?.code === 'mismatch') saveUpload(uploadKey, null)
    if (!result.ok || !result.data?.summary) throw failed(result)
    // 要約ができたら、アップロードしたファイルを削除する（打ち切った依頼がサーバーに残っていても困らないよう、サーバーでは消さずにここで消す）
    saveUpload(uploadKey, null)
    void request({ step: 'cleanup', name }, storedReadToken() ?? storedToken() ?? auth).catch(() => undefined)
    return result.data.summary
  }, signal)
}
