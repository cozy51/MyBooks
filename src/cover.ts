/** 表紙画像を置くGoogle Driveフォルダ */
export const COVER_FOLDER_ID = import.meta.env.VITE_DRIVE_COVER_FOLDER_ID?.trim() || '1nQ70ASmx51gP530IRPGp1ZZQnkxwp9vt'
export const COVER_FOLDER_URL = `https://drive.google.com/drive/folders/${COVER_FOLDER_ID}`

// Google Driveの共有リンク（/file/d/ID/view など）は<img>でそのまま表示できないため、
// ファイルIDを取り出してサムネイル用URLへ変換する。Drive以外のURLはそのまま使う。
const DRIVE_HOSTS = /(^|\.)(drive|docs)\.google\.com$|(^|\.)googleusercontent\.com$/
const DRIVE_ID = /^[\w-]{25,}$/

export function driveFileId(value: string): string | null {
  const text = value.trim()
  if (DRIVE_ID.test(text)) return text
  let url: URL
  try { url = new URL(text) } catch { return null }
  if (!DRIVE_HOSTS.test(url.hostname)) return null
  const pathId = url.pathname.match(/\/d\/([\w-]{25,})/)?.[1]
  if (pathId) return pathId
  const queryId = url.searchParams.get('id')
  return queryId && DRIVE_ID.test(queryId) ? queryId : null
}

/** 表示に使う画像URLの候補（先頭から順に試す） */
export function coverSources(value: string, width = 800): string[] {
  const text = value.trim()
  if (!text) return []
  const id = driveFileId(text)
  if (!id) return [text]
  return [
    `https://drive.google.com/thumbnail?id=${id}&sz=w${width}`,
    `https://lh3.googleusercontent.com/d/${id}=w${width}`,
  ]
}

/** 保存用の値。Driveの画像はファイルIDだけを保存し、それ以外のURLはそのまま */
export function normalizeCover(value: string): string {
  return driveFileId(value) ?? value.trim()
}

/** ファイルIDのとき、Driveでそのファイルを開くURL */
export function driveFileUrl(value: string): string | null {
  const id = driveFileId(value)
  return id ? `https://drive.google.com/file/d/${id}/view` : null
}

/** タイトルと著者で Amazon の「本」カテゴリを検索する URL（表紙画像を探すため）。タイトルが空なら null */
export function amazonSearchUrl(title: string, author = ''): string | null {
  const q = [title, author].map(s => s.trim()).filter(Boolean).join(' ')
  return title.trim() ? `https://www.amazon.co.jp/s?k=${encodeURIComponent(q)}&i=stripbooks` : null
}
