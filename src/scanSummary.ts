// 全ページスキャンのファイルから要約を作る（サーバーの /api/summarize-scan 経由。APIキーはブラウザに置かない）
import { driveFileId } from './cover'
import { DRIVE_CLIENT_ID, grantFileAccess, signIn, storedToken } from './drive'

async function request(source: { fileId?: string; url?: string }, title: string, author: string) {
  // Driveのファイルを読むため、Googleにログインしたトークンを渡す
  const token = storedToken() ?? (DRIVE_CLIENT_ID ? await signIn() : null)
  let res: Response
  try {
    // サーバーは約280秒で打ち切って応答するので、それより少し長く待つ
    res = await fetch('/api/summarize-scan', { signal: AbortSignal.timeout(300_000), method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...source, title, author }) })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new Error('要約の作成が時間内に終わりませんでした。もう一度お試しください。', { cause: e })
    throw new Error('要約を作るAPIに接続できませんでした。ネットワークを確認してください。', { cause: e })
  }
  const data = await res.json().catch(() => null) as { summary?: string; error?: string; code?: string } | null
  if (res.status === 404 && !data) throw new Error('要約を作るAPI（/api/summarize-scan）が見つかりません。Vercelへのデプロイ、または npm run dev で起動してください。')
  if (res.status === 504 && !data) throw new Error('要約の作成が時間内に終わりませんでした。もう一度お試しください。')
  return { ok: res.ok && Boolean(data?.summary), status: res.status, data }
}

/** 全ページスキャンのリンク先から要約を作る。Driveのファイルを読めないときは、Pickerで許可してもらってから再試行する */
export async function summarizeScan(scanUrl: string, title: string, author: string): Promise<string> {
  const fileId = driveFileId(scanUrl) ?? undefined
  const source = fileId ? { fileId } : { url: scanUrl }
  let result = await request(source, title, author)
  if (result.data?.code === 'needs_access' && fileId && DRIVE_CLIENT_ID) {
    if (!confirm('全ページスキャンのファイルを読むために、初回のみファイルへのアクセスを許可する必要があります。\nGoogleの選択画面でそのファイルを選んで「選択」を押してください。')) throw new Error('ファイルへのアクセスが許可されなかったため、要約を作れませんでした。')
    if (!await grantFileAccess(fileId, '全ページスキャン')) throw new Error('ファイルへのアクセスが許可されなかったため、要約を作れませんでした。')
    result = await request(source, title, author)
  }
  if (!result.ok) throw new Error(result.data?.error || `要約を作れませんでした（${result.status}）`)
  return result.data!.summary!
}
