import { useEffect, useRef, useState } from 'react'
import { Bookmark, ExternalLink, Play, Sparkles, ThumbsUp, Tv, X } from 'lucide-react'
import { categories } from './data'
import type { VideoBookmark, YouTubeVideo } from './types'
import { loadYouTubeApi, type PlayerHandle, type YTPlayer } from './youtubePlayer'
import { VideoBookmarks } from './VideoBookmarks'
import { SameChannelVideos, SimilarVideos } from './SimilarVideos'
import type { LibraryItem } from './types'
import { CopyButton } from './CopyButton'
import { cleanSummary, formatDuration, videoCopyText } from './videoText'
/** Thumbnail that turns into an embedded player in place when clicked. With `handle`, the
 * position can be read and changed (bookmarks); the plain iframe is the fallback if the API won't load. */
function VideoPlayer({ video, className = '', handleRef }: { video: YouTubeVideo; className?: string; handleRef?: React.RefObject<PlayerHandle | null> }) {
  const [start, setStart] = useState<number | null>(null), [apiFailed, setApiFailed] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!handleRef) return
    if (start === null) { handleRef.current = { currentTime: () => null, seek: t => setStart(t) }; return }
    if (apiFailed || !host.current) { handleRef.current = { currentTime: () => null, seek: () => {} }; return }
    let player: YTPlayer | null = null, ready = false, cancelled = false
    const el = document.createElement('div'); host.current.replaceChildren(el)
    handleRef.current = { currentTime: () => ready ? player!.getCurrentTime() : start, seek: t => { if (ready) { player!.seekTo(t, true); player!.playVideo() } } }
    loadYouTubeApi().then(YT => {
      if (cancelled) return
      player = new YT.Player(el, { videoId: video.videoId, host: 'https://www.youtube-nocookie.com', playerVars: { autoplay: 1, rel: 0, start: Math.floor(start), playsinline: 1 }, events: { onReady: () => { ready = true } } })
    }).catch(() => { if (!cancelled) setApiFailed(true) })
    return () => { cancelled = true; player?.destroy() }
  }, [handleRef, start, apiFailed, video.videoId])
  if (start === null) return <button type="button" className={`video-thumbnail ${className}`} aria-label={`${video.title}を再生`} onClick={e => { e.stopPropagation(); setStart(0) }}>{video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" loading="lazy" onError={e => { e.currentTarget.hidden = true }} />}<span className="video-play"><Play /></span></button>
  return <div className={`video-thumbnail ${className}`} onClick={e => e.stopPropagation()}>{handleRef && !apiFailed
    ? <div ref={host} className="video-frame" />
    : <iframe src={`https://www.youtube-nocookie.com/embed/${video.videoId}?autoplay=1&rel=0&start=${Math.floor(start)}`} title={video.title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />}</div>
}
export function VideoCard({ video, onOpen, selected, onSelect, onAnalyze, onUnlike, busy }: { video: YouTubeVideo; onOpen: () => void; selected: boolean; onSelect: () => void; onAnalyze?: () => void; onUnlike?: () => void; busy?: boolean }) {
  const category = categories.find(c => c.id === (video.subCategory || video.category))
  return <article className="book-card video-card" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen() }}>
    <VideoPlayer video={video} />
    <div className="card-body"><div className="category-line"><b>{!!video.bookmarks?.length && <span className="video-bookmarked" title={`ブックマーク ${video.bookmarks.length}件`} aria-label={`ブックマーク ${video.bookmarks.length}件`}><Bookmark />{video.bookmarks.length}</span>}{category?.name || '未分類'}</b></div>
      <div className="video-title"><input type="checkbox" className="video-check" aria-label={`${video.title}を選択`} checked={selected} onClick={e => e.stopPropagation()} onChange={onSelect} /><h3>{video.title}</h3></div>
      <p className="author">{video.channelTitle}</p>
      <div className="video-actions"><div><button type="button" className={`video-analyze${video.analyzedAt ? ' done' : ''}`} disabled={busy || !!video.analyzedAt || !onAnalyze} onClick={e => { e.stopPropagation(); onAnalyze?.() }}><Sparkles size={12} />{busy ? '解析中…' : video.analyzedAt ? 'AI解析済み' : 'AI解析'}</button>{video.summary && <CopyButton text={videoCopyText(video)} title="タイトル・URL・AI要約・重要ポイントをコピー" />}<a className="video-open" href={video.videoUrl} target="_blank" rel="noopener noreferrer" aria-label="YouTubeで見る" title="YouTubeで見る" onClick={e => e.stopPropagation()}><ExternalLink size={14} /></a>{onUnlike && <button type="button" className="video-unlike" aria-label="YouTubeのいいねを解除" title="YouTubeのいいねを解除" onClick={e => { e.stopPropagation(); onUnlike() }}><ThumbsUp /></button>}</div></div>
      <p className="video-excerpt">{cleanSummary(video.summary) || 'AI未解析'}</p><div className="video-foot"><small>{video.publishedAt?.slice(0, 7)}</small>{formatDuration(video.duration) && <small className="video-duration">{formatDuration(video.duration)}</small>}</div></div>
  </article>
}
export function VideoModal({ video, onClose, onAnalyze, onUnlike, onBookmarks, related, busy }: { video: YouTubeVideo; onClose: () => void; onAnalyze?: () => void; onUnlike?: () => void; onBookmarks?: (bookmarks: VideoBookmark[]) => void; related?: { videos: YouTubeVideo[]; indexItems: LibraryItem[]; onOpen: (v: YouTubeVideo) => void }; busy?: boolean }) {
  const player = useRef<PlayerHandle | null>(null)
  const [tab, setTab] = useState<'detail' | 'similar' | 'channel'>('detail')
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [onClose])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="modal video-modal" role="dialog" aria-modal="true" aria-label="動画の詳細"><div className="modal-head"><h2><Play /> 動画の詳細</h2>{related && <div className="modal-tabs" role="tablist">{([['detail', <><Play /> 詳細</>], ['similar', <><Sparkles /> 類似する動画</>], ['channel', <><Tv /> 同じチャンネル</>]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : undefined} onClick={() => setTab(id)}>{label}</button>)}</div>}<button className="icon-btn" aria-label="閉じる" onClick={onClose}><X /></button></div>
  {related && tab === 'similar' && <div className="related-panel"><SimilarVideos video={video} videos={related.videos} indexItems={related.indexItems} onOpen={related.onOpen} /></div>}
  {related && tab === 'channel' && <div className="related-panel"><SameChannelVideos video={video} videos={related.videos} onOpen={related.onOpen} /></div>}
  {tab === 'detail' && <div className="video-modal-body"><div className="video-detail">
    <VideoPlayer video={video} className="video-detail-player" handleRef={player} /><h3>{video.title}</h3><p>{video.channelTitle} · {video.publishedAt?.slice(0, 10)} {formatDuration(video.duration) && `· ${formatDuration(video.duration)}`}</p><a className="secondary-btn" href={video.videoUrl} target="_blank" rel="noopener noreferrer">YouTubeで見る <ExternalLink /></a>{video.summary && <CopyButton text={videoCopyText(video)} label="まとめてコピー" title="タイトル・URL・AI要約・重要ポイントをコピー" />}{onUnlike && <button type="button" className="video-unlike-btn" onClick={onUnlike}><ThumbsUp />いいねを解除</button>}
    <section><h4>AI要約{video.summary && <CopyButton text={cleanSummary(video.summary)} title="AI要約をコピー" />}</h4><p className="video-summary">{cleanSummary(video.summary) || 'AI未解析'}</p><small>タイトル・概要欄・チャンネル名をもとにした整理です。動画本編・字幕は確認していません。</small></section>
    {!video.analyzedAt && <button className="primary-btn" disabled={busy || !onAnalyze} onClick={onAnalyze}><Sparkles />{busy ? '解析待ち・解析中' : 'この動画をAI解析'}</button>}
    {video.keyPoints && <section><h4>重要ポイント<CopyButton text={video.keyPoints.map(p => `・${p}`).join('\n')} title="重要ポイントをコピー" /></h4><ul>{video.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul></section>}
    <dl><dt>カテゴリ</dt><dd>{categories.find(c => c.id === video.category)?.name || '未分類'}</dd><dt>サブカテゴリ</dt><dd>{categories.find(c => c.id === video.subCategory)?.name || '未分類'}</dd><dt>タグ</dt><dd>{video.tags?.join('・') || '未登録'}</dd><dt>おすすめ対象</dt><dd>{video.recommendedFor || '未解析'}</dd><dt>具体 ⇔ 抽象</dt><dd>{video.concreteAbstractScore === undefined ? '未解析' : `${video.concreteAbstractScore}/100（0：具体、100：抽象）`}</dd><dt>技術 ⇔ 社会</dt><dd>{video.technicalSocialScore === undefined ? '未解析' : `${video.technicalSocialScore}/100（0：技術、100：社会）`}</dd></dl>
    {video.aiComment && <p>{video.aiComment}</p>}<details><summary>概要欄</summary><p className="video-summary">{video.description || '概要欄はありません'}</p></details>
  </div>{onBookmarks && <VideoBookmarks video={video} playerRef={player} onChange={onBookmarks} />}</div>}</section></div>
}
