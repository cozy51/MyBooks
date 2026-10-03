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
async function requestWithRetry(source: { fileId?: string; url?: string }, title: string, author: string, token: string | null) {
  let result = await request(source, title, author, token)
  for (const wait of [5_000, 20_000]) {
    if (result.ok || !retryable(result)) break
    await new Promise(r => setTimeout(r, wait))
    result = await request(source, title, author, token)
  }
  return result
}

async function request(source: { fileId?: string; url?: string }, title: string, author: string, token: string | null) {
  let res: Response
  try {
    // サーバーは約280秒で打ち切って応答するので、それより少し長く待つ
    res = await fetch('/api/summarize-scan', { signal: AbortSignal.timeout(300_000), method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...source, title, author }) })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new Error('要約の作成が時間内に終わりませんでした。もう一度お試しください。', { cause: e })
    // 一時的に接続できなかっただけのこともあるので、再試行できるようにエラーにはしない
    return { ok: false, status: 0, data: { error: '要約を作るAPIに接続できませんでした。ネットワークを確認してください。', code: 'temporary' } as ResponseData }
  }
  const data = await res.json().catch(() => null) as ResponseData | null
  if (res.status === 404 && !data) throw new Error('要約を作るAPI（/api/summarize-scan）が見つかりません。Vercelへのデプロイ、または npm run dev で起動してください。')
  if (res.status === 504 && !data) throw new Error('要約の作成が時間内に終わりませんでした。もう一度お試しください。')
  return { ok: res.ok && Boolean(data?.summary), status: res.status, data }
}

/**
 * 全ページスキャンのリンク先から要約を作る。
 * Driveのファイルは読み取り専用の許可（初回だけ）で読むので、ファイルごとの許可は要らない。
 * その許可がもらえず読めなかったときだけ、Pickerでそのファイルを許可してもらってから再試行する
 */
export async function summarizeScan(scanUrl: string, title: string, author: string): Promise<string> {
  const fileId = driveFileId(scanUrl) ?? undefined
  const source = fileId ? { fileId } : { url: scanUrl }
  // ログインのポップアップはボタン操作の直後でないと開けないので、順番待ちの前に済ませる
  const token = await readToken()
  return inTurn(async () => {
    // 順番を待つあいだにログインを更新していれば、新しいトークンを使う
    let result = await requestWithRetry(source, title, author, storedReadToken() ?? token)
    if (result.data?.code === 'needs_access' && fileId && DRIVE_CLIENT_ID && !storedReadToken()) {
      if (!confirm('全ページスキャンのファイルを読むために、初回のみファイルへのアクセスを許可する必要があります。\nGoogleの選択画面でそのファイルを選んで「選択」を押してください。')) throw new Error('ファイルへのアクセスが許可されなかったため、要約を作れませんでした。')
      if (!await grantFileAccess(fileId, '全ページスキャン')) throw new Error('ファイルへのアクセスが許可されなかったため、要約を作れませんでした。')
      result = await requestWithRetry(source, title, author, storedToken() ?? await signIn())
    }
    if (!result.ok) throw new Error(result.data?.error || `要約を作れませんでした（${result.status}）`)
    return result.data!.summary!
  })
}
