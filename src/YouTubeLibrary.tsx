import { useEffect } from 'react'
import { ExternalLink, Play, Sparkles, X } from 'lucide-react'
import { categories } from './data'
import type { YouTubeVideo } from './types'
export function VideoCard({ video, onOpen, selected, onSelect, onAnalyze, busy }: { video: YouTubeVideo; onOpen: () => void; selected: boolean; onSelect: () => void; onAnalyze?: () => void; busy?: boolean }) {
  const category = categories.find(c => c.id === (video.subCategory || video.category))
  return <article className="book-card video-card" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen() }}>
    <div className="video-thumbnail">{video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" onError={e => { e.currentTarget.hidden = true }} /> : <Play />}<span className="video-type"><Play size={14} /> YouTube</span></div>
    <div className="card-body"><div className="category-line"><b>{category?.name || '未分類'}</b></div><h3>{video.title}</h3><p className="author">{video.channelTitle}</p><p className="video-excerpt">{video.summary || 'AI未解析'}</p><div className="video-actions"><button type="button" className="secondary-btn" disabled={busy || !!video.analyzedAt || !onAnalyze} onClick={e => { e.stopPropagation(); onAnalyze?.() }}><Sparkles size={14} />{busy ? '解析待ち・解析中' : video.analyzedAt ? 'AI解析済み' : 'AI解析'}</button><a href={video.videoUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>YouTubeで見る <ExternalLink size={14} /></a></div><div className="video-foot"><small>{video.publishedAt?.slice(0, 7)}</small><label className="video-check" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label={`${video.title}を選択`} checked={selected} onChange={onSelect} />選択</label></div></div>
  </article>
}
export function VideoModal({ video, onClose, onAnalyze, busy }: { video: YouTubeVideo; onClose: () => void; onAnalyze?: () => void; busy?: boolean }) {
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [onClose])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className="modal video-modal" role="dialog" aria-modal="true" aria-label="動画の詳細"><div className="modal-head"><h2><Play /> 動画の詳細</h2><button className="icon-btn" aria-label="閉じる" onClick={onClose}><X /></button></div><div className="video-detail">
    {video.thumbnailUrl && <img className="video-detail-image" src={video.thumbnailUrl} alt="" />}<h3>{video.title}</h3><p>{video.channelTitle} · {video.publishedAt?.slice(0, 10)} {video.duration && `· ${video.duration}`}</p><a className="secondary-btn" href={video.videoUrl} target="_blank" rel="noopener noreferrer">YouTubeで見る <ExternalLink /></a>
    <section><h4>AI要約</h4><p className="video-summary">{video.summary || 'AI未解析'}</p><small>タイトル・概要欄・チャンネル名をもとにした整理です。動画本編・字幕は確認していません。</small></section>
    {!video.analyzedAt && <button className="primary-btn" disabled={busy || !onAnalyze} onClick={onAnalyze}><Sparkles />{busy ? '解析待ち・解析中' : 'この動画をAI解析'}</button>}
    {video.keyPoints && <section><h4>重要ポイント</h4><ul>{video.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul></section>}
    <dl><dt>カテゴリ</dt><dd>{categories.find(c => c.id === video.category)?.name || '未分類'}</dd><dt>サブカテゴリ</dt><dd>{categories.find(c => c.id === video.subCategory)?.name || '未分類'}</dd><dt>タグ</dt><dd>{video.tags?.join('・') || '未登録'}</dd><dt>おすすめ対象</dt><dd>{video.recommendedFor || '未解析'}</dd><dt>具体 ⇔ 抽象</dt><dd>{video.concreteAbstractScore === undefined ? '未解析' : `${video.concreteAbstractScore}/100（0：具体、100：抽象）`}</dd><dt>技術 ⇔ 社会</dt><dd>{video.technicalSocialScore === undefined ? '未解析' : `${video.technicalSocialScore}/100（0：技術、100：社会）`}</dd></dl>
    {video.aiComment && <p>{video.aiComment}</p>}<details><summary>概要欄</summary><p className="video-summary">{video.description || '概要欄はありません'}</p></details>
  </div></section></div>
}
