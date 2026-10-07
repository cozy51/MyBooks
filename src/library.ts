import type { Book, LibraryItem, YouTubeVideo } from './types'
export const VIDEO_STORE = 'mybooks-youtube-v1'
export const VIDEO_SYNC_KEY = 'mybooks-youtube-last-sync'
export function bookItem(book: Book): LibraryItem { return { ...book, type: 'book' } }
export function videoItem(video: YouTubeVideo): LibraryItem {
  return { id: `youtube:${video.videoId}`, type: 'youtube', title: video.title, author: video.channelTitle,
    categoryId: video.subCategory || video.category || '', cover: video.thumbnailUrl || '', baseMonth: video.publishedAt?.slice(0, 7) || '',
    status: '未読', memo: video.summary || '', description: video.description, tags: video.tags, embeddingText: video.embeddingText,
    links: [{ id: video.videoId, label: 'YouTube', url: video.videoUrl }], updatedAt: video.updatedAt }
}
/** Existing entries (including AI results) always win; sync only adds new IDs. The order follows
 * YouTube's liked list (most recent like first); videos YouTube no longer returns move to the end.
 * A video unliked here and liked again on YouTube becomes visible again. */
export function appendVideos(existing: YouTubeVideo[], incoming: YouTubeVideo[]) {
  const byId = new Map(existing.map(v => [v.videoId, v])), seen = new Set<string>(), ordered: YouTubeVideo[] = []
  const now = new Date().toISOString()
  let added = 0, reliked = 0
  for (const v of incoming) {
    if (seen.has(v.videoId)) continue
    seen.add(v.videoId)
    const old = byId.get(v.videoId)
    if (!old) { added++; ordered.push(v) }
    else if (old.unlikedAt) { reliked++; ordered.push({ ...old, unlikedAt: undefined, updatedAt: now }) }
    else ordered.push(old)
  }
  return { videos: [...ordered, ...existing.filter(v => !seen.has(v.videoId))], added: added + reliked, existing: incoming.length - added - reliked }
}
export function validateVideos(value: unknown): YouTubeVideo[] {
  if (!Array.isArray(value)) throw new Error('動画データの形式が正しくありません')
  const seen = new Set<string>()
  return value.map((v: YouTubeVideo) => {
    if (!v || typeof v.videoId !== 'string' || !/^[\w-]{11}$/.test(v.videoId) || typeof v.title !== 'string' || typeof v.channelTitle !== 'string') throw new Error('動画データの形式が正しくありません')
    if (['summary', 'description', 'duration', 'publishedAt', 'analyzedAt', 'embeddingText', 'aiComment', 'recommendedFor', 'category', 'subCategory'].some(k => v[k as keyof YouTubeVideo] !== undefined && typeof v[k as keyof YouTubeVideo] !== 'string') || ['tags', 'keyPoints'].some(k => v[k as keyof YouTubeVideo] !== undefined && (!Array.isArray(v[k as keyof YouTubeVideo]) || !(v[k as keyof YouTubeVideo] as unknown[]).every(x => typeof x === 'string')))) throw new Error('動画データの形式が正しくありません')
    for (const field of ['createdAt', 'updatedAt', 'analyzedAt', 'unlikedAt'] as const) if (v[field] !== undefined && (typeof v[field] !== 'string' || !Number.isFinite(Date.parse(v[field]!)))) throw new Error('動画データの日付形式が正しくありません')
    if (v.bookmarks !== undefined && (!Array.isArray(v.bookmarks) || v.bookmarks.some(b => !b || typeof b.id !== 'string' || typeof b.note !== 'string' || typeof b.time !== 'number' || !Number.isFinite(b.time) || b.time < 0 || typeof b.createdAt !== 'string' || !Number.isFinite(Date.parse(b.createdAt))))) throw new Error('動画データのブックマーク形式が正しくありません')
    for (const field of ['concreteAbstractScore', 'technicalSocialScore'] as const) if (v[field] !== undefined && (typeof v[field] !== 'number' || !Number.isFinite(v[field]) || v[field]! < 0 || v[field]! > 100)) throw new Error('動画データの分類スコアが正しくありません')
    return { ...v, id: `youtube:${v.videoId}`, type: 'youtube' as const, videoUrl: `https://www.youtube.com/watch?v=${v.videoId}`, thumbnailUrl: typeof v.thumbnailUrl === 'string' && /^https:\/\/(i\.ytimg\.com|img\.youtube\.com)\//.test(v.thumbnailUrl) ? v.thumbnailUrl : '', createdAt: v.createdAt ? new Date(v.createdAt).toISOString() : new Date().toISOString(), updatedAt: v.updatedAt ? new Date(v.updatedAt).toISOString() : new Date().toISOString() }
  }).filter(v => { if (seen.has(v.videoId)) return false; seen.add(v.videoId); return true })
}
export function loadVideos(): YouTubeVideo[] {
  try { return validateVideos(JSON.parse(localStorage.getItem(VIDEO_STORE) || '[]')) } catch { throw new Error('ブラウザの動画データを読み込めません。元のデータは保持しています。バックアップの動画データを読み込んで復元してください。') }
}

/** Union across devices. The newest saved analysis wins; no liked video is deleted. */
export function mergeVideoLibraries(local: YouTubeVideo[], remote: YouTubeVideo[]): YouTubeVideo[] {
  const byId = new Map(local.map(v => [v.videoId, v]))
  for (const video of remote) {
    const old = byId.get(video.videoId)
    if (!old || video.updatedAt > old.updatedAt) byId.set(video.videoId, video)
  }
  return [...byId.values()]
}
