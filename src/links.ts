import type { BookLink } from './types'

/** 全ページスキャン。表示名は固定で、関連リンクの先頭に置く（要約の作成にも使う） */
export const SCAN_LABEL = '全ページスキャン'
/** 関連リンクの名前の候補。新しい本・編集画面には、この順で最初から欄を用意する */
export const LINK_PRESETS = [SCAN_LABEL, 'インフォグラフィック', '音声解説', '動画解説', 'GeminiNotebookスライド']
/** カードに表示するリンクの最大数 */
export const CARD_LINK_LIMIT = 6

export const newLink = (label = ''): BookLink => ({ id: crypto.randomUUID(), label, url: '' })

export const isScan = (link: BookLink) => link.label.trim() === SCAN_LABEL
/** 全ページスキャンを先頭に（ほかのリンクの順番はそのまま） */
export const scanFirst = (links: BookLink[]) => [...links.filter(isScan), ...links.filter(l => !isScan(l))]

/** 編集用：まだ無い候補の欄を末尾に追加する（全ページスキャンは先頭） */
export function withPresetRows(links: BookLink[]): BookLink[] {
  const labels = new Set(links.map(l => l.label.trim()))
  return scanFirst([...links.map(l => ({ ...l })), ...LINK_PRESETS.filter(p => !labels.has(p)).map(newLink)])
}

// URLに使える文字（半角英数字と記号）だけを対象にする。日本語や空白はURLの外とみなす
const URL_PATTERN = /https?:\/\/[\w\-.~:/?#[\]@!$&()*+,;=%]+/i
/** http(s):// で始まり、URLに使える文字だけでできているか */
export const isUrl = (text: string) => new RegExp(`^${URL_PATTERN.source}$`, 'i').test(text)

/** URL欄の入力を整える。URL以外の文字が混ざる入力は受け付けず null を返す。
 *  「htt」のような http(s):// の打ちかけは許し、文章ごと貼り付けたときはURL部分だけを取り出す */
export function sanitizeUrlInput(value: string): string | null {
  const v = value.trim()
  if (!v || isUrl(v) || 'https://'.startsWith(v.toLowerCase()) || 'http://'.startsWith(v.toLowerCase())) return v
  return v.match(URL_PATTERN)?.[0] ?? null
}

/** 保存用：URLが空・URLとして正しくない欄を取り除く */
export function cleanLinks(links: BookLink[]): BookLink[] {
  return scanFirst(links.map(l => ({ id: l.id, label: l.label.trim(), url: l.url.trim() })).filter(l => isUrl(l.url)))
}


/** クリップボードのテキストからURLを取り出す（読めないときは貼り付け用の入力欄を出す）。URLが無ければ空文字 */
export async function readClipboardUrl(): Promise<string> {
  let text: string | null = null
  try { if (navigator.clipboard?.readText) text = await navigator.clipboard.readText() } catch { /* 権限拒否など */ }
  text ??= window.prompt('クリップボードを読み取れませんでした。URLを貼り付けてください') ?? ''
  return text.match(URL_PATTERN)?.[0] ?? ''
}
