import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Check, ChevronLeft, ChevronRight, ClipboardPaste, Copy, Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload, Download, ExternalLink, FolderOpen, GripVertical, Grid2X2, List, LoaderCircle, Map as MapIcon, LogOut, RefreshCw, Plus, ScanText, Undo2, Search, Settings, Sparkles, Trash2, Upload, UserRound, X } from 'lucide-react'
import { COVER_FOLDER_ID, COVER_FOLDER_URL, driveFileId, driveFileUrl, normalizeCover } from './cover'
import { categories, sampleBooks, statusClass } from './data'
import { CoverImage, type Zoom } from './CoverImage'
import { DATA_FOLDER_URL, DRIVE_API_KEY, DRIVE_CLIENT_ID, DRIVE_FILE_NAME, pickImage, readClipboardImage, uploadCoverImage } from './drive'
import { useDriveSync, type SyncStatus } from './useDriveSync'
import { CardLinks, LinkEditor } from './LinkEditor'
import { SameAuthorBooks, SimilarBooks } from './RelatedBooks'
import { readCoverInfo, type CoverInfo } from './coverInfo'
import { cleanLinks, isScan, isUrl, newLink, withPresetRows } from './links'
import { readToken, summarizeScan } from './scanSummary'
import { rankBooks, wantsSemantic } from './semanticSearch'
import { useSemanticSearch } from './useSemanticSearch'
import type { Book, BookLink, ReadingStatus } from './types'

// 分類マップ（UMAPなど）は「マップ」を開いたときだけ読み込む
const BookMap = lazy(() => import('./BookMap'))

const STORE = 'mybooks-library-v1'
const PAGE_SIZE = 100
const LAST_CATEGORY = 'mybooks-last-category'
/** 前回保存した本の分類（新しい本の初期値に使う） */
function lastCategory() {
  try { const id = localStorage.getItem(LAST_CATEGORY); if (id && categories.some(c => c.id === id && c.parent)) return id } catch { /* noop */ }
  return 'd1'
}
const LAST_BASE_MONTH = 'mybooks-last-base-month'
/** 前回保存した本の基準月（新しい本の初期値に使う。まだ保存していなければ空欄） */
function lastBaseMonth() {
  try { const month = localStorage.getItem(LAST_BASE_MONTH); if (month === '' || (month && /^\d{4}-\d{2}$/.test(month))) return month } catch { /* noop */ }
  return ''
}
/** 基準月の入力をYYYY-MMにそろえる（2026-9・2026/09・202609・全角数字も可）。読めないときはnull、空欄は空欄 */
function normalizeMonth(value: string): string | null {
  const text = value.trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  if (!text) return ''
  const m = text.match(/^(\d{4})\s*[-/.年]?\s*(\d{1,2})\s*月?$/)
  const month = m ? Number(m[2]) : 0
  return m && month >= 1 && month <= 12 ? `${m[1]}-${String(month).padStart(2, '0')}` : null
}
// 同じ本かどうかの判定用に、全角半角・大文字小文字・空白の違いをそろえる
const bookKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
// リンクの比較用。DriveのファイルはファイルIDでそろえ、それ以外は末尾の / などの違いを無視する
const linkKey = (url: string) => { const text = url.trim(); return text && (driveFileId(text) ?? text.replace(/[/#?]+$/, '').toLowerCase()) }
/**
 * 同じ本がすでに登録されていれば、その本と理由を返す。
 * タイトルが同じで著者が同じか片方が未登録、または関連リンクに同じURLがあれば同じ本とみなす
 */
function findDuplicate(books: Book[], book: Pick<Book, 'id' | 'title' | 'author' | 'links'>): { book: Book; reason: 'title' | 'url' } | undefined {
  const title = bookKey(book.title), author = bookKey(book.author)
  if (title) {
    const same = books.find(b => b.id !== book.id && bookKey(b.title) === title && (!author || !bookKey(b.author) || bookKey(b.author) === author))
    if (same) return { book: same, reason: 'title' }
  }
  const urls = new Set(book.links.map(l => linkKey(l.url)).filter(Boolean))
  const same = urls.size ? books.find(b => b.id !== book.id && b.links.some(l => urls.has(linkKey(l.url)))) : undefined
  return same && { book: same, reason: 'url' }
}
/** 表紙から読み取った内容のうち、本に入れる項目（同じタイトルの本がすでにあれば、前置きやサブタイトルも含めた詳しいタイトルにする） */
function coverFields(books: Book[], book: Book, info: CoverInfo) {
  const category = categories.find(c => c.id === info.categoryId && c.parent)
  const sameTitle = (title: string) => findDuplicate(books, { ...book, title, author: info.author || book.author })?.reason === 'title'
  const detailed = Boolean(info.title && info.fullTitle && info.fullTitle !== info.title && sameTitle(info.title) && !sameTitle(info.fullTitle))
  const title = detailed ? info.fullTitle : info.title
  const read: Partial<Pick<Book, 'title' | 'author' | 'categoryId'>> = { ...(title && { title }), ...(info.author && { author: info.author }), ...(category && { categoryId: category.id }) }
  return { read, detailed }
}
/** 関連リンクの「全ページスキャン」のURL */
const scanLink = (links: BookLink[]) => links.find(l => isScan(l) && isUrl(l.url.trim()))?.url.trim()
const REPLACE_MEMO = '全ページスキャンから作った要約で、今の要約を置き換えますか？\n（時間がかかるので、この画面は閉じてもかまいません。終わると自動で保存されます）'
const emptyBook = (): Book => ({ id: crypto.randomUUID(), title: '', author: '', categoryId: lastCategory(), cover: '', baseMonth: lastBaseMonth(), status: '未読', memo: '', links: [], updatedAt: new Date().toISOString() })

// 表紙はDriveのファイルIDで保持する（以前の共有リンク形式もIDにそろえる）
const withCoverIds = (books: Book[]) => books.map(b => ({ ...b, cover: normalizeCover(b.cover || '') }))

function loadBooks(): Book[] {
  try { const value = localStorage.getItem(STORE); return value ? withCoverIds(JSON.parse(value)) : sampleBooks } catch { return sampleBooks }
}

const SEMANTIC_KEY = 'mybooks-semantic-search'
const DEBUG_KEY = 'mybooks-search-debug'
const readFlag = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1' } catch { return fallback } }
const writeFlag = (key: string, value: boolean) => { try { localStorage.setItem(key, value ? '1' : '0') } catch { /* noop */ } }
/** 検索結果の関連度（デバッグ表示用） */
interface SearchScore { score: number; semantic?: number; keyword: number }

function App() {
  const [books, setBooks] = useState<Book[]>(loadBooks)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState('all')
  const [view, setView] = useState<'cards' | 'table' | 'map'>('cards')
  const [editing, setEditing] = useState<Book | null>(null)
  const [modalTab, setModalTab] = useState<ModalTab>('edit')
  const openBook = (book: Book | null) => { setModalTab('edit'); setEditing(book) }
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const storeBooks = useCallback((books: Book[]) => { const next = withCoverIds(books); setBooks(next); localStorage.setItem(STORE, JSON.stringify(next)) }, [])
  const drive = useDriveSync(STORE, books, storeBooks)
  // 意味検索（オン・オフと、開発確認用の関連度表示はこのブラウザに覚える。?debug を付けて開いても関連度を表示）
  const [semanticOn, setSemanticOn] = useState(() => readFlag(SEMANTIC_KEY, true))
  const [debug, setDebug] = useState(() => readFlag(DEBUG_KEY, false) || new URLSearchParams(location.search).has('debug'))
  const semantic = useSemanticSearch(books, query, semanticOn, drive.status)
  const saveBooks = (next: Book[]) => { storeBooks(next); drive.markDirty() }
  // 画面下の短いお知らせ（数秒で消える）
  const [notices, setNotices] = useState<{ id: number; text: string; error?: boolean }[]>([])
  const notify = (text: string, error = false) => {
    const id = Date.now() + Math.random()
    setNotices(n => [...n, { id, text, error }])
    setTimeout(() => setNotices(n => n.filter(x => x.id !== id)), error ? 12000 : 8000)
  }
  // 全ページスキャンからの要約は時間がかかるので、本の詳細画面を閉じても続ける（本ごとに1つ）
  const [summaryJobs, setSummaryJobs] = useState<ReadonlyMap<string, SummaryJob>>(new Map())
  const booksRef = useRef(books)
  const editingRef = useRef(editing)
  useEffect(() => { booksRef.current = books; editingRef.current = editing })
  const dropJob = (id: string) => setSummaryJobs(m => { const next = new Map(m); next.delete(id); return next })
  const beginJob = (id: string): SummaryJob | null => {
    if (summaryJobs.get(id)?.status === 'running') return null
    const job: SummaryJob = { startedAt: Date.now(), status: 'running' }
    setSummaryJobs(m => new Map(m).set(id, job))
    return job
  }
  const runSummary = (book: Pick<Book, 'id' | 'title' | 'author'>, scanUrl: string, job: SummaryJob) => {
    const title = book.title.trim() || 'タイトル未入力の本'
    summarizeScan(scanUrl, book.title.trim(), book.author.trim()).then(summary => {
      // 詳細画面で開いていれば編集中の要約欄に入れる。閉じていれば、その本の要約として保存する
      if (editingRef.current?.id === book.id) { setSummaryJobs(m => new Map(m).set(book.id, { ...job, status: 'done', summary })); return }
      dropJob(book.id)
      const latest = booksRef.current
      if (!latest.some(b => b.id === book.id)) return notify(`「${title}」の要約はできましたが、本が保存されていないため反映できませんでした`, true)
      saveBooks(latest.map(b => b.id === book.id ? { ...b, memo: summary, updatedAt: new Date().toISOString() } : b))
      notify(`「${title}」の要約を作成して保存しました`)
    }, (e: unknown) => {
      dropJob(book.id)
      notify(`「${title}」の要約を作成できませんでした：${e instanceof Error ? e.message : String(e)}`, true)
    })
  }
  const startSummary = (book: Pick<Book, 'id' | 'title' | 'author'>, scanUrl: string) => {
    const job = beginJob(book.id)
    if (job) runSummary(book, scanUrl, job)
  }
  // カードから、詳細画面を開かずに表紙からの入力と全ページスキャンからの要約を続けて行う（読み取った内容はそのまま保存する）
  const startCoverAndSummary = (book: Book) => {
    const scanUrl = scanLink(book.links)
    if (!scanUrl || (book.memo.trim() && !confirm(REPLACE_MEMO))) return
    const job = beginJob(book.id)
    if (job) void coverThenSummary(book, scanUrl, job)
  }
  const coverThenSummary = async (book: Book, scanUrl: string, job: SummaryJob) => {
    // Googleのログインのポップアップは、ボタンを押した直後に開く必要があるので先に済ませる
    await readToken().catch(() => null)
    let target: Book = book
    if (book.cover.trim()) {
      try {
        const info = await readCoverInfo({ cover: book.cover })
        const latest = booksRef.current.find(b => b.id === book.id) ?? book
        const { read } = coverFields(booksRef.current, latest, info)
        const changed = (Object.keys(read) as (keyof typeof read)[]).filter(key => read[key] !== latest[key].trim())
        target = { ...latest, ...read }
        if (changed.length) {
          const saved = { ...target, updatedAt: new Date().toISOString() }
          saveBooks(booksRef.current.map(b => b.id === book.id ? saved : b))
          notify(`「${target.title.trim() || 'タイトル未入力の本'}」の${changed.map(key => FILL_LABEL[key]).join('・')}を表紙から入力しました。続けて要約を作成します`)
        }
      } catch (e) { notify(`表紙から読み取れませんでした（${e instanceof Error ? e.message : String(e)}）。入力済みのタイトル・著者で要約を作ります`, true) }
    }
    runSummary(target, scanUrl, job)
  }
  // 基準月の候補（今月と、登録済みの本で使っている月を新しい順に）
  const monthOptions = useMemo(() => [...new Set([new Date().toISOString().slice(0, 7), ...books.map(b => b.baseMonth).filter(Boolean)])].sort().reverse(), [books])
  // 分類・読書状況で絞り込んだうえで、キーワード検索（従来どおりの部分一致）または意味検索を組み合わせたハイブリッド検索で並べる
  const semanticResult = semantic.state.status === 'ready' && semantic.state.query === query.trim() ? semantic.state.scores : null
  const { filtered, scores } = useMemo(() => {
    const candidates = books.filter(book => {
      const cat = categories.find(c => c.id === book.categoryId)
      return (category === 'all' || book.categoryId === category || cat?.parent === category) && (status === 'all' || book.status === status)
    }).map(book => {
      const { child, parent } = categoryPath(book.categoryId)
      return { book, haystack: `${book.title} ${book.author} ${book.memo} ${child?.name} ${parent?.name} ${book.baseMonth}` }
    })
    if (!semanticResult) return { filtered: candidates.filter(c => c.haystack.toLowerCase().includes(query.toLowerCase())).map(c => c.book), scores: null }
    const ranked = rankBooks(candidates, query, semanticResult)
    return { filtered: ranked.map(r => r.book), scores: new Map<string, SearchScore>(ranked.map(r => [r.book.id, r])) }
  }, [books, query, category, status, semanticResult])
  // 絞り込み条件が変わったら1ページ目に戻す（編集・追加では今のページのまま）
  const filterKey = `${query}\n${category}\n${status}`
  const [paging, setPaging] = useState({ key: filterKey, page: 1 })
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  if (paging.key !== filterKey) setPaging({ key: filterKey, page: 1 })
  const page = paging.key === filterKey ? Math.min(paging.page, pageCount) : 1
  const pageStart = (page - 1) * PAGE_SIZE
  const pageBooks = useMemo(() => filtered.slice(pageStart, pageStart + PAGE_SIZE), [filtered, pageStart])
  const headingRef = useRef<HTMLDivElement>(null)
  const filteredIds = useMemo(() => new Set(filtered.map(b => b.id)), [filtered])
  const paged = view !== 'map' && pageCount > 1
  const goPage = (next: number) => { setPaging({ key: filterKey, page: next }); headingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), books }, null, 2)], { type: 'application/json' })
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `mybooks-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(anchor.href)
  }
  const importFile = (file?: File) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(String(reader.result)); const next = Array.isArray(parsed) ? parsed : parsed.books
          if (!Array.isArray(next)) throw new Error(); saveBooks(next); setBackupOpen(false)
        } else {
          const lines = String(reader.result).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
          const headers = splitCsv(lines.shift() || '')
          const next = lines.map(line => { const row = splitCsv(line); const get = (name: string) => row[headers.indexOf(name)] || ''; const cat = categories.find(c => c.name === get('分類'))
            return { ...emptyBook(), title: get('タイトル'), author: get('著者'), categoryId: cat?.id || 'd1', baseMonth: get('基準月'), status: (['未読', '読書中', '読了'].includes(get('読書状況')) ? get('読書状況') : '未読') as ReadingStatus, memo: get('要約') || get('メモ'), cover: get('表紙画像URL'), links: parseCsvLinks(get('関連リンク')) } })
          const added = next.reduce<Book[]>((list, b) => findDuplicate(list, b) ? list : [...list, b], books).slice(books.length)
          if (added.length < next.length) alert(`登録済みの本と同じ ${next.length - added.length} 件は追加しませんでした。`)
          saveBooks([...books, ...added]); setBackupOpen(false)
        }
      } catch { alert('ファイルを読み込めませんでした。形式をご確認ください。') }
    }; reader.readAsText(file)
  }

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => { setQuery(''); setCategory('all'); setStatus('all') }}><img className="brandmark" src="/favicon.svg" alt="" /><span>MyBooks<small>わたしの本棚</small></span></button>
      <div className="header-actions"><button className={`ghost-btn backup-label sync-${drive.status}`} onClick={() => setBackupOpen(true)} title={syncLabel[drive.status]}><SyncIcon status={drive.status} /><span>{syncLabel[drive.status]}</span></button><button className="primary-btn" onClick={() => openBook(emptyBook())}><Plus /> 本を追加</button><button className="avatar" aria-label="設定"><Settings /></button></div>
    </header>

    <main>
      <DriveAlert drive={drive} onDetails={() => setBackupOpen(true)} />
      <section className="welcome"><div><p className="eyebrow">MY PERSONAL LIBRARY</p><h1>本棚を、もっと身近に。</h1><p>{books.length}冊の本と、学びの記録をひとつの場所で管理しています。</p></div><div className="stat"><span>読書中</span><strong>{books.filter(b => b.status === '読書中').length}</strong><BookOpen /></div></section>

      <section className="toolbar panel">
        <label className="search"><Search /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={semanticOn ? 'タイトル、著者、キーワード、文章から意味検索' : 'タイトル、著者、分類、要約、基準月（YYYY-MM）から検索'} />{query && <button type="button" onClick={() => setQuery('')} aria-label="検索語を消す"><X /></button>}<button type="button" className={`semantic-toggle${semanticOn ? ' active' : ''}`} aria-pressed={semanticOn} onClick={e => { e.preventDefault(); setSemanticOn(!semanticOn); writeFlag(SEMANTIC_KEY, !semanticOn) }} title={semanticOn ? '意味検索：オン（押すとキーワード検索だけにします）' : '意味検索：オフ（押すと意味の近さでも検索します）'}><Sparkles /><span>意味検索</span></button></label>
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="分類で絞り込み"><option value="all">すべての分類</option>{categories.map(c => <option key={c.id} value={c.id}>{c.parent ? '　└ ' : ''}{c.name}</option>)}</select>
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label="読書状況で絞り込み"><option value="all">すべての読書状況</option><option>未読</option><option>読書中</option><option>読了</option></select>
      </section>
      {semanticOn && query.trim() && <SemanticStatus semantic={semantic} query={query} ranked={Boolean(scores)} driveStatus={drive.status} debug={debug} onDebug={v => { setDebug(v); writeFlag(DEBUG_KEY, v) }} onConnect={() => void drive.connect()} />}

      <div className="content-heading" ref={headingRef}><div><h2>{scores ? '意味の近い順' : 'すべての本'}</h2><span>{paged ? `${filtered.length}冊中 ${pageStart + 1}〜${pageStart + pageBooks.length}冊を表示` : `${filtered.length}冊を表示`}</span></div><div className="view-switch"><button className={view === 'cards' ? 'active' : ''} onClick={() => setView('cards')}><Grid2X2 /> カード</button><button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}><List /> リスト</button><button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}><MapIcon /> マップ</button></div></div>

      {paged && <Pager page={page} pageCount={pageCount} onChange={goPage} />}
      {view === 'map' && books.length > 0 ? <Suspense fallback={<div className="book-map panel map-loading"><LoaderCircle className="spin" /> マップを準備しています…</div>}>
        <BookMap books={books} visibleIds={filteredIds} category={category} onCategory={setCategory} onSelect={openBook} driveStatus={drive.status} onConnect={() => void drive.connect()} />
      </Suspense> : filtered.length === 0 ? <Empty onAdd={() => openBook(emptyBook())} hasBooks={books.length > 0} /> : view === 'cards' ?
        <div className="book-grid">{pageBooks.map((book, i) => <BookCard key={book.id} no={pageStart + i + 1} book={book} score={debug ? scores?.get(book.id) : undefined} summarizing={summaryJobs.get(book.id)?.status === 'running'} onAutofill={startCoverAndSummary} onClick={() => openBook(book)} onZoom={setZoomed} />)}</div> :
        <BookTable books={pageBooks} startNo={pageStart + 1} scores={debug ? scores : null} onSelect={openBook} />}
      {paged && <Pager className="pager-bottom" page={page} pageCount={pageCount} onChange={goPage} />}
    </main>
    <footer><span><img src="/favicon.svg" alt="" /> MyBooks</span><p>あなたの学びを、いつでもそばに。</p></footer>
    {notices.length > 0 && <div className="notices" role="status">{notices.map(n => <p key={n.id} className={n.error ? 'error' : undefined}>{n.error ? <CloudAlert /> : <Check />}{n.text}<button type="button" aria-label="閉じる" onClick={() => setNotices(list => list.filter(x => x.id !== n.id))}><X /></button></p>)}</div>}
    {zoomed && <CoverLightbox {...zoomed} onClose={() => setZoomed(null)} />}
    {editing && <BookModal key={editing.id} book={editing} books={books} summaryJob={summaryJobs.get(editing.id)} onSummarize={startSummary} onSummaryApplied={() => dropJob(editing.id)} tab={modalTab} onTab={setModalTab} onOpen={openBook} monthOptions={monthOptions} onZoom={setZoomed} onClose={() => setEditing(null)} onSave={(book, open) => { try { localStorage.setItem(LAST_CATEGORY, book.categoryId); localStorage.setItem(LAST_BASE_MONTH, book.baseMonth) } catch { /* noop */ } if (findDuplicate(books, book)) return; const next = books.some(b => b.id === book.id) ? books.map(b => b.id === book.id ? book : b) : [book, ...books]; saveBooks(next); if (open) openBook(open); else setEditing(null) }} onDelete={id => { if (confirm('この本を削除しますか？')) { saveBooks(books.filter(b => b.id !== id)); setEditing(null) } }} />}
    {backupOpen && <BackupModal drive={drive} onClose={() => setBackupOpen(false)} onExport={exportJson} onImport={() => fileRef.current?.click()} />}
    <input ref={fileRef} hidden type="file" accept=".json,.csv" onChange={e => importFile(e.target.files?.[0])} />
  </div>
}

/** 検索欄の下に出す、意味検索の状態（準備中・検索中・エラー）と開発確認用の関連度表示の切り替え */
function SemanticStatus({ semantic, query, ranked, driveStatus, debug, onDebug, onConnect }: { semantic: ReturnType<typeof useSemanticSearch>; query: string; ranked: boolean; driveStatus: SyncStatus; debug: boolean; onDebug: (v: boolean) => void; onConnect: () => void }) {
  const { state, progress, indexError, hasIndex } = semantic
  const needsLogin = driveStatus === 'signedOut' || driveStatus === 'needsFolder' || state.status === 'error' && state.code === 'unauthorized' || indexError?.code === 'unauthorized'
  let text: React.ReactNode, error = false
  if (!wantsSemantic(query)) text = '1文字や基準月（YYYY-MM）は、キーワードだけで検索しています。'
  else if (ranked) text = <>意味の近い順に表示しています（タイトル・著者などが一致した本は少し上位に）。{progress && ` 意味検索の準備中（${progress.done}/${progress.total}冊）…`}</>
  else if (state.status === 'searching') text = <><LoaderCircle className="spin" /> 意味の近い本を探しています…</>
  else if (state.status === 'error') { text = `意味検索ができませんでした：${state.message}（キーワードで検索しています）`; error = true }
  else if (progress) text = <><LoaderCircle className="spin" /> 意味検索の準備中：本の内容をベクトル化しています（{progress.done}/{progress.total}冊）。それまではキーワードで検索しています。</>
  else if (!hasIndex && indexError) { text = `意味検索の準備ができませんでした：${indexError.message}（キーワードで検索しています）`; error = true }
  else if (!hasIndex && needsLogin) text = '意味検索を使うには、Google Driveに接続（ログイン）してください。それまではキーワードで検索しています。'
  else text = 'キーワードで検索しています。'
  return <div className={`semantic-status${error ? ' error' : ''}`} role="status">
    <span className="semantic-text"><Sparkles />{text}</span>
    {needsLogin && driveStatus !== 'unavailable' && !ranked && <button type="button" className="secondary-btn" onClick={onConnect}><Cloud /> Googleでログイン</button>}
    <label className="semantic-debug" title="開発確認用：各本に関連度（finalScore）を表示します"><input type="checkbox" checked={debug} onChange={e => onDebug(e.target.checked)} /> 関連度を表示</label>
    {debug && <button type="button" className="semantic-rebuild" disabled={Boolean(progress)} onClick={() => { if (confirm(`意味検索用のデータ（${semantic.indexed}冊分のベクトル）を、全冊計算し直しますか？\nEmbedding APIを全冊分呼び出します。`)) semantic.rebuild() }} title="開発確認用：全冊のEmbeddingを作り直します"><RefreshCw /> 作り直す</button>}
  </div>
}

function CoverLightbox({ src, alt, onClose }: Zoom & { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
    <button className="lightbox-close" aria-label="閉じる" onClick={onClose}><X /></button>
    <CoverImage src={src} alt={alt} width={1600} fallback={<p className="lightbox-error">画像を表示できません</p>} />
  </div>
}

function categoryPath(id: string) { const child = categories.find(c => c.id === id); const parent = categories.find(c => c.id === child?.parent); return { child, parent } }
/** デバッグ表示の関連度（finalScore）。内訳はマウスを乗せると表示 */
function ScoreBadge({ score }: { score: SearchScore }) {
  return <span className="search-score" title={`意味 ${score.semantic?.toFixed(3) ?? '未計算'} / キーワード ${score.keyword.toFixed(2)}`}>関連度 {score.score.toFixed(2)}</span>
}

function BookCard({ no, book, score, summarizing, onAutofill, onClick, onZoom }: { no: number; book: Book; score?: SearchScore; summarizing?: boolean; onAutofill: (b: Book) => void; onClick: () => void; onZoom: (z: Zoom) => void }) { const { child, parent } = categoryPath(book.categoryId); return <article className="book-card" onClick={onClick} tabIndex={0} onKeyDown={e => e.key === 'Enter' && onClick()}>
  <div className="cover-wrap"><CoverImage src={book.cover} alt={`${book.title}の表紙`} onZoom={onZoom} fallback={<div className="cover-placeholder"><BookOpen /><span>NO COVER</span></div>} /></div>
  <div className="card-body"><div className="category-line">{parent && <><span>{parent.name}</span><ChevronRight /></>}<b>{child?.name}</b></div><h3>{book.title}</h3><div className="author-line"><AuthorName author={book.author} /><span className="book-no">No.{no}</span></div><div className="card-meta"><span className="meta-left">{score && <ScoreBadge score={score} />}<span className={`status mini ${statusClass[book.status]}`}>{book.status}</span>{summarizing ? <span className="summary-busy" title="全ページスキャンから要約を作成しています"><LoaderCircle className="spin" />要約作成中</span> : <>{book.memo.trim() && <CopySummaryButton text={book.memo} />}{scanLink(book.links) && <button type="button" className="card-autofill" onClick={e => { e.stopPropagation(); onAutofill(book) }} onKeyDown={e => e.stopPropagation()} title="表紙から入力＋要約（表紙からタイトル・著者・分類を入力し、続けて全ページスキャンから要約を作ります）" aria-label="表紙から入力＋要約"><Sparkles /></button>}</>}{book.baseMonth && <span>{book.baseMonth.replace('-', '年')}月</span>}</span><span>{book.links.length ? `${book.links.length}件の資料` : '資料なし'}</span></div><CardLinks links={book.links} /></div>
</article> }

/** 著者名。登録済みは人物アイコン付きで濃く、未登録は薄い点線のラベルにして区別しやすくする */
function AuthorName({ author, small }: { author: string; small?: boolean }) {
  const name = author.trim()
  const Tag = small ? 'small' : 'p'
  return name ? <Tag className="author" title={name}><UserRound /><span>{name}</span></Tag> : <Tag className="author missing">著者未登録</Tag>
}

/** カードの要約コピーボタン（要約作成中の表示と同じ位置に出す） */
function CopySummaryButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { alert('要約をコピーできませんでした') }
  }
  return <button type="button" className={`copy-summary${copied ? ' copied' : ''}`} onClick={copy} onKeyDown={e => e.stopPropagation()} title={copied ? 'コピーしました' : '要約をコピー'} aria-label="要約をコピー">{copied ? <Check /> : <Copy />}{copied ? 'コピーしました' : '要約コピー'}</button>
}

function BookTable({ books, startNo, scores, onSelect }: { books: Book[]; startNo: number; scores: Map<string, SearchScore> | null; onSelect: (b: Book) => void }) { return <div className="table-wrap panel"><table><thead><tr><th>No.</th><th>本</th><th>分類</th><th>基準月</th><th>読書状況</th><th>関連資料</th><th></th></tr></thead><tbody>{books.map((b, i) => { const { child } = categoryPath(b.categoryId); return <tr key={b.id} onClick={() => onSelect(b)}><td className="book-no">{startNo + i}</td><td><div className="table-book"><CoverImage src={b.cover} alt="" fallback={<BookOpen />} /><span><strong>{b.title}</strong><AuthorName author={b.author} small /></span></div></td><td>{child?.name}</td><td>{b.baseMonth}</td><td><span className={`status inline ${statusClass[b.status]}`}>{b.status}</span>{scores?.get(b.id) && <ScoreBadge score={scores.get(b.id)!} />}</td><td>{b.links.length}件</td><td><ChevronRight /></td></tr> })}</tbody></table></div> }

function Empty({ onAdd, hasBooks }: { onAdd: () => void; hasBooks: boolean }) { return <div className="empty panel"><div><BookOpen /></div><h2>{hasBooks ? '条件に合う本がありません' : '最初の一冊を登録しましょう'}</h2><p>{hasBooks ? '検索条件や絞り込みを変えてみてください。' : '表紙や要約、関連資料をまとめて管理できます。'}</p>{!hasBooks && <button className="primary-btn" onClick={onAdd}><Plus /> 本を追加する</button>}</div> }

const canPickCover = Boolean(DRIVE_CLIENT_ID && DRIVE_API_KEY)
const canPasteCover = Boolean(DRIVE_CLIENT_ID)

type ModalTab = 'edit' | 'similar' | 'author'

/** 処理中の経過秒数（止まっていないことが分かるように表示する） */
function useElapsed(active: boolean, since?: number) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) return
    const started = since ?? Date.now()
    const tick = () => setElapsed(Math.floor((Date.now() - started) / 1000))
    const timer = setInterval(tick, 1000)
    return () => { clearInterval(timer); setElapsed(0) }
  }, [active, since])
  return elapsed
}

/** 全ページスキャンからの要約の処理（done: できあがったが、まだ詳細画面に反映していない） */
interface SummaryJob { startedAt: number; status: 'running' | 'done'; summary?: string }

/** 自動で入力した項目の記録（before: 入力前の値 / changed: 値が変わったか / source: 表紙・スキャンのどちらから） */
interface Filled { before: string; changed: boolean; source: 'cover' | 'scan' }

const FILL_LABEL = { title: 'タイトル', author: '著者', categoryId: '分類' } as const
/** 分類の表示名（例: F-1: ビジネススキル・法律） */
const categoryLabel = (id: string) => categories.find(c => c.id === id)?.name ?? id

/** onSave の open: 保存したあとに続けて開く本（類似する本・同じ著者の本から選んだとき） */
function BookModal({ book, books, summaryJob, onSummarize, onSummaryApplied, tab, onTab, onOpen, monthOptions, onClose, onSave, onDelete, onZoom }: { book: Book; books: Book[]; summaryJob?: SummaryJob; onSummarize: (b: Book, scanUrl: string) => void; onSummaryApplied: () => void; tab: ModalTab; onTab: (t: ModalTab) => void; onOpen: (b: Book) => void; monthOptions: string[]; onClose: () => void; onSave: (b: Book, open?: Book) => void; onDelete: (id: string) => void; onZoom: (z: Zoom) => void }) {
  const isNew = !book.title
  const [draft, setDraft] = useState<Book>({ ...book, links: withPresetRows(book.links) })
  // 表紙・スキャンから自動で入力した項目と、入力前の値（変更あり／なしの表示用。手で直すと目印を外す）
  const [filled, setFilled] = useState<ReadonlyMap<keyof Book, Filled>>(new Map())
  const update = <K extends keyof Book>(key: K, value: Book[K]) => {
    setDraft(d => ({ ...d, [key]: value }))
    setFilled(f => { if (!f.has(key)) return f; const next = new Map(f); next.delete(key); return next })
  }
  const addLink = () => update('links', [...draft.links, newLink()])
  const pickCover = async () => {
    try { const id = await pickImage(COVER_FOLDER_ID); if (id) update('cover', id) } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }
  const [uploading, setUploading] = useState(false)
  const uploadRef = useRef<Promise<string | null> | null>(null)
  const closingRef = useRef(false)
  // クリップボードの画像を表紙フォルダに「タイトル.拡張子」で保存し、そのファイルIDを表紙にする
  // タイトルが空のときは、先に画像からタイトルなどを読み取ってから保存する
  const pasteCover = async (image?: Blob) => {
    if (uploading || reading) return
    let title = draft.title.trim()
    try {
      image ??= await readClipboardImage() ?? undefined
      if (!image) return alert('クリップボードに画像がありません。表紙の画像をコピーしてから押してください')
      if (!title) {
        setReading(true)
        const info = await readCoverInfo({ image }).catch(() => null).finally(() => setReading(false))
        if (!info?.title) return alert('表紙からタイトルを読み取れませんでした。先にタイトルを入力してください（表紙画像のファイル名に使います）')
        title = applyCoverInfo(info)
      }
      setUploading(true)
      uploadRef.current = uploadCoverImage(image, title, COVER_FOLDER_ID)
      const id = await uploadRef.current
      if (id) update('cover', id)
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) } finally { uploadRef.current = null; setUploading(false) }
  }
  // 表紙から読み取ったタイトル・著者・分類を入力する（入力済みの内容と違うときは確認する）
  const [reading, setReading] = useState(false)
  const elapsed = useElapsed(reading)
  const [readNote, setReadNote] = useState('')
  /** 読み取った内容を入力し、入力したタイトルを返す */
  const applyCoverInfo = (info: CoverInfo): string => {
    const { read, detailed } = coverFields(books, draft, info)
    const title = read.title
    const keys = Object.keys(read) as (keyof typeof read)[]
    if (!keys.length) { setReadNote('表紙から読み取れる文字がありませんでした。'); return draft.title }
    // 確認せずに入力し、変更した項目には変更前の値と「元に戻す」を表示する
    setDraft(d => ({ ...d, ...read }))
    const changed = keys.filter(key => read[key] !== draft[key].trim())
    const same = keys.filter(key => !changed.includes(key))
    setFilled(new Map(keys.map(key => [key, { before: draft[key], changed: changed.includes(key), source: 'cover' }])))
    const missing = (['title', 'author', 'categoryId'] as const).filter(key => !read[key])
    const names = (list: readonly (keyof typeof read)[]) => list.map(key => FILL_LABEL[key]).join('・')
    setReadNote([changed.length && `変更：${names(changed)}`, same.length && `変更なし：${names(same)}`, missing.length && `読み取れず：${names(missing)}`].filter(Boolean).join('／') + (changed.length ? '。変更した項目を確認してください。' : '。表紙の内容と一致しています。') + (detailed ? `\n同じタイトルの本（${info.title}）がすでにあるため、詳しいタイトルにしました。` : ''))
    return title || draft.title
  }
  const readCover = async () => {
    if (reading || uploading) return
    if (!draft.cover.trim()) return alert('先に表紙の画像を設定してください（貼り付け・Driveから選ぶ・ファイルIDの入力）')
    setReading(true); setReadNote('')
    try { applyCoverInfo(await readCoverInfo({ cover: draft.cover })) } catch (e) { alert(e instanceof Error ? e.message : String(e)) } finally { setReading(false) }
  }
  // 全ページスキャンのリンク先から要約を作る
  const scanUrl = scanLink(draft.links)
  // 処理は App 側で続くので、この画面を閉じても止まらない（閉じている間に終われば、その本に保存される）
  const summarizing = summaryJob?.status === 'running'
  const summarizeElapsed = useElapsed(summarizing, summaryJob?.startedAt)
  const confirmReplaceMemo = () => !draft.memo.trim() || confirm(REPLACE_MEMO)
  const makeSummary = () => {
    if (!scanUrl || summarizing) return
    if (!confirmReplaceMemo()) return
    onSummarize(draft, scanUrl)
  }
  // 表紙からの入力と全ページスキャンからの要約を続けて行う（要約には読み取ったタイトル・著者を使う）
  const readCoverAndSummarize = async () => {
    if (reading || uploading || summarizing || !scanUrl) return
    if (!draft.cover.trim()) return alert('先に表紙の画像を設定してください（貼り付け・Driveから選ぶ・ファイルIDの入力）')
    if (!confirmReplaceMemo()) return
    // Googleのログインのポップアップは、ボタンを押した直後に開く必要があるので先に済ませる
    await readToken().catch(() => null)
    setReading(true); setReadNote('')
    let book = draft
    try {
      const info = await readCoverInfo({ cover: draft.cover })
      book = { ...draft, title: applyCoverInfo(info), author: info.author || draft.author }
    } catch (e) { setReadNote(`表紙から読み取れませんでした（${e instanceof Error ? e.message : String(e)}）。入力済みのタイトル・著者で要約を作ります。`) } finally { setReading(false) }
    onSummarize(book, scanUrl)
  }
  // この画面を開いている間にできあがった要約は、要約欄に入れて確認できるようにする
  const [appliedJob, setAppliedJob] = useState<SummaryJob>()
  if (summaryJob?.status === 'done' && summaryJob.summary && summaryJob !== appliedJob) {
    const summary = summaryJob.summary
    setAppliedJob(summaryJob)
    setDraft(d => ({ ...d, memo: summary }))
    setFilled(f => new Map(f).set('memo', { before: draft.memo, changed: summary.trim() !== draft.memo.trim(), source: 'scan' }))
  }
  useEffect(() => { if (summaryJob?.status === 'done' && summaryJob === appliedJob) onSummaryApplied() }, [summaryJob, appliedJob, onSummaryApplied])
  // 変更した項目は紫、読み取り結果と同じで変更しなかった項目は緑で示す
  const fill = (key: keyof Book) => { const f = filled.get(key); return f && (f.changed ? 'autofilled' : 'autofilled same') }
  const fillMark = (key: keyof Book) => {
    const f = filled.get(key); if (!f) return null
    const from = f.source === 'scan' ? 'スキャン' : '表紙'
    return f.changed ? <span className="fill-mark"><ScanText />{from}から・変更</span> : <span className="fill-mark same"><Check />{from}と一致</span>
  }
  const fillBefore = (key: 'title' | 'author' | 'categoryId' | 'memo') => {
    const f = filled.get(key); if (!f?.changed) return null
    const before = key === 'categoryId' ? categoryLabel(f.before) : f.before.trim()
    const shown = key === 'memo' && before.length > 120 ? `${before.slice(0, 120)}…` : before
    return <span className="fill-before"><b>変更前</b>{before ? <s title={before}>{shown}</s> : <em>（空欄）</em>}
      <button type="button" onClick={e => { e.preventDefault(); update(key, f.before) }} title="変更前の内容に戻します"><Undo2 />元に戻す</button></span>
  }
  const onPaste = (e: React.ClipboardEvent) => {
    const image = canPasteCover ? Array.from(e.clipboardData.files).find(f => f.type.startsWith('image/')) : undefined
    if (image) { e.preventDefault(); void pasteCover(image) }
  }
  // 著者名の空白は半角1つにそろえる（全角スペースや連続した空白を直す。例: 田坂 広志）
  const finalize = (b: Book): Book => ({ ...b, title: b.title.trim(), author: b.author.replace(/[\s\u3000]+/g, ' ').trim(), links: cleanLinks(b.links), updatedAt: new Date().toISOString() })
  const duplicate = findDuplicate(books, draft)
  const [monthError, setMonthError] = useState(false)
  const fixMonth = () => { const month = normalizeMonth(draft.baseMonth); setMonthError(month === null); if (month !== null) update('baseMonth', month); return month }
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!draft.title.trim() || duplicate) return; const baseMonth = fixMonth(); if (baseMonth === null) return; onSave(finalize({ ...draft, baseMonth })) }
  // 外側のクリックや×で閉じるときは、今の内容を保存してから閉じる（表紙のアップロード中なら完了を待つ）
  // 別の本を開くとき（open）も、今の本の変更を保存してから切り替える
  const saveAndClose = async (open?: Book) => {
    if (closingRef.current) return
    closingRef.current = true
    let current = draft
    if (uploadRef.current) { const id = await uploadRef.current.catch(() => null); if (id) current = { ...current, cover: id } }
    const same = (a: Book, b: Book) => JSON.stringify({ ...finalize(a), updatedAt: '' }) === JSON.stringify({ ...finalize(b), updatedAt: '' })
    if (!current.title.trim() || same(current, book)) { if (open) onOpen(open); else onClose() }
    else if (findDuplicate(books, current)) { closingRef.current = false; alert('同じ本（タイトルまたは関連リンクのURLが同じ本）がすでに登録されているため保存できません。内容を変えるか、キャンセルで閉じてください。') }
    else onSave(finalize(current), open)
  }
  const openRelated = (b: Book) => void saveAndClose(b)
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) void saveAndClose() }}><section className="modal" onPaste={onPaste}><div className="modal-head"><div><p className="eyebrow">{isNew ? 'NEW BOOK' : 'BOOK DETAILS'}</p><h2>{isNew ? '本を追加' : '本の詳細・編集'}</h2></div>
    <div className="modal-tabs" role="tablist">{([['edit', <><BookOpen /> 詳細・編集</>], ['similar', <><Sparkles /> 類似する本</>], ['author', <><UserRound /> 同じ著者の本</>]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => onTab(id)}>{label}</button>)}</div>
    <button className="icon-btn" onClick={() => void saveAndClose()} title="保存して閉じる"><X /></button></div>{tab === 'similar' && <div className="related-panel"><SimilarBooks book={book} books={books} onOpen={openRelated} /></div>}
    {tab === 'author' && <div className="related-panel"><SameAuthorBooks book={{ ...book, author: draft.author }} books={books} onOpen={openRelated} /></div>}
    <form onSubmit={submit} hidden={tab !== 'edit'}>
    <div className="form-layout"><div className="cover-editor"><CoverImage src={draft.cover} alt={`${draft.title || '表紙'}のプレビュー`} onZoom={onZoom} fallback={canPasteCover
      ? <button type="button" className="cover-placeholder paste-target" onClick={() => void pasteCover()} disabled={uploading || reading} title="クリップボードの画像を表紙として保存">{uploading || reading ? <><LoaderCircle className="spin" /><span>{reading ? '表紙を読み取り中…' : 'アップロード中…'}</span></> : <><ClipboardPaste /><span>{draft.cover ? '表示できません' : 'クリックして'}<br />クリップボードの<br />画像を貼り付け</span></>}</button>
      : <div className="cover-placeholder"><BookOpen /><span>{draft.cover ? '表示できません' : '表紙プレビュー'}</span></div>} /><div className="cover-fields"><label>表紙（DriveのファイルID）<input value={draft.cover} onChange={e => update('cover', normalizeCover(e.target.value))} placeholder="ファイルID・共有リンク・画像URL" /></label>
      <div className="cover-actions">{canPasteCover && <button type="button" className="secondary-btn" onClick={() => void pasteCover()} disabled={uploading}>{uploading ? <LoaderCircle className="spin" /> : <ClipboardPaste />} {uploading ? 'アップロード中…' : '画像を貼り付け'}</button>}{canPickCover && <button type="button" className="secondary-btn" onClick={pickCover}><FolderOpen /> Driveから選ぶ</button>}<a href={driveFileUrl(draft.cover) ?? COVER_FOLDER_URL} target="_blank" rel="noreferrer"><ExternalLink />{driveFileUrl(draft.cover) ? 'Driveで開く' : '表紙フォルダを開く'}</a></div>
      <small className="cover-hint">{canPasteCover && 'コピーした画像は、表紙フォルダに「タイトル名」のファイルとして保存されます（Ctrl+Vでも可）。'}表紙フォルダの画像はファイルIDで保存します。共有リンクを貼るとIDに変換されます。表示するには、フォルダの共有設定を「リンクを知っている全員」にしてください。</small></div></div>
    <div className="fields"><div className="autofill-bar"><button type="button" className="autofill-btn" onClick={() => void readCover()} disabled={reading} title="表紙の画像の文字を読み取り、タイトル・著者・分類を入力します">{reading ? <LoaderCircle className="spin" /> : <ScanText />}{reading ? `読み取り中…${elapsed ? ` ${elapsed}秒` : ''}` : '表紙から入力'}</button><button type="button" className="autofill-btn" onClick={() => void readCoverAndSummarize()} disabled={reading || summarizing || !scanUrl} title={scanUrl ? '表紙からタイトル・著者・分類を入力し、続けて全ページスキャンから要約を作ります' : '関連リンクの「全ページスキャン」にURLを入れると使えます'}><Sparkles />表紙から入力＋要約</button><span>タイトル・著者・分類を表紙の画像から読み取ります</span>{readNote && <small className="field-note">{readNote}</small>}</div><label>タイトル <em>必須</em>{fillMark('title')}<input className={duplicate ? 'invalid' : fill('title')} required autoFocus={isNew} value={draft.title} onChange={e => update('title', e.target.value)} placeholder="本のタイトル" />{fillBefore('title')}{duplicate && <small className="field-error">{duplicate.reason === 'url' ? '同じURLの関連リンクを持つ本' : '同じ本'}がすでに登録されています（{duplicate.book.title}{duplicate.book.author && ` / ${duplicate.book.author}`}）</small>}</label><label>著者{fillMark('author')}<input className={fill('author')} value={draft.author} onChange={e => update('author', e.target.value)} placeholder="著者名" />{fillBefore('author')}</label><div className="field-row"><label>分類{fillMark('categoryId')}<select className={fill('categoryId')} value={draft.categoryId} onChange={e => update('categoryId', e.target.value)}>{categories.filter(c => c.parent).map(c => { const p = categories.find(p => p.id === c.parent); return <option value={c.id} key={c.id}>{p?.name} ＞ {c.name}</option> })}</select>{fillBefore('categoryId')}</label><label>基準月<input className={monthError ? 'invalid' : undefined} list="base-month-options" inputMode="numeric" autoComplete="off" placeholder="YYYY-MM（空欄可）" value={draft.baseMonth} onChange={e => { update('baseMonth', e.target.value); setMonthError(false) }} onBlur={fixMonth} />{monthError && <small className="field-error">YYYY-MM の形式で入力してください（例：2026-09）</small>}<datalist id="base-month-options">{monthOptions.map(m => <option key={m} value={m} />)}</datalist></label></div><label>読書状況<select value={draft.status} onChange={e => update('status', e.target.value as ReadingStatus)}><option>未読</option><option>読書中</option><option>読了</option></select></label><label>要約{!filled.has('memo') && <button type="button" className="label-action" onClick={makeSummary} disabled={!scanUrl || summarizing} title={scanUrl ? '関連リンクの「全ページスキャン」のファイルを読み、要約を作ります' : '関連リンクの「全ページスキャン」にURLを入れると使えます'}>{summarizing ? <LoaderCircle className="spin" /> : <Sparkles />}{summarizing ? `要約を作成中…${summarizeElapsed ? ` ${summarizeElapsed}秒` : ''}` : '全ページスキャンから要約'}</button>}{fillMark('memo')}<textarea className={fill('memo')} rows={filled.has('memo') ? 8 : 4} value={draft.memo} onChange={e => update('memo', e.target.value)} placeholder={summarizing ? '全ページスキャンから要約を作成しています…' : '本の要約'} disabled={summarizing} />{summarizing && <small className="field-note">要約の作成には数十秒〜数分かかります。この画面を閉じても処理は続き、終わると自動で保存されます。</small>}{fillBefore('memo')}</label></div></div>
    <div className="links-section"><div className="section-title"><div><h3>関連リンク</h3><p>上の5つは固定の欄です。追加したリンクは左端の <GripVertical className="inline-icon" /> をドラッグして並べ替えられます。URLが空の欄は保存されません。</p>{duplicate?.reason === 'url' && <p className="field-error">同じURLのリンクが「{duplicate.book.title}」に登録されています</p>}</div><button type="button" className="secondary-btn" onClick={addLink}><Plus /> リンクを追加</button></div><LinkEditor links={draft.links} onChange={links => update('links', links)} /></div>
    <div className="modal-actions">{!isNew && <button type="button" className="danger-btn" onClick={() => onDelete(draft.id)}><Trash2 /> 削除</button>}<span /><button type="button" className="ghost-btn" onClick={onClose}>キャンセル</button><button className="primary-btn" disabled={Boolean(duplicate)}>{isNew ? '本を登録する' : '変更を保存'}</button></div>
  </form></section></div>
}

const syncLabel: Record<SyncStatus, string> = { unavailable: '保存・バックアップ', signedOut: 'Drive未接続', needsFolder: 'フォルダの許可が必要', syncing: '同期中…', synced: 'Drive保存済み', pending: '保存待ち', error: '同期エラー' }
function SyncIcon({ status }: { status: SyncStatus }) {
  if (status === 'syncing') return <LoaderCircle className="spin" />
  if (status === 'synced') return <CloudCheck />
  if (status === 'pending') return <CloudUpload />
  if (status === 'error' || status === 'needsFolder') return <CloudAlert />
  if (status === 'signedOut') return <CloudOff />
  return <Cloud />
}

// Driveに保存できていない状態は、画面上部にはっきり表示して、その場で接続し直せるようにする
function DriveAlert({ drive, onDetails }: { drive: ReturnType<typeof useDriveSync>; onDetails: () => void }) {
  const info = drive.status === 'signedOut' ? { title: 'Google Driveに接続されていません', text: '変更はこのブラウザにだけ保存され、Driveには保存されません。別の端末とも同期されません。', label: 'Googleでログインして接続', action: drive.connect }
    : drive.status === 'needsFolder' ? { title: 'Google Driveの保存先フォルダが許可されていません', text: '許可するまで、変更はDriveに保存されません。', label: 'MyBooksフォルダを許可', action: drive.grantFolder }
    : drive.status === 'error' ? { title: 'Google Driveとの同期に失敗しました', text: `${drive.message ? `${drive.message}。` : ''}変更はまだDriveに保存されていません。`, label: '再試行', action: drive.syncNow }
    : null
  if (!info) return null
  return <section className={`drive-alert sync-${drive.status}`} role="alert"><CloudAlert /><div><strong>{info.title}</strong><p>{info.text}</p></div><div className="drive-alert-actions"><button className="ghost-btn" onClick={onDetails}>詳細</button><button className="primary-btn" onClick={() => void info.action()}>{info.label}</button></div></section>
}

function DriveSection({ drive }: { drive: ReturnType<typeof useDriveSync> }) {
  if (drive.status === 'unavailable') return <div className="backup-info"><CloudOff /><div><strong>Google Drive保存は未設定です</strong><p>環境変数 <code>VITE_GOOGLE_CLIENT_ID</code> を設定すると、Google Driveに自動保存できます（READMEを参照）。現在はこのブラウザ内にのみ保存されています。</p></div></div>
  const connected = drive.status !== 'signedOut'
  return <div className={`backup-info drive-info sync-${drive.status}`}><SyncIcon status={drive.status} /><div>
    <strong>{drive.status === 'needsFolder' ? '保存先フォルダへのアクセスを許可してください' : connected ? `Google Driveに自動保存しています（${syncLabel[drive.status]}）` : 'Google Driveに接続していません'}</strong>
    <p>{drive.status === 'needsFolder'
      ? <>初回のみ、Googleの選択画面で保存先の <a href={DATA_FOLDER_URL} target="_blank" rel="noreferrer">MyBooksフォルダ</a> を選んで「選択」を押すと、そのフォルダに <code>{DRIVE_FILE_NAME}</code> を作成して保存します。</>
      : connected ? <><a href={DATA_FOLDER_URL} target="_blank" rel="noreferrer">MyBooksフォルダ</a> の <code>{DRIVE_FILE_NAME}</code> に保存し、別の端末とも同じデータを使えます。</> : '接続すると、本棚のデータをGoogle DriveのMyBooksフォルダに自動保存し、別の端末でも同じデータを使えます。'}
      {drive.lastSync && <><br />最終同期：{new Date(drive.lastSync).toLocaleString('ja-JP')}</>}</p>
    {drive.message && <p className="drive-error">{drive.message}</p>}
    <div className="drive-actions">{drive.status === 'needsFolder'
      ? <><button className="primary-btn" onClick={() => void drive.grantFolder()}><FolderOpen /> MyBooksフォルダを許可</button><button className="ghost-btn" onClick={drive.disconnect}><LogOut /> 接続を解除</button></>
      : connected
      ? <><button className="secondary-btn" disabled={drive.status === 'syncing'} onClick={() => void drive.syncNow()}><RefreshCw /> 今すぐ同期</button><button className="ghost-btn" onClick={drive.disconnect}><LogOut /> 接続を解除</button></>
      : <button className="primary-btn" onClick={() => void drive.connect()}><Cloud /> Googleでログインして接続</button>}</div>
  </div></div>
}

function BackupModal({ drive, onClose, onExport, onImport }: { drive: ReturnType<typeof useDriveSync>; onClose: () => void; onExport: () => void; onImport: () => void }) { return <div className="modal-backdrop"><section className="modal small"><div className="modal-head"><div><p className="eyebrow">DATA MANAGEMENT</p><h2>保存・バックアップ</h2></div><button className="icon-btn" onClick={onClose}><X /></button></div><DriveSection drive={drive} /><div className="backup-cards"><button onClick={onExport}><Download /><span><strong>バックアップを書き出す</strong><small>全データをJSON形式で保存</small></span></button><button onClick={onImport}><Upload /><span><strong>データを読み込む</strong><small>JSONバックアップまたはCSV</small></span></button></div><p className="hint">読み込み時、JSONは現在のデータを置き換え、CSVは現在の本棚に追加されます。Google Driveに接続中は、読み込んだ内容もDriveに保存されます。</p></section></div> }

function splitCsv(line: string) { const values: string[] = []; let value = '', quoted = false; for (let i = 0; i < line.length; i++) { const char = line[i]; if (char === '"' && line[i + 1] === '"') { value += '"'; i++ } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { values.push(value); value = '' } else value += char } values.push(value); return values }
// 「表示名::URL」を | で区切る。以前の「種類::表示名::URL」形式も読み込める
function parseCsvLinks(value: string): BookLink[] { return value.split('|').map(v => v.trim()).filter(Boolean).map((entry, i) => { const parts = entry.split('::'); const url = parts.at(-1) ?? ''; const label = parts.length > 1 ? parts.at(-2) ?? '' : ''; return { id: `${crypto.randomUUID()}-${i}`, label, url } }).filter(l => l.url) }

/** 一覧のページ送り（前後ボタンとページ番号。幅に入りきらないときだけ途中を省略） */
function Pager({ page, pageCount, onChange, className }: { page: number; pageCount: number; onChange: (page: number) => void; className?: string }) {
  const ref = useRef<HTMLElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [fitsAll, setFitsAll] = useState(false)
  // 全ページ分のボタンを見えない所に並べ、実際の幅が収まるかを測る
  useLayoutEffect(() => {
    const nav = ref.current, measure = measureRef.current; if (!nav || !measure) return
    const check = () => setFitsAll(measure.scrollWidth <= nav.clientWidth)
    const observer = new ResizeObserver(check)
    observer.observe(nav); check()
    return () => observer.disconnect()
  }, [pageCount])
  const all = Array.from({ length: pageCount }, (_, i) => i + 1)
  const numbers = fitsAll ? all : all.filter(n => n === 1 || n === pageCount || Math.abs(n - page) <= 2)
  return <nav className={className ? `pager ${className}` : 'pager'} ref={ref} aria-label="ページ送り">
    <button disabled={page === 1} onClick={() => onChange(page - 1)} aria-label="前のページ"><ChevronLeft /></button>
    {numbers.map((n, i) => <span key={n} className="pager-item">{i > 0 && n - numbers[i - 1] > 1 && <span className="pager-gap">…</span>}<button className={n === page ? 'active' : ''} aria-current={n === page ? 'page' : undefined} onClick={() => onChange(n)}>{n}</button></span>)}
    <button disabled={page === pageCount} onClick={() => onChange(page + 1)} aria-label="次のページ"><ChevronRight /></button>
    <div className="pager pager-measure" ref={measureRef} aria-hidden="true"><button tabIndex={-1}><ChevronLeft /></button>{all.map(n => <button key={n} tabIndex={-1}>{n}</button>)}<button tabIndex={-1}><ChevronRight /></button></div>
  </nav>
}

export default App
