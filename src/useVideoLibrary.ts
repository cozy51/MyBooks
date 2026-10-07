import { useCallback, useRef, useState } from 'react'
import * as drive from './drive'
import { appendVideos, mergeVideoLibraries, loadVideos, validateVideos, VIDEO_STORE, VIDEO_SYNC_KEY } from './library'
import { useDriveSync, type SyncAdapter } from './useDriveSync'
import { fetchLikedVideos } from './youtube'
import type { YouTubeVideo } from './types'
const FILE = 'MyBooks-youtube.json'
const adapter: SyncAdapter<YouTubeVideo> = {
  mergeRemote: mergeVideoLibraries, metaKey: 'mybooks-youtube-drive-v1', getFile: drive.getFile,
  findFile: token => drive.findNamedFile(token, FILE),
  download: async (token, id) => {
    const data = await drive.readJsonFile<unknown>(token, id)
    if (!data || typeof data !== 'object' || !('videos' in data)) throw new Error('Driveの動画データの形式が正しくありません')
    return validateVideos(data.videos)
  },
  create: (token, videos) => drive.writeJsonFile(token, FILE, { version: 1, videos }),
  update: (token, id, videos) => drive.writeJsonFile(token, FILE, { version: 1, videos }, id),
}
export function useVideoLibrary() {
  const [initial] = useState(() => { try { return { videos: loadVideos(), error: '' } } catch (e) { return { videos: [] as YouTubeVideo[], error: e instanceof Error ? e.message : '動画データを読み込めませんでした。' } } })
  const [videos, setVideos] = useState(initial.videos)
  const [storageError, setStorageError] = useState(initial.error)
  const ref = useRef(videos)
  const store = useCallback((next: YouTubeVideo[]) => {
    try { localStorage.setItem(VIDEO_STORE, JSON.stringify(next)) } catch { throw new Error('動画データをブラウザに保存できませんでした。空き容量やブラウザの保存設定をご確認ください。') }
    ref.current = next; setVideos(next); setStorageError('')
  }, [])
  const sync = useDriveSync(VIDEO_STORE, videos, store, adapter, !storageError)
  const [syncing, setSyncing] = useState(false), [message, setMessage] = useState(''), [lastSync, setLastSync] = useState(() => localStorage.getItem(VIDEO_SYNC_KEY) || '')
  const busy = useRef(false)
  const save = (next: YouTubeVideo[]) => { store(next); sync.markDirty(next) }
  const update = (video: YouTubeVideo) => save(ref.current.map(v => v.videoId === video.videoId ? video : v))
  const importLiked = async () => {
    if (storageError) { setMessage(storageError); return }
    if (busy.current) return
    busy.current = true; setSyncing(true); setMessage('Googleの権限を確認しています…')
    try {
      const incoming = await fetchLikedVideos(count => setMessage(`高評価動画を取得中：${count}件…`))
      const result = appendVideos(ref.current, incoming)
      save(result.videos)
      const now = new Date().toISOString(); localStorage.setItem(VIDEO_SYNC_KEY, now); setLastSync(now)
      setMessage(incoming.length ? `YouTube同期完了 取得：${incoming.length}件／新規：${result.added}件／登録済み：${result.existing}件` : '高評価した動画がありませんでした。既存の動画は保持しています。')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'YouTube同期に失敗しました。再試行してください。') }
    finally { busy.current = false; setSyncing(false) }
  }
  return { videos, ref, save, update, sync, storageError, syncing, message, lastSync, importLiked }
}
