import { useEffect, useRef, useState } from 'react'
import { Bookmark, BookmarkPlus, Play, Trash2 } from 'lucide-react'
import { CopyButton } from './CopyButton'
import type { PlayerHandle } from './youtubePlayer'
import type { VideoBookmark, YouTubeVideo } from './types'
import { bookmarkLines, formatTime, parseTime } from './videoText'

/** Notta-style bookmarks: add the current position with a note, click the time to jump back. */
export function VideoBookmarks({ video, playerRef, onChange }: { video: YouTubeVideo; playerRef: React.RefObject<PlayerHandle | null>; onChange: (bookmarks: VideoBookmark[]) => void }) {
  const bookmarks = [...(video.bookmarks ?? [])].sort((a, b) => a.time - b.time)
  const [focusId, setFocusId] = useState('')
  const add = () => {
    const b: VideoBookmark = { id: crypto.randomUUID(), time: Math.floor(playerRef.current?.currentTime() ?? 0), note: '', createdAt: new Date().toISOString() }
    onChange([...bookmarks, b]); setFocusId(b.id)
  }
  const edit = (id: string, patch: Partial<VideoBookmark>) => onChange(bookmarks.map(b => b.id === id ? { ...b, ...patch } : b))
  return <aside className="video-bookmarks" aria-label="ブックマーク">
    <div className="video-bookmarks-head"><h4><Bookmark />ブックマーク<span>{bookmarks.length}</span></h4>{bookmarks.length > 0 && <CopyButton text={bookmarkLines(video)} title="ブックマークをコピー" />}</div>
    <button type="button" className="video-bookmark-add" onClick={add}><BookmarkPlus />現在の再生位置を追加</button>
    <p className="video-bookmarks-hint">再生中に押すと、その位置を記録します。時刻を押すとその位置から再生します。</p>
    {bookmarks.length === 0 ? <p className="video-bookmarks-empty">まだブックマークはありません</p>
      : <ul>{bookmarks.map(b => <BookmarkRow key={b.id} bookmark={b} autoFocus={b.id === focusId} onJump={() => playerRef.current?.seek(b.time)} onEdit={patch => edit(b.id, patch)} onDelete={() => onChange(bookmarks.filter(x => x.id !== b.id))} />)}</ul>}
  </aside>
}

function BookmarkRow({ bookmark, autoFocus, onJump, onEdit, onDelete }: { bookmark: VideoBookmark; autoFocus: boolean; onJump: () => void; onEdit: (patch: Partial<VideoBookmark>) => void; onDelete: () => void }) {
  // Drafts are saved on blur so each keystroke doesn't rewrite storage and Drive.
  const [note, setNote] = useState(bookmark.note), [time, setTime] = useState(formatTime(bookmark.time))
  const noteRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (autoFocus) noteRef.current?.focus() }, [autoFocus])
  const saveTime = () => { const t = parseTime(time); if (t === null) setTime(formatTime(bookmark.time)); else if (t !== bookmark.time) onEdit({ time: t }) }
  return <li className="video-bookmark">
    <div className="video-bookmark-top">
      <button type="button" className="video-bookmark-jump" title="この位置から再生" aria-label={`${formatTime(bookmark.time)}から再生`} onClick={onJump}><Play /></button>
      <input className="video-bookmark-time" aria-label="時刻" value={time} onChange={e => setTime(e.target.value)} onBlur={saveTime} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      <button type="button" className="video-bookmark-delete" title="削除" aria-label="ブックマークを削除" onClick={onDelete}><Trash2 /></button>
    </div>
    <textarea ref={noteRef} rows={2} placeholder="コメント（例：ここが要点）" value={note} onChange={e => setNote(e.target.value)} onBlur={() => { if (note !== bookmark.note) onEdit({ note }) }} />
  </li>
}
