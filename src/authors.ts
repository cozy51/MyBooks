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
