import type { YouTubeVideo } from './types'
/** Older analyses began with a fixed disclaimer; drop it so the summary starts with content. */
export const cleanSummary = (s = '') => s.replace(/^\s*(?:本要約は|この要約は)?[「『]?タイトル(?:と|・|及び|および)(?:チャンネル名・)?概要欄(?:・チャンネル名)?(?:に基づく|をもとにした|に基づいた|からの)整理[」』]?(?:です)?[。．:：]?\s*/, '')
export const videoCopyText = (v: YouTubeVideo) => [
  v.title, v.videoUrl, cleanSummary(v.summary),
  v.keyPoints?.length ? `重要ポイント\n${v.keyPoints.map(p => `・${p}`).join('\n')}` : '',
].filter(Boolean).join('\n\n')
/** ISO 8601 duration from the YouTube API (e.g. PT1H2M3S) → 「1時間2分」「28分32秒」. */
export function formatDuration(iso = '') {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!m) return ''
  const [d, h, min, s] = m.slice(1).map(x => Number(x || 0)), hours = d * 24 + h
  if (!hours && !min && !s) return '' // live streams report P0D
  return hours ? `${hours}時間${min}分` : min ? `${min}分${s}秒` : `${s}秒`
}
