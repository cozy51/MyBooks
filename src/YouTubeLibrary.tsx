import { useEffect, useState } from 'react'
import { ExternalLink, Play, Sparkles, ThumbsUp, X } from 'lucide-react'
import { categories } from './data'
import type { YouTubeVideo } from './types'
import { CopyButton } from './CopyButton'
import { cleanSummary, formatDuration, videoCopyText } from './videoText'
/** Thumbnail that turns into an embedded player in place when clicked. */
function VideoPlayer({ video, className = '' }: { video: YouTubeVideo; className?: string }) {
  const [playing, setPlaying] = useState(false)
  return playing
    ? <div className={`video-thumbnail ${className}`} onClick={e => e.stopPropagation()}><iframe src={`https://www.youtube-nocookie.com/embed/${video.videoId}?autoplay=1&rel=0`} title={video.title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen /></div>
    : <button type="button" className={`video-thumbnail ${className}`} aria-label={`${video.title}を再生`} onClick={e => { e.stopPropagation(); setPlaying(true) }}>{video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" loading="lazy" onError={e => { e.currentTarget.hidden = true }} />}<span className="video-play"><Play /></span></button>
}
export function VideoCard({ video, onOpen, selected, onSelect, onAnalyze, onUnlike, busy }: { video: YouTubeVideo; onOpen: () => void; selected: boolean; onSelect: () => void; onAnalyze?: () => void; onUnlike?: () => void; busy?: boolean }) {
  const category = categories.find(c => c.id === (video.subCategory || video.category))
  return <article className="book-card video-card" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen() }}>
    <VideoPlayer video={video} />
    <div className="card-body"><div className="category-line"><b>{category?.name || '未分類'}</b></div>
      <div className="video-title"><input type="checkbox" className="video-check" aria-label={`${video.title}を選択`} checked={selected} onClick={e => e.stopPropagation()} onChange={onSelect} /><h3>{video.title}</h3></div>
      <p className="author">{video.channelTitle}</p>
      <div className="video-actions"><div><button type="button" className={`video-analyze${video.analyzedAt ? ' done' : ''}`} disabled={busy || !!video.analyzedAt || !onAnalyze} onClick={e => { e.stopPropagation(); onAnalyze?.() }}><Sparkles size={12} />{busy ? '解析中…' : video.analyzedAt ? 'AI解析済み' : 'AI解析'}</button>{video.summary && <CopyButton text={videoCopyText(video)} title="タイトル・URL・AI要約・重要ポイントをコピー" />}<a className="video-open" href={video.videoUrl} target="_blank" rel="noopener noreferrer" aria-label="YouTubeで見る" title="YouTubeで見る" onClick={e => e.stopPropagation()}><ExternalLink size={14} /></a>{onUnlike && <button type="button" className="video-unlike" aria-label="YouTubeのいいねを解除" title="YouTubeのいいねを解除" onClick={e => { e.stopPropagation(); onUnlike() }}><ThumbsUp /></button>}</div></div>
      <p className="video-excerpt">{cleanSummary(video.summary) || 'AI未解析'}</p><div className="video-foot"><small>{video.publishedAt?.slice(0, 7)}</small>{formatDuration(video.duration) && <small className="video-duration">{formatDuration(video.duration)}</small>}</div></div>
  </article>
}
export function VideoModal({ video, onClose, onAnalyze, onUnlike, busy }: { video: YouTubeVideo; onClose: () => void; onAnalyze?: () => void; onUnlike?: () => void; busy?: boolean }) {
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [onClose])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="modal video-modal" role="dialog" aria-modal="true" aria-label="動画の詳細"><div className="modal-head"><h2><Play /> 動画の詳細</h2><button className="icon-btn" aria-label="閉じる" onClick={onClose}><X /></button></div><div className="video-detail">
    <VideoPlayer video={video} className="video-detail-player" /><h3>{video.title}</h3><p>{video.channelTitle} · {video.publishedAt?.slice(0, 10)} {formatDuration(video.duration) && `· ${formatDuration(video.duration)}`}</p><a className="secondary-btn" href={video.videoUrl} target="_blank" rel="noopener noreferrer">YouTubeで見る <ExternalLink /></a>{video.summary && <CopyButton text={videoCopyText(video)} label="まとめてコピー" title="タイトル・URL・AI要約・重要ポイントをコピー" />}{onUnlike && <button type="button" className="video-unlike-btn" onClick={onUnlike}><ThumbsUp />いいねを解除</button>}
    <section><h4>AI要約{video.summary && <CopyButton text={cleanSummary(video.summary)} title="AI要約をコピー" />}</h4><p className="video-summary">{cleanSummary(video.summary) || 'AI未解析'}</p><small>タイトル・概要欄・チャンネル名をもとにした整理です。動画本編・字幕は確認していません。</small></section>
    {!video.analyzedAt && <button className="primary-btn" disabled={busy || !onAnalyze} onClick={onAnalyze}><Sparkles />{busy ? '解析待ち・解析中' : 'この動画をAI解析'}</button>}
    {video.keyPoints && <section><h4>重要ポイント<CopyButton text={video.keyPoints.map(p => `・${p}`).join('\n')} title="重要ポイントをコピー" /></h4><ul>{video.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul></section>}
    <dl><dt>カテゴリ</dt><dd>{categories.find(c => c.id === video.category)?.name || '未分類'}</dd><dt>サブカテゴリ</dt><dd>{categories.find(c => c.id === video.subCategory)?.name || '未分類'}</dd><dt>タグ</dt><dd>{video.tags?.join('・') || '未登録'}</dd><dt>おすすめ対象</dt><dd>{video.recommendedFor || '未解析'}</dd><dt>具体 ⇔ 抽象</dt><dd>{video.concreteAbstractScore === undefined ? '未解析' : `${video.concreteAbstractScore}/100（0：具体、100：抽象）`}</dd><dt>技術 ⇔ 社会</dt><dd>{video.technicalSocialScore === undefined ? '未解析' : `${video.technicalSocialScore}/100（0：技術、100：社会）`}</dd></dl>
    {video.aiComment && <p>{video.aiComment}</p>}<details><summary>概要欄</summary><p className="video-summary">{video.description || '概要欄はありません'}</p></details>
  </div></section></div>
}
