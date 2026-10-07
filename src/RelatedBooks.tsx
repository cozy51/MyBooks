import { useEffect, useState } from 'react'
import { BookOpen, ChevronRight, LoaderCircle, Sparkles, UserRound } from 'lucide-react'
import { CoverImage } from './CoverImage'
import { categories, statusClass } from './data'
import { embedText, findSimilarBooks, updateBookMap, type SimilarBook } from './bookMapData'
import { authorKeys } from './authors'
import { CopyButton } from './CopyButton'
import type { Book } from './types'

/** 同じ著者（共著者のいずれかが同じ）の本。タイトル順 */
function sameAuthorBooks(book: Book, books: Book[]): Book[] {
  const keys = new Set(authorKeys(book.author))
  if (!keys.size) return []
  return books.filter(b => b.id !== book.id && authorKeys(b.author).some(k => keys.has(k)))
    .sort((a, b) => a.title.localeCompare(b.title, 'ja'))
}

/** 類似度の横棒。上位の本は数%しか差がないため、一覧の中の最小〜最大を棒の長さ20〜100%に広げて違いを見やすくする */
function ScoreBar({ score, ratio }: { score: number; ratio: number }) {
  const percent = Math.round(Math.max(0, score) * 100)
  return <span className="related-score" title={`タイトルと要約の内容の近さ：${percent}%`} aria-label={`類似度 ${percent}%`}>
    <span className="related-score-track"><span className="related-score-fill" style={{ width: `${20 + 80 * ratio}%` }} /></span>
    <span className="related-score-num">{percent}%</span>
  </span>
}

/** copy: タイトルの横にコピーボタンを出す（タイトルと要約をコピーする。読み上げアプリ用） */
export function RelatedRow({ book, score, ratio, current, copy, onOpen }: { book: Book; score?: number; ratio?: number; current?: boolean; copy?: boolean; onOpen: (b: Book) => void }) {
  const child = categories.find(c => c.id === book.categoryId)
  // コピーボタンを中に置けるよう、行全体はボタン要素ではなく role="button" にする
  return <li className={current ? 'related-current' : undefined}><div role="button" tabIndex={0} className="related-row" onClick={() => onOpen(book)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(book) } }}>
    <span className="related-cover"><CoverImage src={book.cover} alt="" width={160} fallback={<BookOpen />} /></span>
    <span className="related-body">
      <span className="related-title"><strong>{book.title}</strong>{copy && <CopyButton text={[book.title.trim(), book.memo.trim()].filter(Boolean).join('\n')} title={`「${book.title}」のタイトルと要約をコピー`} />}</span>
      <small>{book.author || '著者未登録'}{child && ` ・ ${child.name}`}</small>
      {book.memo.trim() && <span className="related-memo">{book.memo.trim().slice(0, 80)}{book.memo.trim().length > 80 && '…'}</span>}
    </span>
    <span className="related-side">
      {current && <span className="related-current-label">表示中</span>}
      {score !== undefined && <ScoreBar score={score} ratio={ratio ?? 1} />}
      <span className={`status mini ${statusClass[book.status]}`}>{book.status}</span>
      <ChevronRight />
    </span>
  </div></li>
}

/** 分類マップと同じEmbeddingを使って、内容が近い本を10冊表示する */
export function SimilarBooks({ book, books, onOpen, indexItems = books }: { indexItems?: Book[]; book: Book; books: Book[]; onOpen: (b: Book) => void }) {
  const [result, setResult] = useState<{ id: string; items: SimilarBook[] | null } | null>(null)
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void findSimilarBooks(book, books).then(items => { if (active) setResult({ id: book.id, items }) })
    return () => { active = false }
  }, [book, books])

  // この本のEmbeddingが無いときは、マップのデータを更新してから探し直す
  const compute = async () => {
    setComputing(true); setError('')
    try {
      const { error } = await updateBookMap(indexItems, () => {})
      if (error) setError(error.message)
      setResult({ id: book.id, items: await findSimilarBooks(book, books) })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setComputing(false) }
  }

  if (!embedText(book)) return <p className="related-empty">タイトルを入力して保存すると、内容が近い本を探せます。</p>
  if (!result || result.id !== book.id) return <p className="related-empty"><LoaderCircle className="spin" /> 内容が近い本を探しています…</p>
  if (!result.items) return <div className="related-empty">
    <p>この本はまだ分類マップで計算されていません（要約などを変更した直後も再計算が必要です）。</p>
    <button type="button" className="secondary-btn" disabled={computing} onClick={() => void compute()}>{computing ? <LoaderCircle className="spin" /> : <Sparkles />} {computing ? '計算しています…' : '内容の近さを計算する'}</button>
    {error && <p className="field-error">{error}</p>}
  </div>
  if (!result.items.length) return <p className="related-empty">比べられる本がまだありません。分類マップを開くと、ほかの本も計算されます。</p>
  const scores = result.items.map(item => item.score)
  const max = Math.max(...scores), min = Math.min(...scores)
  const ratio = (score: number) => max > min ? (score - min) / (max - min) : 1
  return <>
    <p className="related-lead"><Sparkles /> 分類マップと同じく、タイトルと要約の内容が近い順に{result.items.length}冊を表示しています。</p>
    <ul className="related-list">{result.items.map(item => <RelatedRow key={item.book.id} book={item.book} score={item.score} ratio={ratio(item.score)} onOpen={onOpen} />)}</ul>
  </>
}

export function SameAuthorBooks({ book, books, onOpen }: { book: Book; books: Book[]; onOpen: (b: Book) => void }) {
  if (!authorKeys(book.author).length) return <p className="related-empty">著者が登録されていません。「詳細・編集」で著者を入力すると、同じ著者の本を表示できます。</p>
  const list = sameAuthorBooks(book, books)
  if (!list.length) return <p className="related-empty">{book.author} の本は、ほかに登録されていません。</p>
  return <>
    <p className="related-lead"><UserRound /> {book.author} の本が、ほかに{list.length}冊あります。</p>
    <ul className="related-list">{list.map(b => <RelatedRow key={b.id} book={b} onOpen={onOpen} />)}</ul>
  </>
}
