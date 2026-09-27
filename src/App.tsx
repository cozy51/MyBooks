import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, ChevronRight, ClipboardPaste, Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload, Download, ExternalLink, FolderOpen, GripVertical, Grid2X2, List, LoaderCircle, LogOut, RefreshCw, Plus, Search, Settings, Trash2, Upload, X } from 'lucide-react'
import { COVER_FOLDER_ID, COVER_FOLDER_URL, coverSources, driveFileUrl, normalizeCover } from './cover'
import { categories, sampleBooks } from './data'
import { DATA_FOLDER_URL, DRIVE_API_KEY, DRIVE_CLIENT_ID, DRIVE_FILE_NAME, pickImage, readClipboardImage, uploadCoverImage } from './drive'
import { useDriveSync, type SyncStatus } from './useDriveSync'
import { CardLinks, LinkEditor } from './LinkEditor'
import { cleanLinks, newLink, withPresetRows } from './links'
import type { Book, BookLink, ReadingStatus } from './types'

const STORE = 'mybooks-library-v1'
const statusClass: Record<ReadingStatus, string> = { '未読': 'unread', '読書中': 'reading', '読了': 'done' }
const LAST_CATEGORY = 'mybooks-last-category'
/** 前回保存した本の分類（新しい本の初期値に使う） */
function lastCategory() {
  try { const id = localStorage.getItem(LAST_CATEGORY); if (id && categories.some(c => c.id === id && c.parent)) return id } catch { /* noop */ }
  return 'd1'
}
const LAST_BASE_MONTH = 'mybooks-last-base-month'
/** 前回保存した本の基準月（新しい本の初期値に使う。空欄で保存していれば空欄、未保存なら今月） */
function lastBaseMonth() {
  try { const month = localStorage.getItem(LAST_BASE_MONTH); if (month === '' || (month && /^\d{4}-\d{2}$/.test(month))) return month } catch { /* noop */ }
  return new Date().toISOString().slice(0, 7)
}
const emptyBook = (): Book => ({ id: crypto.randomUUID(), title: '', author: '', categoryId: lastCategory(), cover: '', baseMonth: lastBaseMonth(), status: '未読', memo: '', links: [], updatedAt: new Date().toISOString() })

// 表紙はDriveのファイルIDで保持する（以前の共有リンク形式もIDにそろえる）
const withCoverIds = (books: Book[]) => books.map(b => ({ ...b, cover: normalizeCover(b.cover || '') }))

function loadBooks(): Book[] {
  try { const value = localStorage.getItem(STORE); return value ? withCoverIds(JSON.parse(value)) : sampleBooks } catch { return sampleBooks }
}

function App() {
  const [books, setBooks] = useState<Book[]>(loadBooks)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState('all')
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [editing, setEditing] = useState<Book | null>(null)
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null)
  const [backupOpen, setBackupOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const storeBooks = useCallback((books: Book[]) => { const next = withCoverIds(books); setBooks(next); localStorage.setItem(STORE, JSON.stringify(next)) }, [])
  const drive = useDriveSync(STORE, books, storeBooks)
  const saveBooks = (next: Book[]) => { storeBooks(next); drive.markDirty() }
  const filtered = useMemo(() => books.filter(book => {
    const cat = categories.find(c => c.id === book.categoryId)
    const parent = categories.find(c => c.id === cat?.parent)
    const haystack = `${book.title} ${book.author} ${book.memo} ${cat?.name} ${parent?.name}`.toLowerCase()
    const categoryMatch = category === 'all' || book.categoryId === category || cat?.parent === category
    return haystack.includes(query.toLowerCase()) && categoryMatch && (status === 'all' || book.status === status)
  }), [books, query, category, status])

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
            return { ...emptyBook(), title: get('タイトル'), author: get('著者'), categoryId: cat?.id || 'd1', baseMonth: get('基準月'), status: (['未読', '読書中', '読了'].includes(get('読書状況')) ? get('読書状況') : '未読') as ReadingStatus, memo: get('メモ'), cover: get('表紙画像URL'), links: parseCsvLinks(get('関連リンク')) } })
          saveBooks([...books, ...next]); setBackupOpen(false)
        }
      } catch { alert('ファイルを読み込めませんでした。形式をご確認ください。') }
    }; reader.readAsText(file)
  }

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => { setQuery(''); setCategory('all'); setStatus('all') }}><img className="brandmark" src="/favicon.svg" alt="" /><span>MyBooks<small>わたしの本棚</small></span></button>
      <div className="header-actions"><button className={`ghost-btn backup-label sync-${drive.status}`} onClick={() => setBackupOpen(true)} title={syncLabel[drive.status]}><SyncIcon status={drive.status} /><span>{syncLabel[drive.status]}</span></button><button className="primary-btn" onClick={() => setEditing(emptyBook())}><Plus /> 本を追加</button><button className="avatar" aria-label="設定"><Settings /></button></div>
    </header>

    <main>
      <section className="welcome"><div><p className="eyebrow">MY PERSONAL LIBRARY</p><h1>本棚を、もっと身近に。</h1><p>{books.length}冊の本と、学びの記録をひとつの場所で管理しています。</p></div><div className="stat"><span>読書中</span><strong>{books.filter(b => b.status === '読書中').length}</strong><BookOpen /></div></section>

      <section className="toolbar panel">
        <label className="search"><Search /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="タイトル、著者、分類、メモから検索" />{query && <button onClick={() => setQuery('')}><X /></button>}</label>
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="分類で絞り込み"><option value="all">すべての分類</option>{categories.map(c => <option key={c.id} value={c.id}>{c.parent ? '　└ ' : ''}{c.name}</option>)}</select>
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label="読書状況で絞り込み"><option value="all">すべての読書状況</option><option>未読</option><option>読書中</option><option>読了</option></select>
      </section>

      <div className="content-heading"><div><h2>すべての本</h2><span>{filtered.length}冊を表示</span></div><div className="view-switch"><button className={view === 'cards' ? 'active' : ''} onClick={() => setView('cards')}><Grid2X2 /> カード</button><button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}><List /> リスト</button></div></div>

      {filtered.length === 0 ? <Empty onAdd={() => setEditing(emptyBook())} hasBooks={books.length > 0} /> : view === 'cards' ?
        <div className="book-grid">{filtered.map(book => <BookCard key={book.id} book={book} onClick={() => setEditing(book)} onZoom={setZoomed} />)}</div> :
        <BookTable books={filtered} onSelect={setEditing} />}
    </main>
    <footer><span><img src="/favicon.svg" alt="" /> MyBooks</span><p>あなたの学びを、いつでもそばに。</p></footer>
    {zoomed && <CoverLightbox {...zoomed} onClose={() => setZoomed(null)} />}
    {editing && <BookModal book={editing} onZoom={setZoomed} onClose={() => setEditing(null)} onSave={book => { try { localStorage.setItem(LAST_CATEGORY, book.categoryId); localStorage.setItem(LAST_BASE_MONTH, book.baseMonth) } catch { /* noop */ } const next = books.some(b => b.id === book.id) ? books.map(b => b.id === book.id ? book : b) : [book, ...books]; saveBooks(next); setEditing(null) }} onDelete={id => { if (confirm('この本を削除しますか？')) { saveBooks(books.filter(b => b.id !== id)); setEditing(null) } }} />}
    {backupOpen && <BackupModal drive={drive} onClose={() => setBackupOpen(false)} onExport={exportJson} onImport={() => fileRef.current?.click()} />}
    <input ref={fileRef} hidden type="file" accept=".json,.csv" onChange={e => importFile(e.target.files?.[0])} />
  </div>
}

type Zoom = { src: string; alt: string }

function CoverImage({ src, alt, fallback, width, onZoom }: { src: string; alt: string; fallback: ReactNode; width?: number; onZoom?: (z: Zoom) => void }) {
  const sources = useMemo(() => coverSources(src, width), [src, width])
  const [failed, setFailed] = useState({ src, count: 0 })
  const count = failed.src === src ? failed.count : 0
  if (count >= sources.length) return <>{fallback}</>
  const zoom = onZoom && ((e: React.SyntheticEvent) => { e.stopPropagation(); onZoom({ src, alt }) })
  return <img src={sources[count]} alt={alt} referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed({ src, count: count + 1 })}
    className={zoom ? 'zoomable' : undefined} title={zoom ? 'クリックで拡大' : undefined} onClick={zoom} />
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
function BookCard({ book, onClick, onZoom }: { book: Book; onClick: () => void; onZoom: (z: Zoom) => void }) { const { child, parent } = categoryPath(book.categoryId); return <article className="book-card" onClick={onClick} tabIndex={0} onKeyDown={e => e.key === 'Enter' && onClick()}>
  <div className="cover-wrap"><CoverImage src={book.cover} alt={`${book.title}の表紙`} onZoom={onZoom} fallback={<div className="cover-placeholder"><BookOpen /><span>NO COVER</span></div>} /><span className={`status ${statusClass[book.status]}`}>{book.status}</span></div>
  <div className="card-body"><div className="category-line">{parent && <><span>{parent.name}</span><ChevronRight /></>}<b>{child?.name}</b></div><h3>{book.title}</h3><p className="author">{book.author || '著者未登録'}</p><div className="card-meta"><span>{book.baseMonth?.replace('-', '年')}月</span><span>{book.links.length ? `${book.links.length}件の資料` : '資料なし'}</span></div><CardLinks links={book.links} /></div>
</article> }

function BookTable({ books, onSelect }: { books: Book[]; onSelect: (b: Book) => void }) { return <div className="table-wrap panel"><table><thead><tr><th>本</th><th>分類</th><th>基準月</th><th>読書状況</th><th>関連資料</th><th></th></tr></thead><tbody>{books.map(b => { const { child } = categoryPath(b.categoryId); return <tr key={b.id} onClick={() => onSelect(b)}><td><div className="table-book"><CoverImage src={b.cover} alt="" fallback={<BookOpen />} /><span><strong>{b.title}</strong><small>{b.author || '著者未登録'}</small></span></div></td><td>{child?.name}</td><td>{b.baseMonth}</td><td><span className={`status inline ${statusClass[b.status]}`}>{b.status}</span></td><td>{b.links.length}件</td><td><ChevronRight /></td></tr> })}</tbody></table></div> }

function Empty({ onAdd, hasBooks }: { onAdd: () => void; hasBooks: boolean }) { return <div className="empty panel"><div><BookOpen /></div><h2>{hasBooks ? '条件に合う本がありません' : '最初の一冊を登録しましょう'}</h2><p>{hasBooks ? '検索条件や絞り込みを変えてみてください。' : '表紙や読書メモ、関連資料をまとめて管理できます。'}</p>{!hasBooks && <button className="primary-btn" onClick={onAdd}><Plus /> 本を追加する</button>}</div> }

const canPickCover = Boolean(DRIVE_CLIENT_ID && DRIVE_API_KEY)
const canPasteCover = Boolean(DRIVE_CLIENT_ID)

function BookModal({ book, onClose, onSave, onDelete, onZoom }: { book: Book; onClose: () => void; onSave: (b: Book) => void; onDelete: (id: string) => void; onZoom: (z: Zoom) => void }) {
  const isNew = !book.title
  const [draft, setDraft] = useState<Book>({ ...book, links: withPresetRows(book.links) })
  const update = <K extends keyof Book>(key: K, value: Book[K]) => setDraft(d => ({ ...d, [key]: value }))
  const addLink = () => update('links', [...draft.links, newLink()])
  const pickCover = async () => {
    try { const id = await pickImage(COVER_FOLDER_ID); if (id) update('cover', id) } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }
  const [uploading, setUploading] = useState(false)
  const uploadRef = useRef<Promise<string | null> | null>(null)
  const closingRef = useRef(false)
  // クリップボードの画像を表紙フォルダに「タイトル.拡張子」で保存し、そのファイルIDを表紙にする
  const pasteCover = async (image?: Blob) => {
    if (uploading) return
    const title = draft.title.trim()
    if (!title) return alert('先にタイトルを入力してください（表紙画像のファイル名に使います）')
    try {
      image ??= await readClipboardImage() ?? undefined
      if (!image) return alert('クリップボードに画像がありません。表紙の画像をコピーしてから押してください')
      setUploading(true)
      uploadRef.current = uploadCoverImage(image, title, COVER_FOLDER_ID)
      const id = await uploadRef.current
      if (id) update('cover', id)
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) } finally { uploadRef.current = null; setUploading(false) }
  }
  const onPaste = (e: React.ClipboardEvent) => {
    const image = canPasteCover ? Array.from(e.clipboardData.files).find(f => f.type.startsWith('image/')) : undefined
    if (image) { e.preventDefault(); void pasteCover(image) }
  }
  const finalize = (b: Book): Book => ({ ...b, title: b.title.trim(), links: cleanLinks(b.links), updatedAt: new Date().toISOString() })
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!draft.title.trim()) return; onSave(finalize(draft)) }
  // 外側のクリックや×で閉じるときは、今の内容を保存してから閉じる（表紙のアップロード中なら完了を待つ）
  const saveAndClose = async () => {
    if (closingRef.current) return
    closingRef.current = true
    let current = draft
    if (uploadRef.current) { const id = await uploadRef.current.catch(() => null); if (id) current = { ...current, cover: id } }
    const same = (a: Book, b: Book) => JSON.stringify({ ...finalize(a), updatedAt: '' }) === JSON.stringify({ ...finalize(b), updatedAt: '' })
    if (!current.title.trim() || same(current, book)) onClose()
    else onSave(finalize(current))
  }
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) void saveAndClose() }}><section className="modal" onPaste={onPaste}><div className="modal-head"><div><p className="eyebrow">{isNew ? 'NEW BOOK' : 'BOOK DETAILS'}</p><h2>{isNew ? '本を追加' : '本の詳細・編集'}</h2></div><button className="icon-btn" onClick={() => void saveAndClose()} title="保存して閉じる"><X /></button></div><form onSubmit={submit}>
    <div className="form-layout"><div className="cover-editor"><CoverImage src={draft.cover} alt={`${draft.title || '表紙'}のプレビュー`} onZoom={onZoom} fallback={canPasteCover
      ? <button type="button" className="cover-placeholder paste-target" onClick={() => void pasteCover()} disabled={uploading} title="クリップボードの画像を表紙として保存">{uploading ? <><LoaderCircle className="spin" /><span>アップロード中…</span></> : <><ClipboardPaste /><span>{draft.cover ? '表示できません' : 'クリックして'}<br />クリップボードの<br />画像を貼り付け</span></>}</button>
      : <div className="cover-placeholder"><BookOpen /><span>{draft.cover ? '表示できません' : '表紙プレビュー'}</span></div>} /><div className="cover-fields"><label>表紙（DriveのファイルID）<input value={draft.cover} onChange={e => update('cover', normalizeCover(e.target.value))} placeholder="ファイルID・共有リンク・画像URL" /></label>
      <div className="cover-actions">{canPasteCover && <button type="button" className="secondary-btn" onClick={() => void pasteCover()} disabled={uploading}>{uploading ? <LoaderCircle className="spin" /> : <ClipboardPaste />} {uploading ? 'アップロード中…' : '画像を貼り付け'}</button>}{canPickCover && <button type="button" className="secondary-btn" onClick={pickCover}><FolderOpen /> Driveから選ぶ</button>}<a href={driveFileUrl(draft.cover) ?? COVER_FOLDER_URL} target="_blank" rel="noreferrer"><ExternalLink />{driveFileUrl(draft.cover) ? 'Driveで開く' : '表紙フォルダを開く'}</a></div>
      <small className="cover-hint">{canPasteCover && 'コピーした画像は、表紙フォルダに「タイトル名」のファイルとして保存されます（Ctrl+Vでも可）。'}表紙フォルダの画像はファイルIDで保存します。共有リンクを貼るとIDに変換されます。表示するには、フォルダの共有設定を「リンクを知っている全員」にしてください。</small></div></div>
    <div className="fields"><label>タイトル <em>必須</em><input required autoFocus={isNew} value={draft.title} onChange={e => update('title', e.target.value)} placeholder="本のタイトル" /></label><label>著者<input value={draft.author} onChange={e => update('author', e.target.value)} placeholder="著者名" /></label><div className="field-row"><label>分類<select value={draft.categoryId} onChange={e => update('categoryId', e.target.value)}>{categories.filter(c => c.parent).map(c => { const p = categories.find(p => p.id === c.parent); return <option value={c.id} key={c.id}>{p?.name} ＞ {c.name}</option> })}</select></label><label>基準月<input type="month" value={draft.baseMonth} onChange={e => update('baseMonth', e.target.value)} /></label></div><label>読書状況<select value={draft.status} onChange={e => update('status', e.target.value as ReadingStatus)}><option>未読</option><option>読書中</option><option>読了</option></select></label><label>メモ<textarea rows={4} value={draft.memo} onChange={e => update('memo', e.target.value)} placeholder="感想、読みたい章、キーワードなど" /></label></div></div>
    <div className="links-section"><div className="section-title"><div><h3>関連リンク</h3><p>表示名は候補から選ぶか入力します。左端の <GripVertical className="inline-icon" /> をドラッグして並べ替えられます。URLが空の欄は保存されません。</p></div><button type="button" className="secondary-btn" onClick={addLink}><Plus /> リンクを追加</button></div><LinkEditor links={draft.links} onChange={links => update('links', links)} /></div>
    <div className="modal-actions">{!isNew && <button type="button" className="danger-btn" onClick={() => onDelete(draft.id)}><Trash2 /> 削除</button>}<span /><button type="button" className="ghost-btn" onClick={onClose}>キャンセル</button><button className="primary-btn">{isNew ? '本を登録する' : '変更を保存'}</button></div>
  </form></section></div>
}

const syncLabel: Record<SyncStatus, string> = { unavailable: '保存・バックアップ', signedOut: 'Driveに接続', needsFolder: 'フォルダの許可が必要', syncing: '同期中…', synced: 'Drive保存済み', pending: '保存待ち', error: '同期エラー' }
function SyncIcon({ status }: { status: SyncStatus }) {
  if (status === 'syncing') return <LoaderCircle className="spin" />
  if (status === 'synced') return <CloudCheck />
  if (status === 'pending') return <CloudUpload />
  if (status === 'error' || status === 'needsFolder') return <CloudAlert />
  if (status === 'signedOut') return <CloudOff />
  return <Cloud />
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

export default App
