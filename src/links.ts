import type { BookLink } from './types'

/** 全ページスキャン。要約の作成にも使う */
export const SCAN_LABEL = '全ページスキャン'
/** 要約を読み上げた音声（WAVなど）。カードでは、リンクではなく小さな再生ボタンで表示する */
export const SUMMARY_AUDIO_LABEL = '要約音声'
/** 固定のリンク欄。表示名は変えられず、この順で先頭に並ぶ（新しい本・編集画面には最初から欄を用意する） */
export const LINK_PRESETS = [SCAN_LABEL, 'インフォグラフィック', 'GeminiNotebookスライド', '音声解説', '動画解説', 'GeminiNotebookスライド動画', SUMMARY_AUDIO_LABEL]
/** カードに表示するときの短い名前 */
export const SHORT_LABELS: Record<string, string> = { [SCAN_LABEL]: 'Scan', 'インフォグラフィック': 'InfoG', 'GeminiNotebookスライド': 'Slide', '音声解説': 'Voice', '動画解説': 'Movie', 'GeminiNotebookスライド動画': 'SlideM', [SUMMARY_AUDIO_LABEL]: 'SumV' }
/** カードのリンクの色分け用クラス名（Scan は既存の scan クラス） */
export const CHIP_KINDS: Record<string, string> = { [SCAN_LABEL]: 'scan', 'インフォグラフィック': 'infog', 'GeminiNotebookスライド': 'slide', '音声解説': 'voice', '動画解説': 'movie', 'GeminiNotebookスライド動画': 'slidem', [SUMMARY_AUDIO_LABEL]: 'sumvoice' }
/** カードに表示するリンクの最大数 */
export const CARD_LINK_LIMIT = 6

export const newLink = (label = ''): BookLink => ({ id: crypto.randomUUID(), label, url: '' })

/** 固定の欄と大文字・小文字だけが違う表示名（例: GeminiNoteBookスライド動画）は、固定の欄の名前にそろえる */
export function canonicalLabel(label: string): string {
  const text = label.trim()
  return LINK_PRESETS.find(p => p.toLowerCase() === text.toLowerCase()) ?? text
}
/** カードに表示するときの短い名前 */
export const shortLabel = (label: string) => SHORT_LABELS[canonicalLabel(label)] ?? (label.trim() || 'リンク')

/** カードのリンクの色分け用クラス名（固定の欄以外は undefined） */
export const chipKind = (label: string): string | undefined => CHIP_KINDS[canonicalLabel(label)]

export const isScan = (link: BookLink) => canonicalLabel(link.label) === SCAN_LABEL
export const isSummaryAudio = (link: BookLink) => canonicalLabel(link.label) === SUMMARY_AUDIO_LABEL
/** 要約音声のURL（無ければ空文字） */
export const summaryAudioUrl = (links: BookLink[]) => links.find(l => isSummaryAudio(l) && l.url.trim())?.url.trim() ?? ''
const presetIndex = (link: BookLink) => LINK_PRESETS.indexOf(canonicalLabel(link.label))
/** 固定のリンク欄か（表示名の変更・並べ替え・削除はできない） */
export const isPreset = (link: BookLink) => presetIndex(link) >= 0
/** 固定のリンクを決まった順で先頭に（ほかのリンクの順番はそのまま） */
export const presetsFirst = (links: BookLink[]) => [
  ...links.filter(isPreset).sort((a, b) => presetIndex(a) - presetIndex(b)),
  ...links.filter(l => !isPreset(l)),
]

/** 編集用：まだ無い固定の欄を追加する（固定の欄は決まった順で先頭） */
export function withPresetRows(links: BookLink[]): BookLink[] {
  const labels = new Set(links.map(l => canonicalLabel(l.label)))
  return presetsFirst([...links.map(l => ({ ...l, label: canonicalLabel(l.label) })), ...LINK_PRESETS.filter(p => !labels.has(p)).map(newLink)])
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
  return presetsFirst(links.map(l => ({ id: l.id, label: canonicalLabel(l.label), url: l.url.trim() })).filter(l => isUrl(l.url)))
}


/** クリップボードのテキストからURLを取り出す（読めないときは貼り付け用の入力欄を出す）。URLが無ければ空文字 */
export async function readClipboardUrl(): Promise<string> {
  let text: string | null = null
  try { if (navigator.clipboard?.readText) text = await navigator.clipboard.readText() } catch { /* 権限拒否など */ }
  text ??= window.prompt('クリップボードを読み取れませんでした。URLを貼り付けてください') ?? ''
  return text.match(URL_PATTERN)?.[0] ?? ''
}
