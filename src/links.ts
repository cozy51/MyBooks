import type { BookLink } from './types'

/** 関連リンクの名前の候補。新しい本・編集画面には、この順で最初から欄を用意する */
export const LINK_PRESETS = ['インフォグラフィック', '音声解説', '動画解説', '全ページスキャン', 'GeminiNotebookスライド']
/** カードに表示するリンクの最大数 */
export const CARD_LINK_LIMIT = 6

export const newLink = (label = ''): BookLink => ({ id: crypto.randomUUID(), label, url: '' })

/** 編集用：まだ無い候補の欄を末尾に追加する */
export function withPresetRows(links: BookLink[]): BookLink[] {
  const labels = new Set(links.map(l => l.label.trim()))
  return [...links.map(l => ({ ...l })), ...LINK_PRESETS.filter(p => !labels.has(p)).map(newLink)]
}

/** 保存用：URLが空の欄を取り除く */
export function cleanLinks(links: BookLink[]): BookLink[] {
  return links.map(l => ({ id: l.id, label: l.label.trim(), url: l.url.trim() })).filter(l => l.url)
}

