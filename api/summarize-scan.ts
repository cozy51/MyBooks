// 全ページスキャン（Google DriveのPDFなど）から、本の要約を作る API（Vercel Function）。
// 1. Drive からファイルを取得（ログイン中のユーザーの権限。だめなら「リンクを知っている全員」の公開リンク）
// 2. Gemini の File API にそのまま流し込んでアップロード（大きなPDFでもメモリに溜めない）
// 3. アップロードしたファイルを読ませて要約を作り、終わったらファイルを削除する
//   SUMMARY_MODEL … モデル名を変えるときだけ設定（既定: gemini-flash-latest）
// リクエスト: { fileId?: DriveのファイルID, url?: 公開されたPDFのURL, title, author }
import { authorized, fetchBefore, geminiModels, notConfigured, provider, reply, unauthorized, upstreamFailure, UpstreamError, type Provider } from './_lib.js'

/** 全体の制限時間（vercel.json の実行上限300秒より短くし、必ず応答を返す） */
const TIME_LIMIT = 280_000
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const GEMINI = 'https://generativelanguage.googleapis.com'
const DRIVE_ID = /^[\w-]{25,}$/

interface Source { body: ReadableStream<Uint8Array>; size: number; mimeType: string; name: string }

class NeedsAccess extends Error {}

/** Drive のファイル（またはURL）を、中身を読み込まずにストリームとして開く */
async function openSource(deadline: number, token: string | undefined, fileId: string | undefined, url: string | undefined): Promise<Source> {
  if (fileId && token) {
    const auth = { Authorization: `Bearer ${token}` }
    const meta = await fetchBefore(deadline, `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size&supportsAllDrives=true`, { headers: auth })
    if (meta.ok) {
      const info = await meta.json() as { name: string; mimeType: string; size?: string }
      const res = await fetchBefore(deadline, `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: auth })
      if (res.ok && res.body) return { body: res.body, size: Number(info.size) || Number(res.headers.get('content-length')) || 0, mimeType: info.mimeType, name: info.name }
    }
  }
  // ログインの権限で読めないときは、公開リンクとして取得を試す
  const publicUrl = fileId ? `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t` : url
  if (publicUrl && /^https:\/\//.test(publicUrl)) {
    const res = await fetchBefore(deadline, publicUrl, { redirect: 'follow' })
    const mimeType = res.headers.get('content-type')?.split(';')[0] ?? ''
    if (res.ok && res.body && !mimeType.startsWith('text/html')) {
      const name = res.headers.get('content-disposition')?.match(/filename="?([^";]+)/)?.[1] ?? 'scan'
      return { body: res.body, size: Number(res.headers.get('content-length')) || 0, mimeType: mimeType || 'application/pdf', name }
    }
    await res.body?.cancel()
  }
  throw new NeedsAccess()
}

/** Gemini の File API へ、ストリームのままアップロードする */
async function uploadToGemini(deadline: number, p: Provider, source: Source): Promise<{ name: string; uri: string; mimeType: string }> {
  let body: ReadableStream<Uint8Array> | Uint8Array = source.body
  let size = source.size
  if (!size) {
    // サイズが分からないときだけ、いったん読み込む
    const bytes = new Uint8Array(await new Response(source.body).arrayBuffer())
    body = bytes; size = bytes.length
  }
  if (size > MAX_BYTES) throw new UpstreamError(413, 'file too large')
  const start = await fetchBefore(deadline, `${GEMINI}/upload/v1beta/files`, {
    method: 'POST',
    headers: { 'x-goog-api-key': p.key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(size), 'X-Goog-Upload-Header-Content-Type': source.mimeType, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: source.name.slice(0, 100) } }),
  })
  const uploadUrl = start.headers.get('x-goog-upload-url')
  if (!start.ok || !uploadUrl) throw new UpstreamError(start.status || 502, await start.text())
  const res = await fetchBefore(deadline, uploadUrl, {
    method: 'POST',
    headers: { 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body,
    duplex: 'half',
  } as RequestInit)
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  let file = (await res.json() as { file: { name: string; uri: string; mimeType: string; state?: string } }).file
  // 大きなPDFは、読める状態（ACTIVE）になるまで少し時間がかかる
  while (file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 3000))
    const check = await fetchBefore(deadline, `${GEMINI}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': p.key } })
    if (!check.ok) throw new UpstreamError(check.status, await check.text())
    file = await check.json() as typeof file
  }
  if (file.state === 'FAILED') throw new UpstreamError(422, 'file processing failed')
  return file
}

const instructions = (title: string, author: string) => `これは本「${title}」${author ? `（著者: ${author}）` : ''}の全ページをスキャンしたファイルです。
本の内容を読み、日本語で要約してください。
- 300〜400字程度の1段落の文章にする（見出し・箇条書き・記号による装飾は使わない）
- 何についての本か（主題）、著者の主な主張、読者が得られる具体的な考え方や方法を中心にまとめる
- 目次や奥付、広告ページの内容は含めない
- 要約の文章だけを出力する（「（392字）」のような文字数の表記や、前置き・見出しは付けない）`

/** AIが付けることがある文字数の表記（例: （392字）・(約400文字)・文字数：392字）や「要約：」の前置きを取り除く */
export function cleanSummary(text: string): string {
  return text.trim()
    .replace(/^(?:要約|まとめ)\s*[:：]\s*/, '')
    .replace(/\s*(?:[（(]\s*(?:約\s*)?[0-9０-９,，]+\s*(?:字|文字)\s*(?:程度)?\s*[）)]|(?:文字数|字数)\s*[:：]?\s*(?:約\s*)?[0-9０-９,，]+\s*(?:字|文字))\s*$/, '')
    .trim()
}

async function summarize(deadline: number, p: Provider, file: { uri: string; mimeType: string }, title: string, author: string): Promise<string> {
  for (const model of geminiModels(process.env.SUMMARY_MODEL)) {
    for (const thinking of [true, false]) {
      const res = await fetchBefore(deadline, `${GEMINI}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
        body: JSON.stringify({
          contents: [{ parts: [{ file_data: { mime_type: file.mimeType, file_uri: file.uri } }, { text: instructions(title, author) }] }],
          ...(thinking && { generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }),
        }),
      })
      if (res.ok) {
        const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
        return cleanSummary(data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? '')
      }
      const detail = await res.text()
      if (thinking && res.status === 400 && /thinking/i.test(detail)) continue // thinkingLevel 未対応のモデル
      if (res.status === 404) break // このモデルは使えないので次へ
      throw new UpstreamError(res.status, detail)
    }
  }
  throw new UpstreamError(404, 'no available model')
}

export async function POST(request: Request): Promise<Response> {
  const deadline = Date.now() + TIME_LIMIT
  const p = provider()
  if (!p) return notConfigured()
  if (p.name !== 'gemini') return reply(501, { error: '全ページスキャンからの要約は、Gemini（GEMINI_API_KEY）を設定した場合だけ使えます。' })
  if (!await authorized(request)) return unauthorized()

  let body: { fileId?: unknown; url?: unknown; title?: unknown; author?: unknown }
  try { body = await request.json() } catch { return reply(400, { error: 'リクエストの形式が正しくありません' }) }
  const fileId = typeof body.fileId === 'string' && DRIVE_ID.test(body.fileId) ? body.fileId : undefined
  const url = typeof body.url === 'string' ? body.url.trim() : undefined
  if (!fileId && !url) return reply(400, { error: '全ページスキャンのリンクがありません' })
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
  const author = typeof body.author === 'string' ? body.author.trim().slice(0, 200) : ''
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]

  let uploaded: { name: string; uri: string; mimeType: string } | undefined
  try {
    const source = await openSource(deadline, token, fileId, url)
    uploaded = await uploadToGemini(deadline, p, source)
    const summary = await summarize(deadline, p, uploaded, title, author)
    if (!summary) return reply(422, { error: '要約を作れませんでした。スキャンの内容を確認してください。' })
    return reply(200, { summary })
  } catch (e) {
    if (e instanceof NeedsAccess) return reply(403, { error: '全ページスキャンのファイルを読めませんでした。ファイルへのアクセスを許可してください。', code: 'needs_access' })
    if (e instanceof UpstreamError && e.status === 504) return reply(504, { error: '要約の作成が時間内に終わりませんでした。ページ数が多い場合は時間がかかります。もう一度お試しください。', code: 'timeout' })
    if (e instanceof UpstreamError && e.status === 413) return reply(413, { error: 'ファイルが大きすぎます（2GBまで）。' })
    if (e instanceof UpstreamError && e.status === 400) return reply(422, { error: 'このファイルは要約に使えませんでした（PDFのページ数が多すぎる・形式が対応していないなど）。' })
    if (e instanceof UpstreamError && e.status === 404) return reply(502, { error: '要約に使うAIモデルが見つかりませんでした。環境変数 SUMMARY_MODEL に利用できるモデル名を設定してください。', code: 'model_unavailable' })
    return upstreamFailure(e, '全ページスキャンからの要約')
  } finally {
    // アップロードしたファイルは要約が終わったら削除する（48時間で自動削除もされる）
    if (uploaded) await fetch(`${GEMINI}/v1beta/${uploaded.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': p.key } }).catch(() => undefined)
  }
}
