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
