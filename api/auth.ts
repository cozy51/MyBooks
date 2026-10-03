// Googleのログインを保つための API（Vercel Function）。
// ブラウザだけで受け取るアクセストークンは1時間で切れてしまうので、ログインのときに「リフレッシュトークン」を受け取り、
// 暗号化して HttpOnly の Cookie に入れておく。アクセストークンが切れそうになったら、それを使って新しいトークンを発行する。
//   GOOGLE_CLIENT_SECRET … Google Cloud の OAuth クライアントのシークレット（未設定なら、この仕組みは使わない）
//   SESSION_SECRET … Cookie の暗号化に使う任意の長い文字列（未設定ならクライアントシークレットから作る）
// リクエスト: { action: 'exchange', code } ログイン時に受け取ったコードをトークンに交換する
//             { action: 'refresh' } Cookie のリフレッシュトークンで新しいアクセストークンを発行する
//             { action: 'signout' } リフレッシュトークンを無効にして Cookie を消す
import { reply } from './_lib.js'

const COOKIE = 'mybooks_session'
const MAX_AGE = 180 * 24 * 60 * 60
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const clientId = () => (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim()
const clientSecret = () => (process.env.GOOGLE_CLIENT_SECRET || '').trim()

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
async function cryptoKey(): Promise<CryptoKey> {
  const secret = (process.env.SESSION_SECRET || '').trim() || `mybooks-session:${clientSecret()}`
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function seal(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(text)))
  return base64url(new Uint8Array([...iv, ...data]))
}
async function unseal(value: string): Promise<string | null> {
  try {
    const bytes = new Uint8Array(Buffer.from(value, 'base64url'))
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await cryptoKey(), bytes.slice(12))
    return new TextDecoder().decode(data)
  } catch { return null }
}

const readCookie = (request: Request) => request.headers.get('cookie')?.split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/api/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`

interface TokenResult { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string }

async function tokenRequest(params: Record<string, string>): Promise<{ ok: boolean; data: TokenResult }> {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }) })
  return { ok: res.ok, data: await res.json().catch(() => ({})) as TokenResult }
}

const tokenReply = (data: TokenResult, headers?: Record<string, string>) =>
  Response.json({ access_token: data.access_token, expires_in: data.expires_in ?? 3600, scope: data.scope ?? '' }, { status: 200, headers: { 'Cache-Control': 'no-store', ...headers } })

export async function POST(request: Request): Promise<Response> {
  if (!clientId() || !clientSecret()) return reply(501, { error: 'GOOGLE_CLIENT_SECRET が未設定のため、ログインを保つ仕組みは使えません。', code: 'not_configured' })
  let body: { action?: unknown; code?: unknown }
  try { body = await request.json() } catch { return reply(400, { error: 'リクエストの形式が正しくありません' }) }

  if (body.action === 'exchange') {
    if (typeof body.code !== 'string' || !body.code) return reply(400, { error: 'ログインのコードがありません' })
    // Google Identity Services のポップアップで受け取ったコードは redirect_uri に 'postmessage' を指定して交換する
    const { ok, data } = await tokenRequest({ code: body.code, grant_type: 'authorization_code', redirect_uri: 'postmessage' })
    if (!ok || !data.access_token) return reply(400, { error: `Googleのログインに失敗しました（${data.error ?? 'unknown'}）` })
    if (!data.refresh_token) {
      // 以前に許可済みだとリフレッシュトークンが発行されないので、許可をいったん取り消して、次回は許可画面から受け取り直す
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(data.access_token)}`, { method: 'POST' }).catch(() => undefined)
      return reply(409, { error: 'ログインを保つための準備をしました。お手数ですが、もう一度ログインしてください（次回からはログインが切れなくなります）。', code: 'consent_required' })
    }
    return tokenReply(data, { 'Set-Cookie': cookie(await seal(data.refresh_token), MAX_AGE) })
  }

  if (body.action === 'refresh') {
    const sealed = readCookie(request)
    const refreshToken = sealed && await unseal(sealed)
    if (!refreshToken) return reply(401, { error: 'ログインしていません', code: 'signed_out' })
    const { ok, data } = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' })
    // 取り消された・期限が切れた（テスト中のアプリは7日で切れる）リフレッシュトークンは消す
    if (!ok || !data.access_token) return Response.json({ error: 'Googleのログインが切れました。もう一度ログインしてください。', code: 'signed_out' }, { status: 401, headers: { 'Cache-Control': 'no-store', 'Set-Cookie': cookie('', 0) } })
    return tokenReply(data)
  }

  if (body.action === 'signout') {
    const sealed = readCookie(request)
    const refreshToken = sealed && await unseal(sealed)
    if (refreshToken) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => undefined)
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': cookie('', 0) } })
  }

  return reply(400, { error: '不明な操作です' })
}
