import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, Cloud, LoaderCircle, Quote, RotateCcw, Sparkles, Target, Trophy, UserRound, X } from 'lucide-react'
import { CoverImage } from './CoverImage'
import { categories } from './data'
import { MAX_QUERY, PickError, pickBooks, type AiPick, type PickStage } from './aiPicks'
import type { SyncStatus } from './useDriveSync'
import type { Book } from './types'

const EXAMPLES = ['原因と結果を正しく見極めたい', '仕事の段取りが悪く、いつも時間が足りない', '設計の品質を上げる考え方を知りたい', '英語を話せるようになりたい']
const QUERY_KEY = 'mybooks-ai-pick-query'

type State =
  | { status: 'input' }
  | { status: 'loading'; stage: PickStage }
  | { status: 'done'; query: string; picks: AiPick[] }
  | { status: 'error'; message: string; code: string }

/** AI選書のモーダル。入力文から、登録済みの本の中で内容が合う本を選び、選定理由とともに表示する */
export function AiPicksModal({ books, driveStatus, onConnect, onOpen, onClose }: { books: Book[]; driveStatus: SyncStatus; onConnect: () => void; onOpen: (b: Book) => void; onClose: () => void }) {
  const [query, setQuery] = useState(() => { try { return sessionStorage.getItem(QUERY_KEY) ?? '' } catch { return '' } })
  const [state, setState] = useState<State>({ status: 'input' })
  const abort = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { try { sessionStorage.setItem(QUERY_KEY, query) } catch { /* noop */ } }, [query])
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => {
    // 本の詳細画面を上に開いているあいだは、Escape をそちらに任せる
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop:not(.ai-picks-backdrop)')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async () => {
    const text = query.trim()
    if (!text) { inputRef.current?.focus(); return }
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setState({ status: 'loading', stage: { stage: 'index', progress: null } })
    try {
      const picks = await pickBooks(text, books, stage => { if (!controller.signal.aborted) setState({ status: 'loading', stage }) }, controller.signal)
      if (!controller.signal.aborted) setState({ status: 'done', query: text, picks })
    } catch (e) {
      if (controller.signal.aborted) return
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e), code: e instanceof PickError ? e.code : '' })
    }
  }
  const back = () => { abort.current?.abort(); setState({ status: 'input' }); setTimeout(() => inputRef.current?.focus()) }
  const needsLogin = state.status === 'error' && state.code === 'unauthorized' && driveStatus !== 'unavailable'

  return <div className="modal-backdrop ai-picks-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <section className="modal ai-picks" role="dialog" aria-modal="true" aria-labelledby="ai-picks-title">
      <div className="modal-head ai-picks-head"><div><p className="eyebrow">AI BOOK PICKS</p><h2 id="ai-picks-title"><Sparkles /> AI選書</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる"><X /></button></div>

      {state.status === 'done' ? <PickResults query={state.query} picks={state.picks} onOpen={onOpen} onBack={back} /> : <div className="ai-picks-body">
        <form className="ai-picks-form" onSubmit={e => { e.preventDefault(); void run() }}>
          <label htmlFor="ai-picks-query">今、何について知りたいですか？</label>
          <p className="ai-picks-hint">知りたいこと・考えたいこと・困っていること・興味を、文章で自由に書いてください。登録されている{books.length}冊の中から、内容が合う本を選びます。</p>
          <textarea id="ai-picks-query" ref={inputRef} autoFocus value={query} maxLength={MAX_QUERY} rows={5} disabled={state.status === 'loading'}
            onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run() } }}
            placeholder="例：データから原因と結果を正しく見極めたい。相関があるだけなのに、因果関係だと思い込んでしまうことが多い。" />
          <div className="ai-picks-examples"><span>例：</span>{EXAMPLES.map(text => <button key={text} type="button" disabled={state.status === 'loading'} onClick={() => { setQuery(text); inputRef.current?.focus() }}>{text}</button>)}</div>
          <div className="ai-picks-submit">
            <small>{query.length}/{MAX_QUERY}字・Ctrl+Enter でも選べます</small>
            <button className="primary-btn ai-picks-run" disabled={state.status === 'loading' || !query.trim()}>{state.status === 'loading' ? <LoaderCircle className="spin" /> : <Sparkles />} {state.status === 'loading' ? '選んでいます…' : 'おすすめの本を選ぶ'}</button>
          </div>
        </form>
        {state.status === 'loading' && <p className="ai-picks-progress" role="status"><LoaderCircle className="spin" /> {stageText(state.stage)}</p>}
        {state.status === 'error' && <div className="ai-picks-error" role="alert"><p>{state.message}</p>{needsLogin && <button type="button" className="secondary-btn" onClick={onConnect}><Cloud /> Googleでログイン</button>}</div>}
        <p className="ai-picks-note">選定理由は、MyBooksに保存されているタイトル・著者・分類・要約だけを根拠にAIが作成します。要約が登録されている本ほど、正確に選べます。</p>
      </div>}
    </section>
  </div>
}

function stageText(s: PickStage): string {
  if (s.stage === 'index') return s.progress ? `本の内容を意味検索用に準備しています（${s.progress.done}/${s.progress.total}冊）…` : '意味検索のデータを確認しています…'
  if (s.stage === 'search') return '入力内容と意味の近い本を探しています…'
  return `意味の近い${s.candidates}冊の要約を読み比べて、おすすめを選んでいます…`
}

function PickResults({ query, picks, onOpen, onBack }: { query: string; picks: AiPick[]; onOpen: (b: Book) => void; onBack: () => void }) {
  return <div className="ai-picks-body">
    <div className="ai-picks-result-head">
      <div><h3><Trophy /> あなたへのおすすめ</h3><p className="ai-picks-query">「{query}」</p></div>
      <button type="button" className="ghost-btn" onClick={onBack}><RotateCcw /> 条件を変えて選び直す</button>
    </div>
    {picks.length === 0 ? <div className="ai-picks-empty"><BookOpen /><p>入力内容に合う本が、登録されている本の中に見つかりませんでした。別の言葉で書き直すか、本の要約を登録してからお試しください。</p></div>
      : <ol className="ai-picks-list">{picks.map((pick, i) => <PickCard key={pick.book.id} rank={i + 1} pick={pick} onOpen={onOpen} />)}</ol>}
    <p className="ai-picks-note">選定理由は、MyBooksに保存されているタイトル・著者・分類・要約だけを根拠にAIが作成しています。表紙やタイトルを押すと、本の詳細を開きます。</p>
  </div>
}

function PickCard({ rank, pick, onOpen }: { rank: number; pick: AiPick; onOpen: (b: Book) => void }) {
  const { book } = pick
  const child = categories.find(c => c.id === book.categoryId)
  const summary = book.memo.trim()
  return <li className="pick-card">
    <button type="button" className="pick-cover" onClick={() => onOpen(book)} aria-label={`${book.title}の詳細を開く`}>
      <span className="pick-rank">{rank}</span>
      <CoverImage src={book.cover} alt={`${book.title}の表紙`} width={320} fallback={<span className="cover-placeholder"><BookOpen /><span>NO COVER</span></span>} />
    </button>
    <div className="pick-body">
      <div className="pick-title">
        {child && <span className="pick-category">{child.name}</span>}
        <h4><button type="button" onClick={() => onOpen(book)}>{book.title}</button></h4>
        <p className={`author${book.author.trim() ? '' : ' missing'}`}>{book.author.trim() ? <><UserRound /><span>{book.author.trim()}</span></> : '著者未登録'}</p>
      </div>
      <Relevance value={pick.relevance} />
      <section className="pick-section"><h5>選定理由</h5><p>{pick.reason}</p></section>
      {pick.themes.length > 0 && <section className="pick-section"><h5>あなたの関心と、この本のテーマ</h5><ul className="pick-themes">{pick.themes.map((t, i) => <li key={i}><span className="interest">{t.interest}</span><span className="arrow" aria-label="に関連する">→</span><span className="theme">{t.theme}</span></li>)}</ul></section>}
      {pick.benefits.length > 0 && <section className="pick-section"><h5>読むと得られそうなこと</h5><ul className="pick-benefits">{pick.benefits.map((b, i) => <li key={i}><Target />{b}</li>)}</ul></section>}
      <details className="pick-why">
        <summary><Sparkles /> なぜこの本？<ChevronDown className="chevron" /></summary>
        <div className="pick-why-body">
          <p>あなたが入力した「{pick.themes[0]?.interest || 'ご関心'}」に対して、この本の次のデータを根拠に選びました。</p>
          {pick.evidence.length > 0 ? <><h6>要約の中の根拠</h6><ul className="pick-evidence">{pick.evidence.map((e, i) => <li key={i}><Quote />{e}</li>)}</ul></>
            : <p className="pick-warn">{summary ? 'AIの答えから、要約の原文と一致する根拠を確認できませんでした。選定理由は参考としてご覧ください。' : 'この本は要約が登録されていないため、タイトルと分類だけを根拠にしています。要約を登録すると、より正確に選べます。'}</p>}
          <dl className="pick-data">
            <div><dt>分類</dt><dd>{categoryLabel(book.categoryId) || '未登録'}</dd></div>
            {pick.similarity !== undefined && <div><dt>意味の近さ</dt><dd>{Math.round(Math.max(0, pick.similarity) * 100)}%（入力内容と、タイトル・著者・分類・要約のEmbeddingの類似度）</dd></div>}
            <div><dt>登録されている要約</dt><dd className="pick-summary">{summary || '（未登録）'}</dd></div>
          </dl>
        </div>
      </details>
    </div>
  </li>
}

function categoryLabel(id: string) {
  const child = categories.find(c => c.id === id)
  const parent = categories.find(c => c.id === child?.parent)
  return [parent?.name, child?.name].filter(Boolean).join(' ＞ ')
}

function Relevance({ value }: { value: number }) {
  const label = value >= 80 ? 'とても高い' : value >= 60 ? '高い' : value >= 40 ? 'ふつう' : '低め'
  return <div className="pick-relevance" aria-label={`関連度 ${value}%（${label}）`}>
    <span className="pick-relevance-label">関連度</span>
    <span className="pick-relevance-track"><span style={{ width: `${Math.max(4, value)}%` }} /></span>
    <strong>{value}%</strong><small>{label}</small>
  </div>
}
