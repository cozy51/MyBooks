// 全ページスキャンのリンク先が、別の本のファイルになっていないかを確かめる。
// スキャンのPDFはファイル名に書名が入っている（例: 2026-06 株式投資が富への道を導く.pdf）ので、Driveのファイル名と本のタイトルを比べる
import { driveFileId } from './cover'
import { currentToken, storedReadToken, storedToken } from './drive'

const names = new Map<string, Promise<string | null>>()

/** 全ページスキャンのDriveのファイル名（Driveのリンクでない・読めないときは null） */
export function scanFileName(scanUrl: string): Promise<string | null> {
  const id = driveFileId(scanUrl)
  if (!id) return Promise.resolve(null)
  let name = names.get(id)
  if (!name) {
    name = (async () => {
      const token = storedReadToken() ?? storedToken() ?? await currentToken()
      if (!token) return null
      try {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
        return res.ok ? (await res.json() as { name?: string }).name ?? null : null
      } catch { return null }
    })()
    // 読めなかったときは、あとで（ログイン後などに）もう一度確かめられるよう覚えない
    void name.then(n => { if (n === null) names.delete(id) })
    names.set(id, name)
  }
  return name
}

/** 比べるために、表記ゆれ・拡張子・先頭の年月・空白や記号を取り除く */
const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
  .replace(/\.(pdf|epub|zip|jpe?g|png)$/, '')
  .replace(/^\d{4}[-_./年]?\d{1,2}月?[\s_-]*/, '')
  .replace(/[\s\p{P}\p{S}]/gu, '')

/** 書名が入っていない、機械的なファイル名（scan_0012.pdf など） */
const GENERIC = /^(scan|scanned|img|image|document|doc|file|untitled|無題|スキャン)?\d*$/

const bigrams = (text: string) => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)))

/**
 * ファイル名が本のタイトルと合っているか。
 * true: 合っている / false: 別の本のファイルらしい / null: 判定できない（ファイル名に書名が入っていないなど）
 */
export function titleMatches(fileName: string | null, title: string): boolean | null {
  if (!fileName) return null
  const file = normalize(fileName), book = normalize(title)
  if (!file || !book || GENERIC.test(file)) return null
  if (file.includes(book) || book.includes(file)) return true
  // 2文字ずつの組がどれだけ共通しているかで比べる（サブタイトルの有無や一部の表記違いは許す）
  const a = bigrams(book), b = bigrams(file)
  if (!a.size || !b.size) return null
  const shared = [...a].filter(x => b.has(x)).length
  return shared / Math.min(a.size, b.size) >= 0.5
}
