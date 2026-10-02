// 本の分類マップ・意味検索用の Embedding API（Vercel Function）。
//   task … clustering（マップ。既定）/ document（検索される本）/ query（検索文）
//   dimensions … 256（既定）または 768
//   EMBEDDING_MODEL … モデル名を変えるときだけ設定（既定: gemini-embedding-001 / text-embedding-3-small）
// アプリの Google ログインで得たアクセストークンを確認し、このアプリの利用者以外からは使えないようにする。
import { authorized, notConfigured, provider, reply, unauthorized, upstreamFailure, UpstreamError, type Provider } from './_lib.js'

const DIMENSIONS = [256, 768]
type Task = 'clustering' | 'document' | 'query'
const GEMINI_TASK: Record<Task, string> = { clustering: 'CLUSTERING', document: 'RETRIEVAL_DOCUMENT', query: 'RETRIEVAL_QUERY' }
const MAX_TEXTS = 100
const MAX_CHARS = 2000

async function embedGemini(p: Provider, model: string, texts: string[], task: Task, dimensions: number): Promise<number[][]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({ requests: texts.map(text => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: GEMINI_TASK[task], outputDimensionality: dimensions })) }),
  })
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  const data = await res.json() as { embeddings: { values: number[] }[] }
  return data.embeddings.map(e => e.values)
}

// OpenAI には用途の指定がないので、task は使わない
async function embedOpenAI(p: Provider, model: string, texts: string[], dimensions: number): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({ model, input: texts, dimensions }),
  })
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  const data = await res.json() as { data: { index: number; embedding: number[] }[] }
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}

export async function POST(request: Request): Promise<Response> {
  const p = provider()
  if (!p) return notConfigured()
  if (!await authorized(request)) return unauthorized()

  let body: { texts?: unknown; task?: unknown; dimensions?: unknown } = {}
  try { body = await request.json() } catch { /* 下で弾く */ }
  const { texts } = body
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS || !texts.every(t => typeof t === 'string' && t.trim()))
    return reply(400, { error: `texts には空でない文字列を1〜${MAX_TEXTS}件指定してください` })
  const task = (body.task ?? 'clustering') as Task
  if (!(task in GEMINI_TASK)) return reply(400, { error: 'task は clustering・document・query のいずれかです' })
  const dimensions = Number(body.dimensions ?? DIMENSIONS[0])
  if (!DIMENSIONS.includes(dimensions)) return reply(400, { error: `dimensions は ${DIMENSIONS.join('・')} のいずれかです` })

  const model = process.env.EMBEDDING_MODEL?.trim() || (p.name === 'gemini' ? 'gemini-embedding-001' : 'text-embedding-3-small')
  try {
    const input = (texts as string[]).map(t => t.slice(0, MAX_CHARS))
    const vectors = p.name === 'gemini' ? await embedGemini(p, model, input, task, dimensions) : await embedOpenAI(p, model, input, dimensions)
    return reply(200, { model: `${p.name}:${model}:${dimensions}`, vectors })
  } catch (e) { return upstreamFailure(e, 'Embedding API') }
}
