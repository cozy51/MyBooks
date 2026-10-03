// 全ページスキャンのファイルから要約を作る（サーバーの /api/summarize-scan 経由。APIキーはブラウザに置かない）
import { driveFileId } from './cover'
import { DRIVE_CLIENT_ID, grantFileAccess, signIn, signInForRead, storedReadToken, storedToken } from './drive'

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

interface ResponseData { summary?: string; error?: string; code?: string }

/** 要約を作れなかった理由（timeout: 時間切れ / failed: そのほかの失敗 / cancelled: 中止した） */
export type SummaryFailure = 'timeout' | 'failed' | 'cancelled'
export class SummaryError extends Error {
  kind: SummaryFailure
  constructor(kind: SummaryFailure, message: string, options?: ErrorOptions) { super(message, options); this.kind = kind }
}
const TIMEOUT_MESSAGE = '要約の作成が時間内に終わりませんでした。ページ数が多い場合は時間がかかります。もう一度お試しください。'
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

/** 要約は1件ずつ順番に作る（大きなPDFの転送が同時に走ると、通信が途中で切れやすいため） */
let queue: Promise<unknown> = Promise.resolve()
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** 一時的な失敗なら、少し待って最大2回まで再試行する */
async function requestWithRetry(source: { fileId?: string; url?: string }, title: string, author: string, token: string | null, signal?: AbortSignal) {
  let result = await request(source, title, author, token, signal)
  for (const ms of [5_000, 20_000]) {
    if (result.ok || !retryable(result)) break
    await wait(ms, signal)
    result = await request(source, title, author, token, signal)
  }
  return result
}

async function request(source: { fileId?: string; url?: string }, title: string, author: string, token: string | null, signal?: AbortSignal) {
  let res: Response
  try {
    // サーバーは約280秒で打ち切って応答するので、それより少し長く待つ
    const timeout = AbortSignal.timeout(300_000)
    res = await fetch('/api/summarize-scan', { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...source, title, author }) })
  } catch (e) {
    if (signal?.aborted) throw cancelled()
    if (e instanceof Error && e.name === 'TimeoutError') throw new SummaryError('timeout', TIMEOUT_MESSAGE, { cause: e })
    // 一時的に接続できなかっただけのこともあるので、再試行できるようにエラーにはしない
    return { ok: false, status: 0, data: { error: '要約を作るAPIに接続できませんでした。ネットワークを確認してください。', code: 'temporary' } as ResponseData }
  }
  const data = await res.json().catch(() => null) as ResponseData | null
  if (res.status === 404 && !data) throw new SummaryError('failed', '要約を作るAPI（/api/summarize-scan）が見つかりません。Vercelへのデプロイ、または npm run dev で起動してください。')
  if (res.status === 504) throw new SummaryError('timeout', data?.error || TIMEOUT_MESSAGE)
  return { ok: res.ok && Boolean(data?.summary), status: res.status, data }
}

/**
 * 全ページスキャンのリンク先から要約を作る。
 * Driveのファイルは読み取り専用の許可（初回だけ）で読むので、ファイルごとの許可は要らない。
 * その許可がもらえず読めなかったときだけ、Pickerでそのファイルを許可してもらってから再試行する
 */
export async function summarizeScan(scanUrl: string, title: string, author: string, options: { signal?: AbortSignal; onStart?: () => void } = {}): Promise<string> {
  const { signal, onStart } = options
  const fileId = driveFileId(scanUrl) ?? undefined
  const source = fileId ? { fileId } : { url: scanUrl }
  // ログインのポップアップはボタン操作の直後でないと開けないので、順番待ちの前に済ませる
  const token = await readToken()
  return inTurn(async () => {
    // 順番を待つあいだに中止されていれば、始めずに終わる
    if (signal?.aborted) throw cancelled()
    onStart?.()
    // 順番を待つあいだにログインを更新していれば、新しいトークンを使う
    let result = await requestWithRetry(source, title, author, storedReadToken() ?? token, signal)
    if (result.data?.code === 'needs_access' && fileId && DRIVE_CLIENT_ID && !storedReadToken()) {
      if (!confirm('全ページスキャンのファイルを読むために、初回のみファイルへのアクセスを許可する必要があります。\nGoogleの選択画面でそのファイルを選んで「選択」を押してください。')) throw new SummaryError('failed', 'ファイルへのアクセスが許可されなかったため、要約を作れませんでした。')
      if (!await grantFileAccess(fileId, '全ページスキャン')) throw new SummaryError('failed', 'ファイルへのアクセスが許可されなかったため、要約を作れませんでした。')
      result = await requestWithRetry(source, title, author, storedToken() ?? await signIn(), signal)
    }
    if (!result.ok) throw new SummaryError(result.data?.code === 'timeout' ? 'timeout' : 'failed', result.data?.error || `要約を作れませんでした（${result.status}）`)
    return result.data!.summary!
  })
}
