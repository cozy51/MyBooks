// 全ページスキャン（Google DriveのPDFなど）から、本の要約を作る API（Vercel Function）。
// 1. Drive からファイルを取得（ログイン中のユーザーの権限。だめなら「リンクを知っている全員」の公開リンク）
// 2. Gemini の File API にそのまま流し込んでアップロード（大きなPDFでもメモリに溜めない）
// 3. アップロードしたファイルを読ませて要約を作り、終わったらファイルを削除する
//   SUMMARY_MODEL … モデル名を変えるときだけ設定（既定: gemini-flash-latest）
//   SUMMARY_MEDIA_RESOLUTION … PDFを読む解像度（low / medium / high / default。既定: low で速さ優先）
// リクエスト: { fileId?: DriveのファイルID, url?: 公開されたPDFのURL, title, author }（1〜3をまとめて行う）
// 大きなPDFでも時間切れになりにくいよう、段階ごとに分けて呼ぶこともできる（それぞれに約280秒の制限時間がある）
//   { step: 'upload', fileId?, url? } … 1・2だけ行い、Gemini のファイル { name, state } を返す（読める状態になるのは待たない）
//   { step: 'status', name } … Gemini のファイルの状態（PROCESSING / ACTIVE / FAILED）を返す
//   { step: 'summarize', name, title, author } … 3だけ行う。要約ができたらファイルを削除する（時間切れのときは残すので、やり直せる）
//   { step: 'cleanup', name } … ファイルを削除する
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

interface GeminiFile { name: string; uri: string; mimeType: string; state?: string }
const GEMINI_FILE = /^files\/[\w-]+$/

async function getGeminiFile(deadline: number, p: Provider, name: string): Promise<GeminiFile | null> {
  const res = await fetchBefore(deadline, `${GEMINI}/v1beta/${name}`, { headers: { 'x-goog-api-key': p.key } })
  if (res.status === 404 || res.status === 403) return null
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  return await res.json() as GeminiFile
}

/** Gemini の File API へ、ストリームのままアップロードする（waitActive: 読める状態になるまで待つか） */
async function uploadToGemini(deadline: number, p: Provider, source: Source, waitActive = true): Promise<GeminiFile> {
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
  let file = (await res.json() as { file: GeminiFile }).file
  // 大きなPDFは、読める状態（ACTIVE）になるまで少し時間がかかる
  while (waitActive && file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 3000))
    const check = await fetchBefore(deadline, `${GEMINI}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': p.key } })
    if (!check.ok) throw new UpstreamError(check.status, await check.text())
    file = await check.json() as typeof file
  }
  if (file.state === 'FAILED') throw new UpstreamError(422, 'file processing failed')
  return file
}

const summaryRules = `- 300〜400字程度の1段落の文章にする（見出し・箇条書き・記号による装飾は使わない）
- 何についての本か（主題）、著者の主な主張、読者が得られる具体的な考え方や方法を中心にまとめる
- 目次や奥付、広告ページの内容は含めない
- 要約の文章だけにする（「（392字）」のような文字数の表記や、前置き・見出しは付けない）`

const instructions = (title: string, author: string) => `これは本「${title}」${author ? `（著者: ${author}）` : ''}の全ページをスキャンしたファイルです。
本の内容を読み、日本語で要約してください。
${summaryRules}
- 要約の文章だけを出力する`

/** 要約と一緒に、スキャンが指定した本と同じ本かを確かめてもらう（リンク先が別の本のファイルだったときに、違う本の要約を保存しないため） */
const checkedInstructions = (title: string, author: string) => `これは本の全ページをスキャンしたファイルです。
登録されている本：「${title}」${author ? `（著者: ${author}）` : ''}
次の項目を JSON で答えてください。
- scannedTitle：スキャンの表紙・扉・奥付などに書かれている書名
- sameBook：スキャンの本が、登録されている本と同じ本か（サブタイトルの有無・表記の違い・版の違い・タイトルの一部だけの登録は同じ本とみなす。明らかに別の本のときだけ false）
- summary：スキャンの本の内容の日本語の要約
${summaryRules}`

const CHECK_SCHEMA = { type: 'OBJECT', properties: { scannedTitle: { type: 'STRING' }, sameBook: { type: 'BOOLEAN' }, summary: { type: 'STRING' } }, required: ['scannedTitle', 'sameBook', 'summary'] }

/** sameBook: スキャンが登録されている本と同じ本か（確かめられなかったときは undefined） */
interface SummaryResult { summary: string; scannedTitle?: string; sameBook?: boolean }

/** AIが付けることがある文字数の表記（例: （392字）・(約400文字)・文字数：392字）や「要約：」の前置きを取り除く */
export function cleanSummary(text: string): string {
  return text.trim()
    .replace(/^(?:要約|まとめ)\s*[:：]\s*/, '')
    .replace(/\s*(?:[（(]\s*(?:約\s*)?[0-9０-９,，]+\s*(?:字|文字)\s*(?:程度)?\s*[）)]|(?:文字数|字数)\s*[:：]?\s*(?:約\s*)?[0-9０-９,，]+\s*(?:字|文字))\s*$/, '')
    .trim()
}

/**
 * PDFを読むときの解像度（SUMMARY_MEDIA_RESOLUTION: low / medium / high / default）。
 * 低いほど1ページあたりのトークンが減って速く終わる。要約には細かい文字まで読む必要がないので既定は low
 */
function mediaResolution(): string | undefined {
  const value = (process.env.SUMMARY_MEDIA_RESOLUTION || 'low').trim().toLowerCase()
  return ['low', 'medium', 'high'].includes(value) ? `MEDIA_RESOLUTION_${value.toUpperCase()}` : undefined
}

async function summarize(deadline: number, p: Provider, file: { uri: string; mimeType: string }, title: string, author: string): Promise<SummaryResult> {
  for (const model of geminiModels(process.env.SUMMARY_MODEL)) {
    // 未対応の設定で断られたら、その設定を外して同じモデルでやり直す
    let thinking = true
    let resolution = mediaResolution()
    // タイトルが分かっていれば、同じ本かどうかも JSON で答えてもらう
    let checked = Boolean(title)
    for (;;) {
      const generationConfig = { ...(thinking && { thinkingConfig: { thinkingLevel: 'low' } }), ...(resolution && { mediaResolution: resolution }), ...(checked && { responseMimeType: 'application/json', responseSchema: CHECK_SCHEMA }) }
      const res = await fetchBefore(deadline, `${GEMINI}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
        body: JSON.stringify({
          contents: [{ parts: [{ file_data: { mime_type: file.mimeType, file_uri: file.uri } }, { text: (checked ? checkedInstructions : instructions)(title, author) }] }],
          ...(Object.keys(generationConfig).length && { generationConfig }),
        }),
      })
      if (res.ok) {
        const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
        const text = data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ?? ''
        if (!checked) return { summary: cleanSummary(text) }
        try {
          const result = JSON.parse(text) as { scannedTitle?: unknown; sameBook?: unknown; summary?: unknown }
          return { summary: cleanSummary(typeof result.summary === 'string' ? result.summary : ''), scannedTitle: typeof result.scannedTitle === 'string' ? result.scannedTitle.trim() : undefined, sameBook: typeof result.sameBook === 'boolean' ? result.sameBook : undefined }
        } catch { return { summary: cleanSummary(text) } }
      }
      const detail = await res.text()
      if (res.status === 400 && thinking && /thinking/i.test(detail)) { thinking = false; continue } // thinkingLevel 未対応のモデル
      if (res.status === 400 && resolution && /media.?resolution/i.test(detail)) { resolution = undefined; continue } // mediaResolution 未対応のモデル
      if (res.status === 400 && checked && /response.?(schema|mime)/i.test(detail)) { checked = false; continue } // JSON の出力に未対応のモデル
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

  let body: { step?: unknown; name?: unknown; fileId?: unknown; url?: unknown; title?: unknown; author?: unknown }
  try { body = await request.json() } catch { return reply(400, { error: 'リクエストの形式が正しくありません' }) }
  if (body.step === 'status' || body.step === 'summarize' || body.step === 'cleanup') return fileStep(deadline, p, body.step, body)
  const fileId = typeof body.fileId === 'string' && DRIVE_ID.test(body.fileId) ? body.fileId : undefined
  const url = typeof body.url === 'string' ? body.url.trim() : undefined
  if (!fileId && !url) return reply(400, { error: '全ページスキャンのリンクがありません' })
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
  const author = typeof body.author === 'string' ? body.author.trim().slice(0, 200) : ''
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]

  let uploaded: GeminiFile | undefined
  try {
    const source = await openSource(deadline, token, fileId, url)
    if (body.step === 'upload') {
      const file = await uploadToGemini(deadline, p, source, false)
      return reply(200, { file: { name: file.name, state: file.state ?? 'ACTIVE' } })
    }
    uploaded = await uploadToGemini(deadline, p, source)
    const result = await summarize(deadline, p, uploaded, title, author)
    if (result.sameBook === false) return mismatch(result, title)
    if (!result.summary) return reply(422, { error: '要約を作れませんでした。スキャンの内容を確認してください。' })
    return reply(200, { summary: result.summary, scannedTitle: result.scannedTitle })
  } catch (e) {
    return failure(e)
  } finally {
    // アップロードしたファイルは要約が終わったら削除する（48時間で自動削除もされる）
    if (uploaded) await fetch(`${GEMINI}/v1beta/${uploaded.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': p.key } }).catch(() => undefined)
  }
}

/** アップロード済みの Gemini のファイルを使う段階（状態の確認・要約・削除） */
async function fileStep(deadline: number, p: Provider, step: 'status' | 'summarize' | 'cleanup', body: { name?: unknown; title?: unknown; author?: unknown }): Promise<Response> {
  const name = typeof body.name === 'string' && GEMINI_FILE.test(body.name) ? body.name : undefined
  if (!name) return reply(400, { error: 'ファイルの指定が正しくありません' })
  const remove = () => fetch(`${GEMINI}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': p.key } }).catch(() => undefined)
  try {
    if (step === 'cleanup') { await remove(); return reply(200, { ok: true }) }
    const file = await getGeminiFile(deadline, p, name)
    // 48時間が過ぎて消えたファイルなど。アップロードからやり直してもらう
    if (!file) return reply(410, { error: 'アップロードしたファイルが見つかりません。', code: 'file_gone' })
    if (step === 'status') return reply(200, { file: { name: file.name, state: file.state ?? 'ACTIVE' } })
    if (file.state === 'FAILED') { await remove(); return reply(422, { error: 'このファイルは要約に使えませんでした（形式が対応していないなど）。' }) }
    if (file.state === 'PROCESSING') return reply(409, { error: 'ファイルの準備中です。', code: 'processing' })
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
    const author = typeof body.author === 'string' ? body.author.trim().slice(0, 200) : ''
    const result = await summarize(deadline, p, file, title, author)
    // 別の本のファイルだったときは、要約を返さない（ファイルも使わないので削除する）
    if (result.sameBook === false) { await remove(); return mismatch(result, title) }
    if (!result.summary) return reply(422, { error: '要約を作れませんでした。スキャンの内容を確認してください。' })
    await remove()
    return reply(200, { summary: result.summary, scannedTitle: result.scannedTitle })
  } catch (e) { return failure(e) }
}

/** スキャンが別の本だったとき */
const mismatch = (result: SummaryResult, title: string) => reply(409, {
  error: `全ページスキャンの中身は「${result.scannedTitle || '別の本'}」で、この本（${title}）とは違うため、要約を保存しませんでした。全ページスキャンのリンク先を確認してください。`,
  code: 'mismatch', scannedTitle: result.scannedTitle,
})

/** 失敗を、画面に出せるメッセージにする */
function failure(e: unknown): Response {
  if (e instanceof NeedsAccess) return reply(403, { error: '全ページスキャンのファイルを読めませんでした。ファイルへのアクセスを許可してください。', code: 'needs_access' })
  if (e instanceof UpstreamError && e.status === 504) return reply(504, { error: '要約の作成が時間内に終わりませんでした。ページ数が多い場合は時間がかかります。もう一度お試しください。', code: 'timeout' })
  if (e instanceof UpstreamError && e.status === 413) return reply(413, { error: 'ファイルが大きすぎます（2GBまで）。' })
  if (e instanceof UpstreamError && e.status === 400) return reply(422, { error: 'このファイルは要約に使えませんでした（PDFのページ数が多すぎる・形式が対応していないなど）。' })
  if (e instanceof UpstreamError && e.status === 404) return reply(502, { error: '要約に使うAIモデルが見つかりませんでした。環境変数 SUMMARY_MODEL に利用できるモデル名を設定してください。', code: 'model_unavailable' })
  return upstreamFailure(e, '全ページスキャンからの要約')
}
