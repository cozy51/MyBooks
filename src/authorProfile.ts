// 著者プロフィール（著者ハブ）のデータ。サーバーの /api/author-profile で公開情報を集め、ブラウザ（IndexedDB）に覚えておく。
// 同じ著者を開くたびにWeb検索しないよう、取得した日時と一緒に保存し、「最新の情報に更新」を押したときだけ取り直す。
import { DRIVE_CLIENT_ID, signIn, storedReadToken, storedToken } from './drive'
import { loadLocal, saveLocal } from './embeddingStore'
import { authorKeys } from './authors'
import { categoryName } from './semanticSearch'
import type { Book } from './types'

export type SourceKind = 'wikipedia' | 'wikidata' | 'web' | 'mybooks' | 'youtube'
export interface ProfileSource { title: string; url?: string; kind: SourceKind; bookId?: string }
/** sources: 情報源の番号 / unverified: 検索結果はあるが、この項目の出典を確かめられなかった */
export interface ProfileField { value: string; sources: number[]; unverified?: boolean }
export interface Recommendation { title: string; note: string; sources: number[]; unverified?: boolean }
export interface Video { id: string; title: string; channel: string; publishedAt: string; thumbnail: string; url: string; kind: 'lecture' | 'interview' | 'talk' | 'other' }
export interface AuthorProfile {
  name: string
  /** yes: 同じ人物の公開情報が見つかった / unsure: 別人かもしれない / no: 見つからなかった */
  found: 'yes' | 'unsure' | 'no'
  identityNote: string
  photo: { url: string; source: number } | null
  birthDate: ProfileField | null
  /** 没年月日（亡くなっている場合だけ。以前に保存したプロフィールには無い） */
  deathDate?: ProfileField | null
  birthPlace: ProfileField | null
  occupation: ProfileField | null
  specialty: ProfileField | null
  career: ProfileField | null
  intro: ProfileField | null
  perspectives: ProfileField[]
  recommendations: Recommendation[]
  links: { label: string; url: string }[]
  /** null: YouTube Data API のキーが未設定（検索リンクだけ表示する） */
  videos: Video[] | null
  sources: ProfileSource[]
  queries: string[]
  /** 検索と、同じ人物かの判断に使った著書の分野・手がかり */
  topics?: string[]
  hint?: string
  fetchedAt: string
}

// 2: 名前だけで検索して同姓同名の別人の情報が混ざることがあったため、以前に保存した内容は使わない
const CACHE_VERSION = 2
const cacheKey = (name: string) => `author-profile-v${CACHE_VERSION}:${authorKeys(name)[0] ?? name}`

/** この著者の本（MyBooksに登録されているもの。著者欄のどれかが同じ） */
export function booksByAuthor(name: string, books: Book[]): Book[] {
  const key = authorKeys(name)[0]
  if (!key) return []
  return books.filter(b => authorKeys(b.author).includes(key)).sort((a, b) => a.title.localeCompare(b.title, 'ja'))
}

export const loadCachedProfile = (name: string) => loadLocal<AuthorProfile>(cacheKey(name))

// 人物を見分ける手がかり（所属・分野など。利用者が入力したもの）は、著者ごとにこのブラウザに覚える
const hintKey = (name: string) => `mybooks-author-hint:${authorKeys(name)[0] ?? name}`
export function loadHint(name: string): string { try { return localStorage.getItem(hintKey(name)) ?? '' } catch { return '' } }
export function saveHint(name: string, hint: string) { try { if (hint.trim()) localStorage.setItem(hintKey(name), hint.trim()); else localStorage.removeItem(hintKey(name)) } catch { /* noop */ } }

export async function fetchAuthorProfile(name: string, books: Book[], hint = loadHint(name)): Promise<AuthorProfile> {
  // サーバーはログイン中のユーザーからの依頼だけ受け付けるので、ログインしていなければ先にログインしてもらう
  const token = storedToken() ?? storedReadToken() ?? (DRIVE_CLIENT_ID ? await signIn() : null)
  const own = booksByAuthor(name, books).slice(0, 30)
  let res: Response
  try {
    // サーバーは52秒で打ち切って応答するが、通信が切れた場合にも待ち続けないよう65秒で止める
    res = await fetch('/api/author-profile', {
      signal: AbortSignal.timeout(65_000), method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ name, hint: hint.trim(), books: own.map(b => ({ id: b.id, title: b.title.trim(), category: categoryName(b.categoryId), summary: b.memo.trim() })) }),
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new Error('著者の情報の検索が時間内に終わりませんでした。もう一度お試しください。', { cause: e })
    throw new Error('著者プロフィールのAPIに接続できませんでした。ネットワークを確認してください。', { cause: e })
  }
  const data = await res.json().catch(() => null) as (AuthorProfile & { error?: string }) | null
  if (res.status === 404 && !data) throw new Error('著者プロフィールのAPI（/api/author-profile）が見つかりません。Vercelへのデプロイ、または npm run dev で起動してください。')
  if (!res.ok || !data?.fetchedAt) throw new Error(data?.error || `著者の情報を取得できませんでした（${res.status}）`)
  await saveLocal(cacheKey(name), data)
  return data
}

/** 書名を比べるためにそろえる（全角半角・空白・記号・副題の区切りの違いを無視する） */
const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/[\s「」『』【】()（）[\]〈〉《》:：・\-－―〜~!！?？.,、。]/g, '')

/** おすすめの本が MyBooks に登録済みか（同じ著者の本を優先し、書名の一方がもう一方を含めば同じ本とみなす） */
export function findOwned(title: string, name: string, books: Book[]): Book | undefined {
  const key = titleKey(title)
  if (key.length < 2) return undefined
  const match = (b: Book) => { const k = titleKey(b.title); return k === key || (Math.min(k.length, key.length) >= 4 && (k.includes(key) || key.includes(k))) }
  return booksByAuthor(name, books).find(match) ?? books.find(b => titleKey(b.title) === key)
}

