// 著者名の扱い（同じ著者の本・著者プロフィールで使う）

/** 著者名を比較用にそろえる（全角半角・空白の違いと「著」「編」などの役割表記を無視し、複数の著者は分ける） */
export function authorKeys(author: string): string[] {
  return author.normalize('NFKC').split(/[、,;／/&＋+]|\s+and\s+/i)
    .map(name => name.replace(/[(（[［].*?[)）\]］]/g, '').replace(/\s*(編著|共著|監修|監訳|編集|原著|著|編|訳|作|文|絵)\s*$/, '').replace(/\s+/g, '').toLowerCase())
    .filter(Boolean)
}

/** 著者欄を著者ごとに分ける（「山田 学、一色 桂」→ 2人。「著」「編」などの役割表記は外す） */
export function authorNames(author: string): string[] {
  return [...new Set(author.split(/[、,，;／/&＋+]|\s+and\s+/i)
    .map(name => name.replace(/[(（[［].*?[)）\]］]/g, '').replace(/\s*(編著|共著|監修|監訳|編集|原著|著|編|訳|作|文|絵)\s*$/, '').replace(/[\s\u3000]+/g, ' ').trim())
    .filter(Boolean))]
}

// ---- 年齢 ----

const ERAS: [RegExp, number][] = [[/(?:令和|(?<![A-Za-z])R)/i, 2018], [/(?:平成|(?<![A-Za-z])H)/i, 1988], [/(?:昭和|(?<![A-Za-z])S)/i, 1925], [/(?:大正|(?<![A-Za-z])T)/i, 1911], [/(?:明治|(?<![A-Za-z])M)/i, 1867]]

/** 「1947年7月14日」「1947-07-14」「昭和22年7月」「S38年生まれ」などから年・月・日を読む（読めない部分は undefined） */
export function parseDate(text: string): { y: number; m?: number; d?: number } | null {
  const t = text.normalize('NFKC').replace(/\s+/g, '').replace(/元年/, '1年')
  for (const [era, base] of ERAS) {
    const m = t.match(new RegExp(`${era.source}(\\d{1,2})年(?:(\\d{1,2})月)?(?:(\\d{1,2})日)?`, 'i'))
    if (m) return { y: base + Number(m[1]), m: m[2] ? Number(m[2]) : undefined, d: m[3] ? Number(m[3]) : undefined }
  }
  const m = t.match(/(\d{4})(?:[年/.-](\d{1,2})(?:[月/.-](\d{1,2}))?)?/)
  if (!m) return null
  const y = Number(m[1]), mo = m[2] ? Number(m[2]) : undefined, d = m[3] ? Number(m[3]) : undefined
  if (y < 1000 || (mo !== undefined && (mo < 1 || mo > 12)) || (d !== undefined && (d < 1 || d > 31))) return null
  return { y, m: mo, d }
}

/**
 * 年齢。誕生日が分かれば「79歳」、年だけ・年月だけなら幅を持たせて「78〜79歳」。
 * 亡くなっている場合（death）は、その日までの年齢（享年）を返す
 */
export function ageText(birth: string, death?: string, today = new Date()): { text: string; deceased: boolean } | null {
  const b = parseDate(birth)
  const end = death ? parseDate(death) : null
  if (!b || (death && !end)) return null
  const e = end ?? { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() }
  const base = e.y - b.y
  let low = base - 1, high = base
  if (b.m !== undefined && e.m !== undefined) {
    if (e.m > b.m) low = base
    else if (e.m < b.m) high = base - 1
    else if (b.d !== undefined && e.d !== undefined) { if (e.d >= b.d) low = base; else high = base - 1 }
  }
  if (high < 0) return null
  return { text: low === high ? `${high}歳` : `${Math.max(0, low)}〜${high}歳`, deceased: Boolean(end) }
}
