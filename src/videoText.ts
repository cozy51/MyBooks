import type { YouTubeVideo } from './types'
/** Older analyses began with a fixed disclaimer; drop it so the summary starts with content. */
export const cleanSummary = (s = '') => s.replace(/^\s*(?:本要約は|この要約は)?[「『]?タイトル(?:と|・|及び|および)(?:チャンネル名・)?概要欄(?:・チャンネル名)?(?:に基づく|をもとにした|に基づいた|からの)整理[」』]?(?:です)?[。．:：]?\s*/, '')
export const videoCopyText = (v: YouTubeVideo) => [
  v.title, v.videoUrl, cleanSummary(v.summary),
  v.keyPoints?.length ? `重要ポイント\n${v.keyPoints.map(p => `・${p}`).join('\n')}` : '',
  v.bookmarks?.length ? `ブックマーク\n${bookmarkLines(v)}` : '',
].filter(Boolean).join('\n\n')
export const bookmarkLines = (v: YouTubeVideo) => [...(v.bookmarks ?? [])].sort((a, b) => a.time - b.time).map(b => `・${formatTime(b.time)} ${b.note}`.trimEnd()).join('\n')
/** ISO 8601 duration from the YouTube API (e.g. PT1H2M3S) → 「1時間2分」「28分32秒」. */
export function formatDuration(iso = '') {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!m) return ''
  const [d, h, min, s] = m.slice(1).map(x => Number(x || 0)), hours = d * 24 + h
  if (!hours && !min && !s) return '' // live streams report P0D
  return hours ? `${hours}時間${min}分` : min ? `${min}分${s}秒` : `${s}秒`
}
/** 83 → "1:23", 3723 → "1:02:03" */
export function formatTime(seconds: number) {
  const t = Math.max(0, Math.floor(seconds)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
/** "1:23" / "1:02:03" / "83" → seconds; null when unreadable. */
export function parseTime(text: string): number | null {
  const parts = text.trim().replace(/：/g, ':').split(':')
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null
  return parts.reduce((total, p) => total * 60 + Number(p), 0)
}
