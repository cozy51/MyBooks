// 表紙画像から、タイトル・著者・分類を読み取る API（Vercel Function）。
// 画像を読めるAI（Gemini / OpenAI）に表紙を渡し、JSONで答えてもらう。
//   VISION_MODEL … モデル名を変えるときだけ設定（既定: gemini-flash-latest / gpt-4.1-mini）
// Geminiはモデルの提供終了・利用制限が早いため、見つからない（404）ときは候補を順に試す。
// リクエスト: { image?: base64, mimeType?: string, cover?: DriveのファイルIDまたは画像URL, categories: { id, name }[] }
import { authorized, notConfigured, provider, reply, unauthorized, upstreamFailure, UpstreamError, type Provider } from './_lib.js'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const DRIVE_ID = /^[\w-]{25,}$/

interface Category { id: string; name: string }
interface CoverInfo { title: string; author: string; categoryId: string }

const instructions = (categories: Category[]) => `これは本の表紙の画像です。表紙に印刷された文字を読み取り、次の3つを答えてください。
- title: 本の正式なタイトル。サブタイトルが明確にあれば「タイトル サブタイトル」のように続けてよい。帯やキャッチコピー、シリーズ名、出版社名は含めない。
- author: 著者名だけ（「著」「編」「監修」「訳」などは付けない）。複数いる場合は「、」で区切る。読み取れなければ空文字。
- categoryId: 次の分類から、この本の内容に最も合うものの id を1つ。
${categories.map(c => `  ${c.id}: ${c.name}`).join('\n')}
表紙が読み取れない場合は title を空文字にしてください。推測で文字を補わないでください。`

/** 試すGeminiのモデル（指定があればそれを先に。gemini-flash-latest は常に最新のFlashを指す） */
const geminiModels = () => [...new Set([process.env.VISION_MODEL?.trim(), 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash'].filter((m): m is string => Boolean(m)))]

async function askGemini(p: Provider, image: string, mimeType: string, categories: Category[]): Promise<CoverInfo> {
  for (const model of geminiModels()) {
    try { return await askGeminiModel(p, model, image, mimeType, categories) } catch (e) {
      if (!(e instanceof UpstreamError && e.status === 404)) throw e
      console.warn(`vision model ${model} is not available`)
    }
  }
  throw new UpstreamError(404, 'no available vision model')
}

async function askGeminiModel(p: Provider, model: string, image: string, mimeType: string, categories: Category[]): Promise<CoverInfo> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: image } }, { text: instructions(categories) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { title: { type: 'STRING' }, author: { type: 'STRING' }, categoryId: { type: 'STRING', enum: categories.map(c => c.id) } }, required: ['title', 'author', 'categoryId'] },
      },
    }),
  })
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  return JSON.parse(data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') || '{}')
}

async function askOpenAI(p: Provider, image: string, mimeType: string, categories: Category[]): Promise<CoverInfo> {
  const model = process.env.VISION_MODEL?.trim() || 'gpt-4.1-mini'
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        { type: 'text', text: `${instructions(categories)}\n{"title": "...", "author": "...", "categoryId": "..."} のJSONだけを返してください。` },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}` } },
      ] }],
    }),
  })
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  return JSON.parse(data.choices?.[0]?.message?.content || '{}')
}

/** 保存済みの表紙（DriveのファイルID・画像URL）をサーバー側で取得する */
async function fetchCover(cover: string): Promise<{ image: string; mimeType: string } | null> {
  const urls = DRIVE_ID.test(cover)
    ? [`https://drive.google.com/thumbnail?id=${cover}&sz=w1200`, `https://lh3.googleusercontent.com/d/${cover}=w1200`]
    : /^https:\/\//.test(cover) ? [cover] : []
  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      const mimeType = res.headers.get('content-type')?.split(';')[0] ?? ''
      if (!res.ok || !mimeType.startsWith('image/')) continue
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > MAX_IMAGE_BYTES) continue
      return { image: bytes.toString('base64'), mimeType }
    } catch { /* 次の候補を試す */ }
  }
  return null
}

export async function POST(request: Request): Promise<Response> {
  const p = provider()
  if (!p) return notConfigured()
  if (!await authorized(request)) return unauthorized()

  let body: { image?: unknown; mimeType?: unknown; cover?: unknown; categories?: unknown }
  try { body = await request.json() } catch { return reply(400, { error: 'リクエストの形式が正しくありません' }) }
  const categories = Array.isArray(body.categories) ? (body.categories as Category[]).filter(c => typeof c?.id === 'string' && typeof c?.name === 'string').slice(0, 100) : []
  if (!categories.length) return reply(400, { error: 'categories を指定してください' })

  let source: { image: string; mimeType: string } | null
  if (typeof body.image === 'string' && body.image) {
    const mimeType = typeof body.mimeType === 'string' && body.mimeType.startsWith('image/') ? body.mimeType : 'image/jpeg'
    if (body.image.length * 0.75 > MAX_IMAGE_BYTES) return reply(413, { error: '画像が大きすぎます' })
    source = { image: body.image, mimeType }
  } else if (typeof body.cover === 'string' && body.cover.trim()) {
    source = await fetchCover(body.cover.trim())
    if (!source) return reply(422, { error: '表紙の画像を取得できませんでした。表紙フォルダの共有設定（リンクを知っている全員）を確認してください。', code: 'cover_unavailable' })
  } else return reply(400, { error: '表紙の画像がありません' })

  try {
    const info = p.name === 'gemini' ? await askGemini(p, source.image, source.mimeType, categories) : await askOpenAI(p, source.image, source.mimeType, categories)
    const text = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 300) : ''
    const categoryId = categories.some(c => c.id === info.categoryId) ? info.categoryId : ''
    return reply(200, { title: text(info.title), author: text(info.author), categoryId })
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) return reply(502, { error: '表紙の読み取りに使うAIモデルが見つかりませんでした。環境変数 VISION_MODEL に利用できるモデル名（例: gemini-flash-latest）を設定してください。', code: 'model_unavailable' })
    return upstreamFailure(e, '表紙の読み取り')
  }
}
