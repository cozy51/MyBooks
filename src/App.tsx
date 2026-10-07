import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Check, ChevronLeft, ChevronRight, CircleAlert, CircleStop, ScanLine, ClipboardPaste, Clock, Copy, Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload, Download, ExternalLink, FolderOpen, GripVertical, Grid2X2, List, LoaderCircle, Map as MapIcon, LogOut, RefreshCw, Plus, ScanText, Undo2, Search, Settings, Sparkles, Trash2, Upload, UserRound, X } from 'lucide-react'
import { COVER_FOLDER_ID, COVER_FOLDER_URL, driveFileId, driveFileUrl, normalizeCover } from './cover'
import { categories, sampleBooks, statusClass } from './data'
import { CoverImage, type Zoom } from './CoverImage'
import { DATA_FOLDER_URL, DRIVE_API_KEY, DRIVE_CLIENT_ID, DRIVE_FILE_NAME, pickImage, readClipboardImage, storedToken as storedGoogleToken, storedYouTubeToken, uploadCoverImage } from './drive'
import { useDriveSync, type SyncStatus } from './useDriveSync'
import { CardLinks, LinkEditor } from './LinkEditor'
import { SameAuthorBooks, SimilarBooks } from './RelatedBooks'
import { AuthorHub } from './AuthorHub'
import { authorNames } from './authors'
import { readCoverInfo, type CoverInfo } from './coverInfo'
import { cleanLinks, isScan, isUrl, newLink, withPresetRows } from './links'
import { readToken, STALL_LIMIT, SummaryError, summarizeScan, type SummaryFailure, type SummaryProgress, type SummaryStage } from './scanSummary'
import { scanFileName } from './scanCheck'
import { rankBooks, wantsSemantic } from './semanticSearch'
import { useSemanticSearch } from './useSemanticSearch'
import { AiPicksModal } from './AiPicks'
import { bookItem, videoItem, validateVideos } from './library'
import { InterestAnalysis } from './InterestAnalysis'
import { useVideoAnalysis } from './useVideoAnalysis'
import { useVideoLibrary } from './useVideoLibrary'
import { VideoCard, VideoModal } from './YouTubeLibrary'
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
const PAGE_KEY = 'mybooks-page'
const readFlag = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1' } catch { return fallback } }
const writeFlag = (key: string, value: boolean) => { try { localStorage.setItem(key, value ? '1' : '0') } catch { /* noop */ } }
/** 検索結果の関連度（デバッグ表示用） */
interface SearchScore { score: number; semantic?: number; keyword: number }

function App() {
  const [books, setBooks] = useState<Book[]>(loadBooks)
  const videoLibrary = useVideoLibrary()
  const analysis = useVideoAnalysis(videoLibrary.ref, videoLibrary.update)
  const [contentType, setContentType] = useState<'book' | 'youtube' | 'all'>('book')
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set())
  const [editingVideo, setEditingVideo] = useState<string | null>(null)
  const [interestsOpen, setInterestsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    if (!settingsOpen) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setSettingsOpen(false) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [settingsOpen])
  const libraryItems = useMemo(() => [...books.map(bookItem), ...videoLibrary.videos.map(videoItem)], [books, videoLibrary.videos])
  const displayedItems = useMemo(() => libraryItems.filter(i => contentType === 'all' || i.type === contentType), [libraryItems, contentType])
  const openItem = (item: Book) => { if ('type' in item && item.type === 'youtube') setEditingVideo(item.id); else openBook(item) }
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState('all')
  const [view, setView] = useState<'cards' | 'table' | 'map'>('cards')
  const [editing, setEditing] = useState<Book | null>(null)
  const [modalTab, setModalTab] = useState<ModalTab>('edit')
  const openBook = (book: Book | null) => { setModalTab('edit'); setEditing(book ? books.find(b => b.id === book.id) ?? book : null) }
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const [aiPicksOpen, setAiPicksOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const storeBooks = useCallback((books: Book[]) => { const next = withCoverIds(books); setBooks(next); localStorage.setItem(STORE, JSON.stringify(next)) }, [])
  const drive = useDriveSync(STORE, books, storeBooks)
  // 意味検索（オン・オフと、開発確認用の関連度表示はこのブラウザに覚える。?debug を付けて開いても関連度を表示）
  const [semanticOn, setSemanticOn] = useState(() => readFlag(SEMANTIC_KEY, true))
  const [debug, setDebug] = useState(() => readFlag(DEBUG_KEY, false) || new URLSearchParams(location.search).has('debug'))
  const semantic = useSemanticSearch(libraryItems, query, semanticOn, drive.status, videoLibrary.videos.length > 0)
  const saveBooks = (next: Book[]) => { storeBooks(next); drive.markDirty(withCoverIds(next)) }
  // 画面下の短いお知らせ（数秒で消える）
  const [notices, setNotices] = useState<{ id: number; text: string; error?: boolean }[]>([])
  const notify = (text: string, error = false) => {
    const id = Date.now() + Math.random()
    setNotices(n => [...n, { id, text, error }])
    setTimeout(() => setNotices(n => n.filter(x => x.id !== id)), error ? 12000 : 8000)
  }
  // 全ページスキャンからの要約は時間がかかるので、本の詳細画面を閉じても続ける（本ごとに1つ）
  const [summaryJobs, setSummaryJobs] = useState<ReadonlyMap<string, SummaryJob>>(new Map())
  // 要約を作れなかった本（時間切れ・失敗・中止・中断）は、あとから見て分かるように記録しておく
  const [summaryIssues, setSummaryIssues] = useState<Readonly<Record<string, SummaryIssue>>>(loadSummaryIssues)
  useEffect(() => { try { localStorage.setItem(SUMMARY_ISSUES, JSON.stringify(summaryIssues)) } catch { /* noop */ } }, [summaryIssues])
  // 作成中・順番待ちの要約を記録しておき、ページを閉じて途中で終わったものは次に開いたとき「中断」として残す
  useEffect(() => {
    const active = [...summaryJobs].filter(([, job]) => job.status !== 'done').map(([id, job]) => ({ id, startedAt: job.startedAt }))
    try { localStorage.setItem(SUMMARY_ACTIVE, JSON.stringify(active)) } catch { /* noop */ }
  }, [summaryJobs])
  const setIssue = (id: string, issue: SummaryIssue | null) => setSummaryIssues(m => {
    if (!issue && !m[id]) return m
    const next = { ...m }
    if (issue) next[id] = issue; else delete next[id]
    return next
  })
  const booksRef = useRef(books)
  const editingRef = useRef(editing)
  useEffect(() => { booksRef.current = books; editingRef.current = editing })
  const dropJob = (id: string) => setSummaryJobs(m => { const next = new Map(m); next.delete(id); return next })
  const beginJob = (id: string, status: SummaryJob['status'] = 'queued'): SummaryJob | null => {
    const current = summaryJobs.get(id)
    if (current && current.status !== 'done') return null
    const job: SummaryJob = { startedAt: Date.now(), status, abort: new AbortController(), ...(status === 'running' && { stage: 'cover', stageAt: Date.now() }) }
    setSummaryJobs(m => new Map(m).set(id, job))
    setIssue(id, null)
    return job
  }
  /** 作成中・順番待ちの要約を中止する（確認はしない） */
  const cancelSummary = (id: string) => {
    const job = summaryJobs.get(id)
    if (!job || job.status === 'done') return
    job.abort.abort()
  }
  const runSummary = (book: Pick<Book, 'id' | 'title' | 'author'>, scanUrl: string, job: SummaryJob) => {
    const title = book.title.trim() || 'タイトル未入力の本'
    // 順番待ちのあいだは「要約待ち」、自分の番になったら「要約作成中」にする（経過時間もそこから数える）
    const update = (change: Partial<SummaryJob>) => setSummaryJobs(m => { const current = m.get(book.id); return current?.abort === job.abort ? new Map(m).set(book.id, { ...current, ...change }) : m })
    update({ status: 'queued' })
    const onStart = () => update({ status: 'running', startedAt: Date.now(), stage: undefined, retries: 0 })
    // いまの段階と、やり直した回数を表示に使う（段階が変わったら、その段階の経過時間を数え直す）
    const onProgress = (p: SummaryProgress) => setSummaryJobs(m => {
      const current = m.get(book.id)
      if (current?.abort !== job.abort) return m
      return new Map(m).set(book.id, { ...current, stage: p.stage, retries: p.retries, stageAt: current.stage === p.stage ? current.stageAt : Date.now() })
    })
    summarizeScan(scanUrl, book.title.trim(), book.author.trim(), { signal: job.abort.signal, onStart, onProgress }).then(summary => {
      // 詳細画面で開いていれば編集中の要約欄に入れる。閉じていれば、その本の要約として保存する
      if (editingRef.current?.id === book.id) { setSummaryJobs(m => new Map(m).set(book.id, { ...job, status: 'done', summary })); return }
      dropJob(book.id)
      const latest = booksRef.current
      if (!latest.some(b => b.id === book.id)) return notify(`「${title}」の要約はできましたが、本が保存されていないため反映できませんでした`, true)
      saveBooks(latest.map(b => b.id === book.id ? { ...b, memo: summary, updatedAt: new Date().toISOString() } : b))
      notify(`「${title}」の要約を作成して保存しました`)
    }, (e: unknown) => {
      dropJob(book.id)
      const kind: SummaryFailure = e instanceof SummaryError ? e.kind : 'failed'
      const message = e instanceof Error ? e.message : String(e)
      setIssue(book.id, { kind, message, at: new Date().toISOString() })
      if (kind === 'cancelled') notify(`「${title}」の要約の作成を中止しました`)
      else if (kind === 'mismatch') notify(`「${title}」の全ページスキャンは別の本のファイルのようです。要約は保存しませんでした。リンクを確認してください`, true)
      else notify(`「${title}」の要約を作成できませんでした${kind === 'timeout' ? '（時間切れ）' : ''}：${message}`, true)
    })
  }
  const startSummary = (book: Pick<Book, 'id' | 'title' | 'author'>, scanUrl: string) => {
    const job = beginJob(book.id)
    if (job) runSummary(book, scanUrl, job)
  }
  // カードから、詳細画面を開かずに表紙からの入力と全ページスキャンからの要約を続けて行う（確認せずに、読み取った内容をそのまま保存する）
  // 要約がすでにある本は、要約は作り直さず、表紙からの入力だけ行う
  const startCoverAndSummary = (book: Book) => {
    const scanUrl = book.memo.trim() ? undefined : scanLink(book.links)
    if (!scanUrl && !book.cover.trim()) return
    // 表紙を読み取っているあいだは「要約作成中」と表示する
    const job = beginJob(book.id, 'running')
    if (job) void coverThenSummary(book, scanUrl, job)
  }
  const coverThenSummary = async (book: Book, scanUrl: string | undefined, job: SummaryJob) => {
    // Googleのログインのポップアップは、ボタンを押した直後に開く必要があるので先に済ませる
    if (scanUrl) await readToken().catch(() => null)
    let target: Book = book
    if (book.cover.trim()) {
      try {
        const info = await readCoverInfo({ cover: book.cover })
        const latest = booksRef.current.find(b => b.id === book.id) ?? book
        const { read } = coverFields(booksRef.current, latest, info)
        const changed = (Object.keys(read) as (keyof typeof read)[]).filter(key => read[key] !== latest[key].trim())
        target = { ...latest, ...read }
        const title = target.title.trim() || 'タイトル未入力の本'
        if (changed.length) {
          const saved = { ...target, updatedAt: new Date().toISOString() }
          saveBooks(booksRef.current.map(b => b.id === book.id ? saved : b))
          notify(`「${title}」の${changed.map(key => FILL_LABEL[key]).join('・')}を表紙から入力しました${scanUrl ? '。続けて要約を作成します' : ''}`)
        } else if (!scanUrl) notify(`「${title}」は表紙の内容と一致しています`)
      } catch (e) { notify(`表紙から読み取れませんでした（${e instanceof Error ? e.message : String(e)}）${scanUrl ? '。入力済みのタイトル・著者で要約を作ります' : ''}`, true) }
    }
    if (scanUrl && job.abort.signal.aborted) {
      dropJob(book.id)
      setIssue(book.id, { kind: 'cancelled', message: '要約の作成を中止しました。', at: new Date().toISOString() })
      notify(`「${target.title.trim() || 'タイトル未入力の本'}」の要約の作成を中止しました`)
    } else if (scanUrl) runSummary(target, scanUrl, job)
    else dropJob(book.id)
  }
  // 基準月の候補（今月と、登録済みの本で使っている月を新しい順に）
  const monthOptions = useMemo(() => [...new Set([new Date().toISOString().slice(0, 7), ...books.map(b => b.baseMonth).filter(Boolean)])].sort().reverse(), [books])
  // 分類・読書状況で絞り込んだうえで、キーワード検索（従来どおりの部分一致）または意味検索を組み合わせたハイブリッド検索で並べる
  const semanticResult = semantic.state.status === 'ready' && semantic.state.query === query.trim() ? semantic.state.scores : null
  const { filtered, scores } = useMemo(() => {
    const candidates = displayedItems.filter(book => {
      const cat = categories.find(c => c.id === book.categoryId)
      return (category === 'all' || book.categoryId === category || cat?.parent === category) && (status === 'all' || book.type === 'book' && book.status === status)
    }).map(book => {
      const { child, parent } = categoryPath(book.categoryId)
      return { book, haystack: `${book.title} ${book.author} ${book.memo} ${child?.name} ${parent?.name} ${book.baseMonth} ${book.description || ''} ${book.tags?.join(' ') || ''}` }
    })
    if (!semanticResult) return { filtered: candidates.filter(c => c.haystack.toLowerCase().includes(query.toLowerCase())).map(c => c.book), scores: null }
    const ranked = rankBooks(candidates, query, semanticResult)
    return { filtered: ranked.map(r => r.book), scores: new Map<string, SearchScore>(ranked.map(r => [r.book.id, r])) }
  }, [displayedItems, query, category, status, semanticResult])
  // 絞り込み条件が変わったら1ページ目に戻す（編集・追加では今のページのまま）
  const filterKey = `${contentType}\n${query}\n${category}\n${status}`
  // 表示中のページは再読み込みしても戻るように覚えておく（絞り込み条件ごと）
  const [paging, setPaging] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PAGE_KEY) || 'null') as { key?: unknown; page?: unknown } | null
      if (saved?.key === filterKey && Number.isInteger(saved.page) && (saved.page as number) > 0) return { key: filterKey, page: saved.page as number }
    } catch { /* noop */ }
    return { key: filterKey, page: 1 }
  })
  useEffect(() => { try { localStorage.setItem(PAGE_KEY, JSON.stringify(paging)) } catch { /* noop */ } }, [paging])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  if (paging.key !== filterKey) setPaging({ key: filterKey, page: 1 })
  const page = paging.key === filterKey ? Math.min(paging.page, pageCount) : 1
  const pageStart = (page - 1) * PAGE_SIZE
  const pageBooks = useMemo(() => filtered.slice(pageStart, pageStart + PAGE_SIZE), [filtered, pageStart])
  const headingRef = useRef<HTMLDivElement>(null)
  const filteredIds = useMemo(() => new Set(filtered.map(b => b.id)), [filtered])
  const paged = view !== 'map' && pageCount > 1
  const goPage = (next: number) => { setPaging({ key: filterKey, page: next }); headingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  // 詳細画面で前後の本へ移る（表示中の絞り込み・並び順のとおり。別のページの本へ移ったら、一覧もそのページにする）
  const editIndex = editing ? filtered.findIndex(b => b.id === editing.id) : -1
  const bookNav = editIndex >= 0 ? { prev: filtered[editIndex - 1], next: filtered[editIndex + 1], index: editIndex, total: filtered.length } : undefined
  const stepBook = (b: Book) => { const i = filtered.findIndex(x => x.id === b.id); if (i >= 0 && view !== 'map') setPaging({ key: filterKey, page: Math.floor(i / PAGE_SIZE) + 1 }) }

  const exportJson = () => {
    if (videoLibrary.storageError) { alert('動画データを読み込めないため、完全なバックアップを書き出せません。元の動画データを復元してから再試行してください。'); return }
    const blob = new Blob([JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), books, videos: videoLibrary.videos }, null, 2)], { type: 'application/json' })
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); const d = new Date(); anchor.download = `Backup_MyBooks-library_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`; anchor.click(); URL.revokeObjectURL(anchor.href)
  }
  const importFile = (file?: File) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(String(reader.result)); const next = Array.isArray(parsed) ? parsed : parsed.books
          if (!Array.isArray(next)) throw new Error(); const videos = parsed.videos === undefined ? null : validateVideos(parsed.videos); saveBooks(next); if (videos) videoLibrary.save(videos); setBackupOpen(false)
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
      <div className="header-actions"><button className={`ghost-btn backup-label sync-${drive.status}`} onClick={() => setBackupOpen(true)} title={syncLabel[drive.status]}><SyncIcon status={drive.status} /><span>{syncLabel[drive.status]}</span></button><button className="primary-btn" onClick={() => openBook(emptyBook())}><Plus /> 本を追加</button><button className="avatar" aria-label="設定" onClick={() => setSettingsOpen(true)}><Settings /></button></div>
    </header>

    <main>
      <DriveAlert drive={drive} onDetails={() => setBackupOpen(true)} />
      {videoLibrary.storageError && <p className="panel video-detail" role="alert">{videoLibrary.storageError}</p>}
      <section className="welcome"><div><p className="eyebrow">MY PERSONAL LIBRARY</p><h1>本棚を、もっと身近に。</h1><p>{videoLibrary.videos.length ? `${books.length}冊の本と${videoLibrary.videos.length}本の動画を、ひとつの知識ライブラリで管理しています。` : `${books.length}冊の本と、学びの記録をひとつの場所で管理しています。`}</p></div><div className="stat"><span>読書中</span><strong>{books.filter(b => b.status === '読書中').length}</strong><BookOpen /></div></section>

      <div className="library-tabs" role="group" aria-label="コンテンツの種類">{(['all', 'book', 'youtube'] as const).map(t => <button key={t} className={contentType === t ? 'active' : ''} aria-pressed={contentType === t} onClick={() => { setContentType(t); setStatus('all') }}>{t === 'all' ? 'すべて' : t === 'book' ? '本' : 'YouTube'}</button>)}</div>
      {contentType !== 'book' && <section className="youtube-tools panel"><button className="primary-btn" disabled={videoLibrary.syncing} onClick={() => void videoLibrary.importLiked()}><RefreshCw />{videoLibrary.syncing ? '同期中…' : 'YouTubeと同期'}</button><button className="secondary-btn" disabled={analysis.pending.size > 0 || !videoLibrary.videos.some(v => !v.analyzedAt)} onClick={() => void analysis.run(videoLibrary.videos)}>未解析動画を一括解析</button><button className="secondary-btn" disabled={analysis.pending.size > 0 || !selectedVideos.size} onClick={() => void analysis.run(videoLibrary.videos.filter(v => selectedVideos.has(v.id)))}>選択動画のみ解析（{selectedVideos.size}）</button>{analysis.pending.size > 0 && <button className="secondary-btn" onClick={analysis.cancel}>解析を中止</button>}<span role="status">{videoLibrary.message}</span><span role="status">{analysis.message}</span>{Object.keys(analysis.failures).length > 0 && <details><summary>解析エラー（{Object.keys(analysis.failures).length}件）</summary>{Object.entries(analysis.failures).map(([id, error]) => <p key={id}>{videoLibrary.videos.find(v => v.id === id)?.title}：{error}</p>)}</details>}</section>}
      <section className="toolbar panel">
        <label className="search"><Search /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={contentType === 'book' ? semanticOn ? 'タイトル、著者、キーワード、文章から意味検索' : 'タイトル、著者、分類、要約、基準月（YYYY-MM）から検索' : 'タイトル、チャンネル、概要、要約、タグ、文章から検索'} />{query && <button type="button" onClick={() => setQuery('')} aria-label="検索語を消す"><X /></button>}<button type="button" className={`semantic-toggle${semanticOn ? ' active' : ''}`} aria-pressed={semanticOn} onClick={e => { e.preventDefault(); setSemanticOn(!semanticOn); writeFlag(SEMANTIC_KEY, !semanticOn) }} title={semanticOn ? '意味検索：オン（押すとキーワード検索だけにします）' : '意味検索：オフ（押すと意味の近さでも検索します）'}><Sparkles /><span>意味検索</span></button></label>
        <button type="button" className="ai-pick-btn" onClick={() => setAiPicksOpen(true)} title="知りたいことを入力すると、表示対象の本・動画から理由とともに推薦します"><Sparkles /> {contentType === 'all' ? 'AIセレクト' : contentType === 'youtube' ? 'AI選動画' : 'AI選書'}</button>
        <button type="button" className="secondary-btn" onClick={() => setInterestsOpen(true)}><Sparkles /> 興味分析</button>
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="分類で絞り込み"><option value="all">すべての分類</option>{categories.map(c => <option key={c.id} value={c.id}>{c.parent ? '　└ ' : ''}{c.name}</option>)}</select>
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label="読書状況で絞り込み" disabled={contentType === 'youtube'}><option value="all">すべての読書状況</option><option>未読</option><option>読書中</option><option>読了</option></select>
      </section>
      {semanticOn && query.trim() && <SemanticStatus semantic={semantic} query={query} ranked={Boolean(scores)} driveStatus={drive.status} debug={debug} onDebug={v => { setDebug(v); writeFlag(DEBUG_KEY, v) }} onConnect={() => void drive.connect()} />}

      <div className="content-heading" ref={headingRef}><div><h2>{scores ? '意味の近い順' : contentType === 'youtube' ? 'すべての動画' : contentType === 'all' ? 'すべてのライブラリ' : 'すべての本'}</h2><span>{paged ? `${filtered.length}${contentType === 'book' ? '冊の本' : contentType === 'youtube' ? '本の動画' : '件のライブラリ'}のうち ${pageStart + 1}〜${pageStart + pageBooks.length}${contentType === 'book' ? '冊' : contentType === 'youtube' ? '本' : '件'}を表示` : `${filtered.length}${contentType === 'book' ? '冊の本' : contentType === 'youtube' ? '本の動画' : '件のライブラリ'}を表示`}</span></div><div className="view-switch"><button className={view === 'cards' ? 'active' : ''} onClick={() => setView('cards')}><Grid2X2 /> カード</button><button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}><List /> リスト</button><button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}><MapIcon /> マップ</button></div></div>

      {paged && <Pager page={page} pageCount={pageCount} onChange={goPage} />}
      {view === 'map' && displayedItems.length > 0 ? <Suspense fallback={<div className="book-map panel map-loading"><LoaderCircle className="spin" /> マップを準備しています…</div>}>
        <BookMap books={libraryItems} visibleIds={filteredIds} category={category} onCategory={setCategory} onSelect={openItem} driveStatus={drive.status} onConnect={() => void drive.connect()} />
      </Suspense> : filtered.length === 0 ? contentType === 'book' ? <Empty onAdd={() => openBook(emptyBook())} hasBooks={books.length > 0} /> : <div className="empty panel"><h2>{query || category !== 'all' ? '条件に合う項目がありません' : 'YouTubeと同期して、高評価動画を取り込みましょう'}</h2><p>動画の取得とAI解析は別々に実行できます。</p></div> : view === 'cards' ?
        <div className="book-grid">{pageBooks.map((book, i) => 'type' in book && book.type === 'youtube' ? <VideoCard key={book.id} busy={analysis.pending.has(book.id)} onAnalyze={() => void analysis.run(videoLibrary.videos.filter(v => v.id === book.id))} video={videoLibrary.videos.find(v => v.id === book.id)!} onOpen={() => setEditingVideo(book.id)} selected={selectedVideos.has(book.id)} onSelect={() => setSelectedVideos(s => { const next = new Set(s); if (next.has(book.id)) next.delete(book.id); else next.add(book.id); return next })} /> : <BookCard key={book.id} no={pageStart + i + 1} book={books.find(b => b.id === book.id) ?? book} score={debug ? scores?.get(book.id) : undefined} summary={summaryJobs.get(book.id)} issue={summaryIssues[book.id]} onCancelSummary={cancelSummary} onAutofill={startCoverAndSummary} onClick={() => openBook(book)} onZoom={setZoomed} />)}</div> :
        <BookTable books={pageBooks} startNo={pageStart + 1} scores={debug ? scores : null} onSelect={openItem} />}
      {paged && <Pager className="pager-bottom" page={page} pageCount={pageCount} onChange={goPage} />}
    </main>
    <footer><span><img src="/favicon.svg" alt="" /> MyBooks</span><p>あなたの学びを、いつでもそばに。</p></footer>
    {notices.length > 0 && <div className="notices" role="status">{notices.map(n => <p key={n.id} className={n.error ? 'error' : undefined}>{n.error ? <CloudAlert /> : <Check />}{n.text}<button type="button" aria-label="閉じる" onClick={() => setNotices(list => list.filter(x => x.id !== n.id))}><X /></button></p>)}</div>}
    {editingVideo && videoLibrary.videos.some(v => v.id === editingVideo) && <VideoModal busy={analysis.pending.has(editingVideo)} onAnalyze={() => void analysis.run(videoLibrary.videos.filter(v => v.id === editingVideo))} video={videoLibrary.videos.find(v => v.id === editingVideo)!} onClose={() => setEditingVideo(null)} />}
    {interestsOpen && <InterestAnalysis items={libraryItems} videos={videoLibrary.videos} onClose={() => setInterestsOpen(false)} />}
    {settingsOpen && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="設定"><div className="modal-head"><h2>設定</h2><button className="icon-btn" aria-label="閉じる" onClick={() => setSettingsOpen(false)}><X /></button></div><div className="video-detail"><h3>YouTube連携</h3><p>Googleアカウント：{!DRIVE_CLIENT_ID ? '未設定' : storedGoogleToken() ? '接続済み' : '未接続'}</p><p>YouTubeの読み取り権限：{storedYouTubeToken() ? '許可済み' : '同期時に許可'}</p><p>高評価動画：{videoLibrary.videos.length}件</p><p>最終同期：{videoLibrary.lastSync ? new Date(videoLibrary.lastSync).toLocaleString('ja-JP') : '未同期'}</p><button className="primary-btn" disabled={videoLibrary.syncing} onClick={() => void videoLibrary.importLiked()}>今すぐ同期</button><p role="status">{videoLibrary.message}</p><p>AI解析済み：{videoLibrary.videos.filter(v => v.analyzedAt).length} / {videoLibrary.videos.length}</p><button className="secondary-btn" disabled={analysis.pending.size > 0} onClick={() => void analysis.run(videoLibrary.videos)}>未解析をAI解析</button><p role="status">{analysis.message}</p><p>動画のDrive保存：{syncLabel[videoLibrary.sync.status]}</p>{videoLibrary.sync.message && <p role="alert">{videoLibrary.sync.message}</p>}<button className="secondary-btn" onClick={() => void videoLibrary.sync.syncNow()}>動画をDriveと同期</button>{videoLibrary.sync.status === 'needsFolder' && <button className="secondary-btn" onClick={() => void videoLibrary.sync.grantFolder()}>保存先フォルダを許可</button>}<p>Google CloudでYouTube Data API v3を有効にし、OAuth同意画面にYouTubeの読み取り専用権限を追加してください。APIキーだけでは高評価動画を取得できません。</p></div></section></div>}
    {zoomed && <CoverLightbox {...zoomed} onClose={() => setZoomed(null)} />}
    {aiPicksOpen && <AiPicksModal label={contentType === 'all' ? 'AIセレクト' : contentType === 'youtube' ? 'AI選動画' : 'AI選書'} books={displayedItems} indexItems={libraryItems} driveStatus={drive.status} onConnect={() => void drive.connect()} onOpen={openItem} onClose={() => setAiPicksOpen(false)} />}
    {editing && <BookModal indexItems={libraryItems} key={editing.id} book={editing} books={books} summaryJob={summaryJobs.get(editing.id)} summaryIssue={summaryIssues[editing.id]} onCancelSummary={() => cancelSummary(editing.id)} onSummarize={startSummary} onSummaryApplied={() => dropJob(editing.id)} tab={modalTab} onTab={setModalTab} onOpen={openBook} nav={bookNav} onStep={stepBook} keysBlocked={Boolean(zoomed)} monthOptions={monthOptions} onZoom={setZoomed} onClose={() => setEditing(null)} onSave={(book, open) => { try { localStorage.setItem(LAST_CATEGORY, book.categoryId); localStorage.setItem(LAST_BASE_MONTH, book.baseMonth) } catch { /* noop */ } if (findDuplicate(books, book)) return; const prev = books.find(b => b.id === book.id); if (summaryIssues[book.id]?.kind === 'mismatch' && (scanLink(prev?.links ?? []) !== scanLink(book.links) || prev?.title !== book.title)) setIssue(book.id, null); const next = books.some(b => b.id === book.id) ? books.map(b => b.id === book.id ? book : b) : [book, ...books]; saveBooks(next); if (open) openBook(open); else setEditing(null) }} onDelete={id => { if (confirm('この本を削除しますか？')) { saveBooks(books.filter(b => b.id !== id)); setEditing(null) } }} />}
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
  else if (ranked) text = <>意味の近い順に表示しています（タイトル・著者／チャンネルなどが一致した項目は少し上位に）。{progress && ` 意味検索の準備中（${progress.done}/${progress.total}冊）…`}</>
  else if (state.status === 'searching') text = <><LoaderCircle className="spin" /> 意味の近い項目を探しています…</>
  else if (state.status === 'error') { text = `意味検索ができませんでした：${state.message}（キーワードで検索しています）`; error = true }
  else if (progress) text = <><LoaderCircle className="spin" /> 意味検索の準備中：本・動画の内容をベクトル化しています（{progress.done}/{progress.total}冊）。それまではキーワードで検索しています。</>
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

function BookCard({ no, book, score, summary, issue, onCancelSummary, onAutofill, onClick, onZoom }: { no: number; book: Book; score?: SearchScore; summary?: SummaryJob; issue?: SummaryIssue; onCancelSummary: (id: string) => void; onAutofill: (b: Book) => void; onClick: () => void; onZoom: (z: Zoom) => void }) { const { child, parent } = categoryPath(book.categoryId); return <article className="book-card" onClick={onClick} tabIndex={0} onKeyDown={e => e.key === 'Enter' && onClick()}>
  <div className="cover-wrap"><CoverImage src={book.cover} alt={`${book.title}の表紙`} onZoom={onZoom} fallback={<div className="cover-placeholder"><BookOpen /><span>NO COVER</span></div>} /></div>
  <div className="card-body"><div className="category-line">{parent && <><span>{parent.name}</span><ChevronRight /></>}<b>{child?.name}</b></div><h3>{book.title}</h3><div className="author-line"><AuthorName author={book.author} /><span className="book-no">No.{no}</span></div><div className="card-meta"><span className="meta-left">{score && <ScoreBadge score={score} />}<span className={`status mini ${statusClass[book.status]}`}>{book.status}</span>{summary && summary.status !== 'done' ? <SummaryBusy job={summary} onCancel={() => onCancelSummary(book.id)} /> : <>{book.memo.trim() && <CopySummaryButton text={book.memo} />}{issue && (issue.kind === 'mismatch' || !book.memo.trim()) && <SummaryIssueBadge issue={issue} />}{scanLink(book.links) && <button type="button" className="card-autofill" onClick={e => { e.stopPropagation(); onAutofill(book) }} onKeyDown={e => e.stopPropagation()} title="表紙から入力＋要約（表紙からタイトル・著者・分類を入力し、続けて全ページスキャンから要約を作ります）" aria-label="表紙から入力＋要約"><Sparkles /></button>}</>}{book.baseMonth && <span className="card-month">{book.baseMonth}</span>}</span></div><CardLinks links={book.links} /></div>
</article> }

/** 著者名。登録済みは人物アイコン付きで濃く、未登録は薄い点線のラベルにして区別しやすくする */
function AuthorName({ author, small }: { author: string; small?: boolean }) {
  const name = author.trim()
  const Tag = small ? 'small' : 'p'
  return name ? <Tag className="author" title={name}><UserRound /><span>{name}</span></Tag> : <Tag className="author missing">著者未登録</Tag>
}

/** 要約コピーボタン（カードでは要約作成中の表示と同じ位置、詳細画面では「要約」の見出しの横に出す） */
function CopySummaryButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { alert('要約をコピーできませんでした') }
  }
  return <button type="button" className={`copy-summary${className ? ` ${className}` : ''}${copied ? ' copied' : ''}`} onClick={copy} onKeyDown={e => e.stopPropagation()} title={copied ? 'コピーしました' : '要約をコピー'} aria-label="要約をコピー">{copied ? <Check /> : <Copy />}{copied ? 'コピーしました' : '要約コピー'}</button>
}

function BookTable({ books, startNo, scores, onSelect }: { books: Book[]; startNo: number; scores: Map<string, SearchScore> | null; onSelect: (b: Book) => void }) { return <div className="table-wrap panel"><table><thead><tr><th>No.</th><th>本 / 動画</th><th>分類</th><th>基準月</th><th>読書状況</th><th>関連資料</th><th></th></tr></thead><tbody>{books.map((b, i) => { const { child } = categoryPath(b.categoryId); return <tr key={b.id} onClick={() => onSelect(b)}><td className="book-no">{startNo + i}</td><td><div className="table-book"><CoverImage src={b.cover} alt="" fallback={<BookOpen />} /><span><strong>{'type' in b && b.type === 'youtube' ? '▶ ' : '📕 '}{b.title}</strong><AuthorName author={b.author} small /></span></div></td><td>{child?.name}</td><td>{b.baseMonth}</td><td><span className={`status inline ${statusClass[b.status]}`}>{'type' in b && b.type === 'youtube' ? (b.memo ? 'AI解析済み' : 'AI未解析') : b.status}</span>{scores?.get(b.id) && <ScoreBadge score={scores.get(b.id)!} />}</td><td>{b.links.length}件</td><td><ChevronRight /></td></tr> })}</tbody></table></div> }

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

/** 全ページスキャンからの要約の処理（queued: 順番待ち / running: 作成中 / done: できあがったが、まだ詳細画面に反映していない） */
interface SummaryJob { startedAt: number; status: 'queued' | 'running' | 'done'; summary?: string; abort: AbortController; stage?: SummaryStage | 'cover'; stageAt?: number; retries?: number }

/**
 * 要約の段階ごとの表示（typical: ふだんならこの秒数で終わる目安。これを過ぎると表示を目立たせる）。
 * 転送と生成の目安は、固まったとみなして自動でやり直す時間と同じにする
 */
const SUMMARY_STAGES: Record<SummaryStage | 'cover', { step?: number; short: string; label: string; typical: number; note: string }> = {
  cover: { short: '表紙', label: '表紙を読み取り中', typical: 40, note: 'ふだん10〜40秒' },
  upload: { step: 1, short: '転送', label: 'スキャンのファイルをAIへ転送中', typical: STALL_LIMIT.upload / 1000, note: 'ページ数により30秒〜2分半' },
  processing: { step: 2, short: '準備', label: 'AIがファイルを読み込み中', typical: 90, note: 'ふだん〜1分半' },
  summarize: { step: 3, short: '生成', label: '要約を生成中', typical: STALL_LIMIT.summarize / 1000, note: 'ふだん30秒〜2分' },
}
/** 秒数を「1:05」の形にする */
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

/** 要約の状態の説明（カードのツールチップと詳細画面で使う） */
function summaryStatusText(job: SummaryJob, elapsed: number): string {
  if (job.status === 'queued') return 'ほかの本の要約が終わるのを待っています（2冊ずつ順番に作ります）。'
  const info = job.stage && SUMMARY_STAGES[job.stage]
  if (!info) return `要約の準備をしています（経過 ${clock(elapsed)}）。`
  const retry = job.retries ? `。応答が止まっていたため、自動でやり直しています（${job.retries}回目）` : ''
  return `${info.step ? `${info.step}/3 ` : ''}${info.label}（目安：${info.note}）。経過 ${clock(elapsed)}${retry}。全体ではふだん1〜5分ほどで、目安を大きく過ぎたときは自動でやり直します。`
}

/** カードに出す、作成中・順番待ちの要約の表示（いまの段階と経過時間。押すと中止） */
function SummaryBusy({ job, onCancel }: { job: SummaryJob; onCancel: () => void }) {
  const running = job.status === 'running'
  const elapsed = useElapsed(running, job.startedAt)
  const stageElapsed = useElapsed(running && Boolean(job.stageAt), job.stageAt)
  const info = job.stage && SUMMARY_STAGES[job.stage]
  const slow = running && info && stageElapsed > info.typical
  const text = !running ? '要約待ち' : `${info ? info.short : '準備'}${job.retries ? '↻' : ''} ${clock(elapsed)}`
  return <button type="button" className={`summary-busy${running ? '' : ' queued'}${slow ? ' slow' : ''}`} onClick={e => { e.stopPropagation(); onCancel() }} onKeyDown={e => e.stopPropagation()} title={`${summaryStatusText(job, elapsed)}\n（押すと中止）`} aria-label={`要約：${summaryStatusText(job, elapsed)}（押すと中止）`}>{running ? <LoaderCircle className="spin" /> : <Clock />}{text}</button>
}

/** 要約を作れなかった記録（interrupted: 作成中にページを閉じた・再読み込みした） */
interface SummaryIssue { kind: SummaryFailure | 'interrupted' | 'mismatch'; message: string; at: string }
const SUMMARY_ISSUES = 'mybooks-summary-issues'
const SUMMARY_ACTIVE = 'mybooks-summary-active'
function loadSummaryIssues(): Record<string, SummaryIssue> {
  try {
    const issues = JSON.parse(localStorage.getItem(SUMMARY_ISSUES) || '{}') as Record<string, SummaryIssue>
    // 前回、作成中・順番待ちのままページを閉じた要約は「中断」として記録する
    const active = JSON.parse(localStorage.getItem(SUMMARY_ACTIVE) || '[]') as { id: string; startedAt: number }[]
    for (const { id, startedAt } of active) issues[id] = { kind: 'interrupted', message: '要約の作成中にページを閉じた（または再読み込みした）ため、途中で終わりました。', at: new Date(startedAt).toISOString() }
    return issues
  } catch { return {} }
}
const ISSUE_LABEL: Record<SummaryIssue['kind'], string> = { timeout: '要約タイムアウト', failed: '要約失敗', cancelled: '要約中止', interrupted: '要約中断', mismatch: 'Scan要確認' }
const issueTime = (at: string) => new Date(at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 要約を作れなかったことを示すラベル（理由と日時はマウスを乗せると表示） */
function SummaryIssueBadge({ issue }: { issue: SummaryIssue }) {
  const Icon = issue.kind === 'timeout' ? Clock : issue.kind === 'failed' || issue.kind === 'mismatch' ? CircleAlert : CircleStop
  return <span className={`summary-issue ${issue.kind}`} title={`${issueTime(issue.at)} ${issue.message}\n✨ボタンで、もう一度作れます。`}><Icon />{ISSUE_LABEL[issue.kind]}</span>
}

/** 自動で入力した項目の記録（before: 入力前の値 / changed: 値が変わったか / source: 表紙・スキャンのどちらから） */
interface Filled { before: string; changed: boolean; source: 'cover' | 'scan' }

const FILL_LABEL = { title: 'タイトル', author: '著者', categoryId: '分類' } as const
/** 分類の表示名（例: F-1: ビジネススキル・法律） */
const categoryLabel = (id: string) => categories.find(c => c.id === id)?.name ?? id

/** onSave の open: 保存したあとに続けて開く本（類似する本・同じ著者の本から選んだとき） */
/** 詳細画面の前後の本（表示中の一覧での位置） */
type BookNav = { prev?: Book; next?: Book; index: number; total: number }

function BookModal({ indexItems, book, books, summaryJob, summaryIssue, onCancelSummary, onSummarize, onSummaryApplied, tab, onTab, onOpen, nav, onStep, keysBlocked, monthOptions, onClose, onSave, onDelete, onZoom }: { indexItems?: Book[]; book: Book; books: Book[]; summaryJob?: SummaryJob; summaryIssue?: SummaryIssue; onCancelSummary: () => void; onSummarize: (b: Book, scanUrl: string) => void; onSummaryApplied: () => void; tab: ModalTab; onTab: (t: ModalTab) => void; onOpen: (b: Book) => void; nav?: BookNav; onStep: (b: Book) => void; keysBlocked: boolean; monthOptions: string[]; onClose: () => void; onSave: (b: Book, open?: Book) => void; onDelete: (id: string) => void; onZoom: (z: Zoom) => void }) {
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
  const summarizing = summaryJob?.status === 'running' || summaryJob?.status === 'queued'
  const summarizeElapsed = useElapsed(summaryJob?.status === 'running', summaryJob?.startedAt)
  const confirmReplaceMemo = () => !draft.memo.trim() || confirm(REPLACE_MEMO)
  // 全ページスキャンのファイル名を表示する（別の本のファイルになっていないか、目で確かめられるように）
  const [scanFile, setScanFile] = useState<{ url: string; name: string | null }>()
  useEffect(() => {
    if (!scanUrl) return
    let cancelled = false
    const timer = setTimeout(() => void scanFileName(scanUrl).then(name => { if (!cancelled) setScanFile({ url: scanUrl, name }) }), 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [scanUrl])
  const scanName = scanFile && scanFile.url === scanUrl ? scanFile.name : null
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
  // 著者プロフィール（著者ハブ）で開いている著者
  const [hubAuthor, setHubAuthor] = useState<string | null>(null)
  const authors = authorNames(draft.author)
  // 前後の本へ移る（今の本の変更は保存してから。表示中のタブはそのまま）
  const step = async (b?: Book) => {
    if (!b) return
    const current = tab
    await saveAndClose(b)
    if (!closingRef.current) return
    onStep(b); onTab(current)
  }
  // ←→キーでも前後の本へ移る（入力欄で文字を打っているときや、表紙を拡大しているときは除く）
  useEffect(() => {
    if (!nav || keysBlocked || hubAuthor) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      const target = e.key === 'ArrowLeft' ? nav.prev : nav.next
      if (!target) return
      e.preventDefault(); void step(target)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) void saveAndClose() }}><section className="modal" onPaste={onPaste}><div className="modal-head"><div><p className="eyebrow">{isNew ? 'NEW BOOK' : 'BOOK DETAILS'}</p><h2>{isNew ? '本を追加' : '本の詳細・編集'}</h2></div>
    {nav && <div className="modal-nav"><button type="button" onClick={() => void step(nav.prev)} disabled={!nav.prev} title={nav.prev ? `前の本（←）：${nav.prev.title}` : '最初の本です'} aria-label="前の本"><ChevronLeft /></button><span>{nav.index + 1} / {nav.total}</span><button type="button" onClick={() => void step(nav.next)} disabled={!nav.next} title={nav.next ? `次の本（→）：${nav.next.title}` : '最後の本です'} aria-label="次の本"><ChevronRight /></button></div>}
    <div className="modal-tabs" role="tablist">{([['edit', <><BookOpen /> 詳細・編集</>], ['similar', <><Sparkles /> 類似する本</>], ['author', <><UserRound /> 同じ著者の本</>]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => onTab(id)}>{label}</button>)}</div>
    <button className="icon-btn" onClick={() => void saveAndClose()} title="保存して閉じる"><X /></button></div>
    {authors.length > 0 && <div className="author-hub-bar"><span className="author-hub-bar-label"><UserRound /> 著者</span>{authors.map(name => <button key={name} type="button" className="author-hub-btn" onClick={() => setHubAuthor(name)} title={`${name} の著者プロフィール（概要・著書・おすすめ・動画・関連情報）を開きます`}><strong>{name}</strong><span>著者プロフィール</span><ChevronRight /></button>)}</div>}
    {hubAuthor && <AuthorHub name={hubAuthor} books={books} currentId={book.id} onOpen={b => { setHubAuthor(null); openRelated(b) }} onClose={() => setHubAuthor(null)} />}
    {tab === 'similar' && <div className="related-panel"><SimilarBooks indexItems={indexItems} book={book} books={books} onOpen={openRelated} /></div>}
    {tab === 'author' && <div className="related-panel"><SameAuthorBooks book={{ ...book, author: draft.author }} books={books} onOpen={openRelated} /></div>}
    <form onSubmit={submit} hidden={tab !== 'edit'}>
    <div className="form-layout"><div className="cover-editor"><CoverImage src={draft.cover} alt={`${draft.title || '表紙'}のプレビュー`} onZoom={onZoom} fallback={canPasteCover
      ? <button type="button" className="cover-placeholder paste-target" onClick={() => void pasteCover()} disabled={uploading || reading} title="クリップボードの画像を表紙として保存">{uploading || reading ? <><LoaderCircle className="spin" /><span>{reading ? '表紙を読み取り中…' : 'アップロード中…'}</span></> : <><ClipboardPaste /><span>{draft.cover ? '表示できません' : 'クリックして'}<br />クリップボードの<br />画像を貼り付け</span></>}</button>
      : <div className="cover-placeholder"><BookOpen /><span>{draft.cover ? '表示できません' : '表紙プレビュー'}</span></div>} /><div className="cover-fields"><label>表紙（DriveのファイルID）<input value={draft.cover} onChange={e => update('cover', normalizeCover(e.target.value))} placeholder="ファイルID・共有リンク・画像URL" /></label>
      <div className="cover-actions">{canPasteCover && <button type="button" className="secondary-btn" onClick={() => void pasteCover()} disabled={uploading}>{uploading ? <LoaderCircle className="spin" /> : <ClipboardPaste />} {uploading ? 'アップロード中…' : '画像を貼り付け'}</button>}{canPickCover && <button type="button" className="secondary-btn" onClick={pickCover}><FolderOpen /> Driveから選ぶ</button>}<a href={driveFileUrl(draft.cover) ?? COVER_FOLDER_URL} target="_blank" rel="noreferrer"><ExternalLink />{driveFileUrl(draft.cover) ? 'Driveで開く' : '表紙フォルダを開く'}</a></div>
      <small className="cover-hint">{canPasteCover && 'コピーした画像は、表紙フォルダに「タイトル名」のファイルとして保存されます（Ctrl+Vでも可）。'}表紙フォルダの画像はファイルIDで保存します。共有リンクを貼るとIDに変換されます。表示するには、フォルダの共有設定を「リンクを知っている全員」にしてください。</small></div></div>
    <div className="fields"><div className="autofill-bar"><button type="button" className="autofill-btn" onClick={() => void readCover()} disabled={reading} title="表紙の画像の文字を読み取り、タイトル・著者・分類を入力します">{reading ? <LoaderCircle className="spin" /> : <ScanText />}{reading ? `読み取り中…${elapsed ? ` ${elapsed}秒` : ''}` : '表紙から入力'}</button><button type="button" className="autofill-btn" onClick={() => void readCoverAndSummarize()} disabled={reading || summarizing || !scanUrl} title={scanUrl ? '表紙からタイトル・著者・分類を入力し、続けて全ページスキャンから要約を作ります' : '関連リンクの「全ページスキャン」にURLを入れると使えます'}><Sparkles />表紙から入力＋要約</button><span>タイトル・著者・分類を表紙の画像から読み取ります</span>{readNote && <small className="field-note">{readNote}</small>}</div><label>タイトル <em>必須</em>{fillMark('title')}<input className={duplicate ? 'invalid' : fill('title')} required autoFocus={isNew} value={draft.title} onChange={e => update('title', e.target.value)} placeholder="本のタイトル" />{fillBefore('title')}{duplicate && <small className="field-error">{duplicate.reason === 'url' ? '同じURLの関連リンクを持つ本' : '同じ本'}がすでに登録されています（{duplicate.book.title}{duplicate.book.author && ` / ${duplicate.book.author}`}）</small>}</label><label>著者{fillMark('author')}<input className={fill('author')} value={draft.author} onChange={e => update('author', e.target.value)} placeholder="著者名" />{fillBefore('author')}</label><div className="field-row"><label>分類{fillMark('categoryId')}<select className={fill('categoryId')} value={draft.categoryId} onChange={e => update('categoryId', e.target.value)}>{categories.filter(c => c.parent).map(c => { const p = categories.find(p => p.id === c.parent); return <option value={c.id} key={c.id}>{p?.name} ＞ {c.name}</option> })}</select>{fillBefore('categoryId')}</label><label>基準月<input className={monthError ? 'invalid' : undefined} list="base-month-options" inputMode="numeric" autoComplete="off" placeholder="YYYY-MM（空欄可）" value={draft.baseMonth} onChange={e => { update('baseMonth', e.target.value); setMonthError(false) }} onBlur={fixMonth} />{monthError && <small className="field-error">YYYY-MM の形式で入力してください（例：2026-09）</small>}<datalist id="base-month-options">{monthOptions.map(m => <option key={m} value={m} />)}</datalist></label></div><label>読書状況<select value={draft.status} onChange={e => update('status', e.target.value as ReadingStatus)}><option>未読</option><option>読書中</option><option>読了</option></select></label><label>要約{!filled.has('memo') && <button type="button" className="label-action" onClick={summarizing ? onCancelSummary : makeSummary} disabled={!scanUrl && !summarizing} title={summarizing ? '押すと要約の作成を中止します' : scanUrl ? '関連リンクの「全ページスキャン」のファイルを読み、要約を作ります' : '関連リンクの「全ページスキャン」にURLを入れると使えます'}>{summarizing ? <LoaderCircle className="spin" /> : <Sparkles />}{summaryJob?.status === 'queued' ? '要約待ち…（押すと中止）' : summarizing ? `要約を作成中…${summaryJob?.stage ? ` ${SUMMARY_STAGES[summaryJob.stage].step ? `${SUMMARY_STAGES[summaryJob.stage].step}/3 ` : ''}${SUMMARY_STAGES[summaryJob.stage].short}` : ''} ${clock(summarizeElapsed)}（押すと中止）` : '全ページスキャンから要約'}</button>}{fillMark('memo')}<textarea className={fill('memo')} rows={filled.has('memo') ? 8 : 4} value={draft.memo} onChange={e => update('memo', e.target.value)} placeholder={summarizing ? '全ページスキャンから要約を作成しています…' : '本の要約'} disabled={summarizing} />{summarizing ? <small className="field-note">{summaryJob ? summaryStatusText(summaryJob, summarizeElapsed) : ''}この画面を閉じても処理は続き、終わると自動で保存されます。</small> : summaryIssue && <small className={`field-note summary-issue-note ${summaryIssue.kind}`}>前回（{issueTime(summaryIssue.at)}）：{ISSUE_LABEL[summaryIssue.kind]}／{summaryIssue.message}</small>}{fillBefore('memo')}{!summarizing && draft.memo.trim() && <CopySummaryButton text={draft.memo} className="in-label" />}</label></div></div>
    <div className="links-section"><div className="section-title"><div><h3>関連リンク</h3><p>上の6つは固定の欄です。追加したリンクは左端の <GripVertical className="inline-icon" /> をドラッグして並べ替えられます。入力済みのURLは、左の鉛筆ボタンを押すと変更できます。URLが空の欄は保存されません。</p>{duplicate?.reason === 'url' && <p className="field-error">同じURLのリンクが「{duplicate.book.title}」に登録されています</p>}</div><button type="button" className="secondary-btn" onClick={addLink}><Plus /> リンクを追加</button></div><LinkEditor links={draft.links} onChange={links => update('links', links)} />{scanUrl && scanName && <p className="scan-file"><ScanLine />全ページスキャンのファイル名：{scanName}</p>}</div>
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
function DriveAlert({ drive, onDetails }: { drive: ReturnType<typeof useDriveSync<Book>>; onDetails: () => void }) {
  const info = drive.status === 'signedOut' ? { title: 'Google Driveに接続されていません', text: '変更はこのブラウザにだけ保存され、Driveには保存されません。別の端末とも同期されません。', label: 'Googleでログインして接続', action: drive.connect }
    : drive.status === 'needsFolder' ? { title: 'Google Driveの保存先フォルダが許可されていません', text: '許可するまで、変更はDriveに保存されません。', label: 'MyBooksフォルダを許可', action: drive.grantFolder }
    : drive.status === 'error' ? { title: 'Google Driveとの同期に失敗しました', text: `${drive.message ? `${drive.message}。` : ''}変更はまだDriveに保存されていません。`, label: '再試行', action: drive.syncNow }
    : null
  if (!info) return null
  return <section className={`drive-alert sync-${drive.status}`} role="alert"><CloudAlert /><div><strong>{info.title}</strong><p>{info.text}</p></div><div className="drive-alert-actions"><button className="ghost-btn" onClick={onDetails}>詳細</button><button className="primary-btn" onClick={() => void info.action()}>{info.label}</button></div></section>
}

function DriveSection({ drive }: { drive: ReturnType<typeof useDriveSync<Book>> }) {
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

function BackupModal({ drive, onClose, onExport, onImport }: { drive: ReturnType<typeof useDriveSync<Book>>; onClose: () => void; onExport: () => void; onImport: () => void }) { return <div className="modal-backdrop"><section className="modal small"><div className="modal-head"><div><p className="eyebrow">DATA MANAGEMENT</p><h2>保存・バックアップ</h2></div><button className="icon-btn" onClick={onClose}><X /></button></div><DriveSection drive={drive} /><div className="backup-cards"><button onClick={onExport}><Download /><span><strong>バックアップを書き出す</strong><small>全データをJSON形式で保存</small></span></button><button onClick={onImport}><Upload /><span><strong>データを読み込む</strong><small>JSONバックアップまたはCSV</small></span></button></div><p className="hint">読み込み時、JSONは現在のデータを置き換え、CSVは現在の本棚に追加されます。Google Driveに接続中は、読み込んだ内容もDriveに保存されます。</p></section></div> }

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
