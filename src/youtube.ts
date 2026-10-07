import { clearYouTubeToken, signInForYouTube } from './drive'
import type { YouTubeVideo } from './types'
interface VideoResponse { items?: { id: string; snippet: { title: string; channelTitle: string; channelId?: string; description?: string; publishedAt?: string; thumbnails?: Record<string, { url: string }> }; contentDetails?: { duration?: string } }[]; nextPageToken?: string; error?: { errors?: { reason?: string }[] } }
export async function fetchLikedVideos(onProgress: (count: number) => void, signal?: AbortSignal): Promise<YouTubeVideo[]> {
  let token: string
  try { token = await signInForYouTube() } catch (e) {
    throw new Error(e instanceof TypeError ? 'Googleの認証サービスに接続できませんでした。ネットワークを確認して再試行してください。' : e instanceof Error ? e.message : 'Googleの認証に失敗しました。再試行してください。', { cause: e })
  }
  const videos: YouTubeVideo[] = [], pages = new Set<string>()
  let page = ''
  do {
    const params = new URLSearchParams({ part: 'snippet,contentDetails', myRating: 'like', maxResults: '50', ...(page && { pageToken: page }) })
    let res: Response
    try { res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }) }
    catch { if (signal?.aborted) throw new Error('YouTube同期を中止しました'); throw new Error('YouTubeに接続できませんでした。ネットワークを確認して再試行してください。') }
    const data = await res.json().catch(() => null) as VideoResponse | null
    if (!res.ok) {
      const reason = data?.error?.errors?.[0]?.reason
      if (res.status === 401) { clearYouTubeToken(); throw new Error('Googleのログインが切れました。もう一度YouTubeと同期してください。') }
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || res.status === 429) throw new Error('YouTube APIの利用上限に達しました。時間をおいて再試行してください。')
      if (reason === 'accessNotConfigured') throw new Error('YouTube Data API v3が有効になっていません。Google Cloudの設定をご確認ください。')
      if (res.status === 403) { clearYouTubeToken(); throw new Error('YouTubeの読み取り権限がありません。同期時にGoogleの許可画面で許可してください。') }
      throw new Error('YouTubeの動画を取得できませんでした。時間をおいて再試行してください。')
    }
    if (!data || !Array.isArray(data.items)) throw new Error('YouTubeの応答を読み取れませんでした。再試行してください。')
    const now = new Date().toISOString()
    for (const v of data.items) if (/^[\w-]{11}$/.test(v.id) && v.snippet) videos.push({ id: `youtube:${v.id}`, type: 'youtube', videoId: v.id, title: v.snippet.title, channelTitle: v.snippet.channelTitle, channelId: v.snippet.channelId, description: v.snippet.description, thumbnailUrl: (v.snippet.thumbnails?.high || v.snippet.thumbnails?.medium || v.snippet.thumbnails?.default)?.url, videoUrl: `https://www.youtube.com/watch?v=${v.id}`, publishedAt: v.snippet.publishedAt, duration: v.contentDetails?.duration, createdAt: now, updatedAt: now })
    onProgress(videos.length)
    page = data.nextPageToken || ''
    if (page && pages.has(page)) throw new Error('YouTubeのページ取得を続けられませんでした。再試行してください。')
    pages.add(page)
  } while (page)
  return videos
}
