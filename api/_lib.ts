// api/ の Vercel Function で共通に使う処理（ファイル名が _ で始まるので、これ自体は公開されない）。
// APIキーはサーバー側の環境変数だけで扱い、フロントエンドには渡さない。
//   GEMINI_API_KEY（推奨）または OPENAI_API_KEY … どちらか一方を設定

export type ProviderName = 'gemini' | 'openai'
export interface Provider { name: ProviderName; key: string }

export function provider(): Provider | null {
  const env = process.env
  if (env.GEMINI_API_KEY?.trim()) return { name: 'gemini', key: env.GEMINI_API_KEY.trim() }
  if (env.OPENAI_API_KEY?.trim()) return { name: 'openai', key: env.OPENAI_API_KEY.trim() }
  return null
}

export const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export const notConfigured = () => reply(503, { error: 'AIのAPIキーが未設定です。サーバーの環境変数 GEMINI_API_KEY（または OPENAI_API_KEY）を設定してください。', code: 'not_configured' })
export const unauthorized = () => reply(401, { error: 'Google Driveに接続（ログイン）してから、もう一度お試しください。', code: 'unauthorized' })

export class UpstreamError extends Error {
  status: number
  constructor(status: number, detail: string) { super(detail.slice(0, 300)); this.status = status }
}

/** 外部AI APIの失敗を、画面に出せるメッセージにする */
export function upstreamFailure(e: unknown, label: string) {
  const status = e instanceof UpstreamError ? e.status : 0
  console.error(`${label} failed`, status, e instanceof Error ? e.message : e)
  if (status === 429) return reply(429, { error: `${label}の利用上限に達しました。少し待ってから再試行してください。`, code: 'rate_limited' })
  return reply(502, { error: `${label}の呼び出しに失敗しました（${status || '通信エラー'}）` })
}

// 確認済みのトークン（同じインスタンスで何度も Google に問い合わせないため）
const verified = new Map<string, number>()

/** Google のアクセストークンが、このアプリ（OAuthクライアントID）に発行されたものか確かめる */
export async function authorized(request: Request): Promise<boolean> {
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

/** 試すGeminiのモデル（指定があればそれを先に。gemini-flash-latest は常に最新のFlashを指す）。404のときは次を試す */
export const geminiModels = (preferred?: string) => [...new Set([preferred?.trim(), 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash'].filter((m): m is string => Boolean(m)))]

/** 制限時間つきの fetch（時間切れは 504 として扱う） */
export async function fetchBefore(deadline: number, url: string, init: RequestInit = {}): Promise<Response> {
  const remaining = deadline - Date.now()
  if (remaining <= 1000) throw new UpstreamError(504, 'timeout')
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(remaining) }) } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new UpstreamError(504, 'timeout')
    throw e
  }
}
