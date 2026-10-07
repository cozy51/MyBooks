import { categoryName } from './semanticSearch'
import type { LibraryItem, YouTubeVideo } from './types'
export type InterestScope = 'book' | 'youtube' | 'all'
export function interestSnapshot(items: LibraryItem[], videos: YouTubeVideo[], scope: InterestScope) {
  const selected = items.filter(i => scope === 'all' || i.type === scope)
  const groups = new Map<string, number>()
  for (const item of selected) { const category = categoryName(item.categoryId) || '未分類'; groups.set(category, (groups.get(category) || 0) + 1) }
  const categories = [...groups].map(([category, count]) => ({ category, count, percentage: selected.length ? Math.round(count / selected.length * 1000) / 10 : 0 })).sort((a, b) => b.count - a.count)
  const forType = (type: 'book' | 'youtube') => {
    const list = items.filter(i => i.type === type)
    const counts = new Map<string, number>()
    for (const i of list) { const c = categoryName(i.categoryId) || '未分類'; counts.set(c, (counts.get(c) || 0) + 1) }
    // Deterministic, evenly-spaced sample; do not send the whole library to AI.
    const sample = Array.from({ length: Math.min(30, list.length) }, (_, n) => list[Math.floor(n * list.length / Math.min(30, list.length))]).map(i => ({ title: i.title, category: categoryName(i.categoryId), summary: i.memo.slice(0, 500), tags: i.tags || [] }))
    return { total: list.length, classified: list.filter(i => i.categoryId).length, categories: [...counts].map(([category, count]) => ({ category, count })), sample }
  }
  const scored = videos.filter(v => v.analyzedAt && Number.isFinite(v.concreteAbstractScore) && Number.isFinite(v.technicalSocialScore))
  const videoAxes = { count: scored.length, concreteAbstract: scored.length ? Math.round(scored.reduce((s, v) => s + v.concreteAbstractScore!, 0) / scored.length) : null, technicalSocial: scored.length ? Math.round(scored.reduce((s, v) => s + v.technicalSocialScore!, 0) / scored.length) : null }
  return { scope, total: selected.length, categories, books: forType('book'), youtube: forType('youtube'), videoAxes }
}
