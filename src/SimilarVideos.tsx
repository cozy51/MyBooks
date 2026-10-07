import { useEffect, useState } from 'react'
import { ChevronRight, LoaderCircle, Play, Sparkles, Tv } from 'lucide-react'
import { categories } from './data'
import { embedText, findSimilarBooks, updateBookMap } from './bookMapData'
import { videoItem } from './library'
import { ScoreBar } from './RelatedBooks'
import type { LibraryItem, YouTubeVideo } from './types'
import { cleanSummary, formatDuration } from './videoText'

function VideoRow({ video, score, ratio, onOpen }: { video: YouTubeVideo; score?: number; ratio?: number; onOpen: (v: YouTubeVideo) => void }) {
  const category = categories.find(c => c.id === (video.subCategory || video.category))
  const summary = cleanSummary(video.summary)
  return <li><div role="button" tabIndex={0} className="related-row" onClick={() => onOpen(video)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(video) } }}>
    <span className="related-cover related-thumb">{video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : <Play />}</span>
    <span className="related-body">
      <span className="related-title"><strong>{video.title}</strong></span>
      <small>{video.channelTitle}{category && ` ・ ${category.name}`}{formatDuration(video.duration) && ` ・ ${formatDuration(video.duration)}`}</small>
      {summary && <span className="related-memo">{summary.slice(0, 80)}{summary.length > 80 && '…'}</span>}
    </span>
    <span className="related-side">{score !== undefined && <ScoreBar score={score} ratio={ratio ?? 1} />}<ChevronRight /></span>
  </div></li>
}

/** Same embeddings as the classification map (title + AI summary), limited to videos. */
export function SimilarVideos({ video, videos, indexItems, onOpen }: { video: YouTubeVideo; videos: YouTubeVideo[]; indexItems: LibraryItem[]; onOpen: (v: YouTubeVideo) => void }) {
  const [result, setResult] = useState<{ id: string; items: { video: YouTubeVideo; score: number }[] | null } | null>(null)
  const [computing, setComputing] = useState(false), [error, setError] = useState('')
  const find = async () => {
    const byId = new Map(videos.map(v => [v.id, v]))
    const found = await findSimilarBooks(videoItem(video), videos.map(videoItem))
    return found && found.flatMap(f => { const v = byId.get(f.book.id); return v ? [{ video: v, score: f.score }] : [] })
  }
  useEffect(() => {
    let active = true
    void find().then(items => { if (active) setResult({ id: video.id, items }) })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, videos])
  const compute = async () => {
    setComputing(true); setError('')
    try {
      const { error } = await updateBookMap(indexItems, () => {})
      if (error) setError(error.message)
      setResult({ id: video.id, items: await find() })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setComputing(false) }
  }
  if (!embedText(videoItem(video))) return <p className="related-empty">タイトルがないため、内容が近い動画を探せません。</p>
  if (!result || result.id !== video.id) return <p className="related-empty"><LoaderCircle className="spin" /> 内容が近い動画を探しています…</p>
  if (!result.items) return <div className="related-empty">
    <p>この動画はまだ分類マップで計算されていません（AI解析の直後も再計算が必要です）。</p>
    <button type="button" className="secondary-btn" disabled={computing} onClick={() => void compute()}>{computing ? <LoaderCircle className="spin" /> : <Sparkles />} {computing ? '計算しています…' : '内容の近さを計算する'}</button>
    {error && <p className="field-error">{error}</p>}
  </div>
  if (!result.items.length) return <p className="related-empty">比べられる動画がまだありません。分類マップを開くと、ほかの動画も計算されます。</p>
  const scores = result.items.map(i => i.score), max = Math.max(...scores), min = Math.min(...scores)
  return <>
    <p className="related-lead"><Sparkles /> 分類マップと同じく、タイトルとAI要約の内容が近い順に{result.items.length}本を表示しています。</p>
    <ul className="related-list">{result.items.map(i => <VideoRow key={i.video.id} video={i.video} score={i.score} ratio={max > min ? (i.score - min) / (max - min) : 1} onOpen={onOpen} />)}</ul>
  </>
}

export function SameChannelVideos({ video, videos, onOpen }: { video: YouTubeVideo; videos: YouTubeVideo[]; onOpen: (v: YouTubeVideo) => void }) {
  const same = (v: YouTubeVideo) => video.channelId && v.channelId ? v.channelId === video.channelId : v.channelTitle === video.channelTitle
  const list = videos.filter(v => v.id !== video.id && same(v))
  if (!list.length) return <p className="related-empty">{video.channelTitle} の動画は、ほかに登録されていません。</p>
  return <>
    <p className="related-lead"><Tv /> {video.channelTitle} の動画が、ほかに{list.length}本あります。</p>
    <ul className="related-list">{list.map(v => <VideoRow key={v.id} video={v} onOpen={onOpen} />)}</ul>
  </>
}
