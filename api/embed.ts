// 本の分類マップ用の Embedding API（Vercel Function）。
// APIキーはサーバー側の環境変数だけで扱い、フロントエンドには渡さない。
//   GEMINI_API_KEY（推奨）または OPENAI_API_KEY … どちらか一方を設定
//   EMBEDDING_MODEL … モデル名を変えるときだけ設定（既定: gemini-embedding-001 / text-embedding-3-small）
// アプリの Google ログインで得たアクセストークンを確認し、このアプリの利用者以外からは使えないようにする。

const DIMENSIONS = 256
const MAX_TEXTS = 100
const MAX_CHARS = 2000

type Provider = { name: 'gemini' | 'openai'; key: string; model: string }

function provider(): Provider | null {
  const env = process.env
  const model = env.EMBEDDING_MODEL?.trim()
  if (env.GEMINI_API_KEY?.trim()) return { name: 'gemini', key: env.GEMINI_API_KEY.trim(), model: model || 'gemini-embedding-001' }
  if (env.OPENAI_API_KEY?.trim()) return { name: 'openai', key: env.OPENAI_API_KEY.trim(), model: model || 'text-embedding-3-small' }
  return null
}

const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

// 確認済みのトークン（同じインスタンスで何度も Google に問い合わせないため）
const verified = new Map<string, number>()

/** Google のアクセストークンが、このアプリ（OAuthクライアントID）に発行されたものか確かめる */
async function authorized(request: Request): Promise<boolean> {
  const clientId = (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim()
  if (!clientId) return true // Drive連携を使わない構成では確認しない
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return false
  if ((verified.get(token) ?? 0) > Date.now()) return true
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`)
  if (!res.ok) return false
  const info = await res.json() as { aud?: string; azp?: string; expires_in?: string }
  if (info.aud !== clientId && info.azp !== clientId) return false
  verified.set(token, Date.now() + Math.min(Number(info.expires_in) || 0, 600) * 1000)
  return true
}

async function embedGemini(p: Provider, texts: string[]): Promise<number[][]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${p.model}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({ requests: texts.map(text => ({ model: `models/${p.model}`, content: { parts: [{ text }] }, taskType: 'CLUSTERING', outputDimensionality: DIMENSIONS })) }),
  })
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  const data = await res.json() as { embeddings: { values: number[] }[] }
  return data.embeddings.map(e => e.values)
}

async function embedOpenAI(p: Provider, texts: string[]): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({ model: p.model, input: texts, dimensions: DIMENSIONS }),
  })
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  const data = await res.json() as { data: { index: number; embedding: number[] }[] }
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}

class UpstreamError extends Error {
  status: number
  constructor(status: number, detail: string) { super(detail.slice(0, 300)); this.status = status }
}

export async function POST(request: Request): Promise<Response> {
  const p = provider()
  if (!p) return reply(503, { error: 'Embeddingが未設定です。サーバーの環境変数 GEMINI_API_KEY（または OPENAI_API_KEY）を設定してください。', code: 'not_configured' })
  if (!await authorized(request)) return reply(401, { error: 'Google Driveに接続（ログイン）してから、もう一度お試しください。', code: 'unauthorized' })

  let texts: unknown
  try { texts = (await request.json() as { texts?: unknown }).texts } catch { /* 下で弾く */ }
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS || !texts.every(t => typeof t === 'string' && t.trim()))
    return reply(400, { error: `texts には空でない文字列を1〜${MAX_TEXTS}件指定してください` })

  try {
    const input = (texts as string[]).map(t => t.slice(0, MAX_CHARS))
    const vectors = p.name === 'gemini' ? await embedGemini(p, input) : await embedOpenAI(p, input)
    return reply(200, { model: `${p.name}:${p.model}:${DIMENSIONS}`, vectors })
  } catch (e) {
    const status = e instanceof UpstreamError ? e.status : 0
    console.error('embedding failed', status, e instanceof Error ? e.message : e)
    if (status === 429) return reply(429, { error: 'Embedding APIの利用上限に達しました。少し待ってから再試行してください。', code: 'rate_limited' })
    return reply(502, { error: `Embedding APIの呼び出しに失敗しました（${status || '通信エラー'}）` })
  }
}
