import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, ChevronRight, Cloud, Download, ExternalLink, FileText, Grid2X2, List, NotebookPen, Plus, Search, Settings, Trash2, Upload, X } from 'lucide-react'
import { coverSources } from './cover'
import { categories, sampleBooks } from './data'
import type { Book, BookLink, LinkType, ReadingStatus } from './types'

const STORE = 'mybooks-library-v1'
const statusClass: Record<ReadingStatus, string> = { '未読': 'unread', '読書中': 'reading', '読了': 'done' }
const emptyBook = (): Book => ({ id: crypto.randomUUID(), title: '', author: '', categoryId: 'd1', cover: '', baseMonth: new Date().toISOString().slice(0, 7), status: '未読', memo: '', links: [], updatedAt: new Date().toISOString() })

function loadBooks(): Book[] {
  try { const value = localStorage.getItem(STORE); return value ? JSON.parse(value) : sampleBooks } catch { return sampleBooks }
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

  const saveBooks = (next: Book[]) => { setBooks(next); localStorage.setItem(STORE, JSON.stringify(next)) }
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
      <div className="header-actions"><button className="ghost-btn backup-label" onClick={() => setBackupOpen(true)}><Cloud /> 保存・バックアップ</button><button className="primary-btn" onClick={() => setEditing(emptyBook())}><Plus /> 本を追加</button><button className="avatar" aria-label="設定"><Settings /></button></div>
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
    {editing && <BookModal book={editing} onZoom={setZoomed} onClose={() => setEditing(null)} onSave={book => { const next = books.some(b => b.id === book.id) ? books.map(b => b.id === book.id ? book : b) : [book, ...books]; saveBooks(next); setEditing(null) }} onDelete={id => { if (confirm('この本を削除しますか？')) { saveBooks(books.filter(b => b.id !== id)); setEditing(null) } }} />}
    {backupOpen && <BackupModal onClose={() => setBackupOpen(false)} onExport={exportJson} onImport={() => fileRef.current?.click()} />}
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
  <div className="card-body"><div className="category-line">{parent && <><span>{parent.name}</span><ChevronRight /></>}<b>{child?.name}</b></div><h3>{book.title}</h3><p className="author">{book.author || '著者未登録'}</p><div className="card-meta"><span>{book.baseMonth?.replace('-', '年')}月</span><span>{book.links.length ? `${book.links.length}件の資料` : '資料なし'}</span></div>{book.links.length > 0 && <div className="link-chips">{book.links.slice(0, 2).map(l => <span key={l.id}>{l.type === 'PDF' ? <FileText /> : <NotebookPen />}{l.label}</span>)}</div>}</div>
</article> }

function BookTable({ books, onSelect }: { books: Book[]; onSelect: (b: Book) => void }) { return <div className="table-wrap panel"><table><thead><tr><th>本</th><th>分類</th><th>基準月</th><th>読書状況</th><th>関連資料</th><th></th></tr></thead><tbody>{books.map(b => { const { child } = categoryPath(b.categoryId); return <tr key={b.id} onClick={() => onSelect(b)}><td><div className="table-book"><CoverImage src={b.cover} alt="" fallback={<BookOpen />} /><span><strong>{b.title}</strong><small>{b.author || '著者未登録'}</small></span></div></td><td>{child?.name}</td><td>{b.baseMonth}</td><td><span className={`status inline ${statusClass[b.status]}`}>{b.status}</span></td><td>{b.links.length}件</td><td><ChevronRight /></td></tr> })}</tbody></table></div> }

function Empty({ onAdd, hasBooks }: { onAdd: () => void; hasBooks: boolean }) { return <div className="empty panel"><div><BookOpen /></div><h2>{hasBooks ? '条件に合う本がありません' : '最初の一冊を登録しましょう'}</h2><p>{hasBooks ? '検索条件や絞り込みを変えてみてください。' : '表紙や読書メモ、関連資料をまとめて管理できます。'}</p>{!hasBooks && <button className="primary-btn" onClick={onAdd}><Plus /> 本を追加する</button>}</div> }

function BookModal({ book, onClose, onSave, onDelete, onZoom }: { book: Book; onClose: () => void; onSave: (b: Book) => void; onDelete: (id: string) => void; onZoom: (z: Zoom) => void }) {
  const isNew = !book.title
  const [draft, setDraft] = useState<Book>({ ...book, links: book.links.map(l => ({ ...l })) })
  const update = <K extends keyof Book>(key: K, value: Book[K]) => setDraft(d => ({ ...d, [key]: value }))
  const addLink = () => update('links', [...draft.links, { id: crypto.randomUUID(), type: 'PDF', label: '', url: '' }])
  const updateLink = (id: string, patch: Partial<BookLink>) => update('links', draft.links.map(l => l.id === id ? { ...l, ...patch } : l))
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (!draft.title.trim()) return; onSave({ ...draft, title: draft.title.trim(), updatedAt: new Date().toISOString() }) }
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="modal"><div className="modal-head"><div><p className="eyebrow">{isNew ? 'NEW BOOK' : 'BOOK DETAILS'}</p><h2>{isNew ? '本を追加' : '本の詳細・編集'}</h2></div><button className="icon-btn" onClick={onClose}><X /></button></div><form onSubmit={submit}>
    <div className="form-layout"><div className="cover-editor"><CoverImage src={draft.cover} alt={`${draft.title || '表紙'}のプレビュー`} onZoom={onZoom} fallback={<div className="cover-placeholder"><BookOpen /><span>{draft.cover ? '表示できません' : '表紙プレビュー'}</span></div>} /><label>表紙画像URL<input value={draft.cover} onChange={e => update('cover', e.target.value)} placeholder="画像URL または Google Driveの共有リンク" />{draft.cover && <small className="cover-hint">Google Driveの画像は共有設定を「リンクを知っている全員」にしてください。</small>}</label></div>
    <div className="fields"><label>タイトル <em>必須</em><input required value={draft.title} onChange={e => update('title', e.target.value)} placeholder="本のタイトル" /></label><label>著者<input value={draft.author} onChange={e => update('author', e.target.value)} placeholder="著者名" /></label><div className="field-row"><label>分類<select value={draft.categoryId} onChange={e => update('categoryId', e.target.value)}>{categories.filter(c => c.parent).map(c => { const p = categories.find(p => p.id === c.parent); return <option value={c.id} key={c.id}>{p?.name} ＞ {c.name}</option> })}</select></label><label>基準月<input type="month" value={draft.baseMonth} onChange={e => update('baseMonth', e.target.value)} /></label></div><label>読書状況<select value={draft.status} onChange={e => update('status', e.target.value as ReadingStatus)}><option>未読</option><option>読書中</option><option>読了</option></select></label><label>メモ<textarea rows={4} value={draft.memo} onChange={e => update('memo', e.target.value)} placeholder="感想、読みたい章、キーワードなど" /></label></div></div>
    <div className="links-section"><div className="section-title"><div><h3>関連リンク</h3><p>PDFやNotebookLMのノートをまとめておけます。</p></div><button type="button" className="secondary-btn" onClick={addLink}><Plus /> リンクを追加</button></div>{draft.links.length === 0 ? <p className="links-empty">関連リンクはまだありません。</p> : draft.links.map(link => <div className="link-editor" key={link.id}><select value={link.type} onChange={e => updateLink(link.id, { type: e.target.value as LinkType })}><option>PDF</option><option>NotebookLM</option><option>その他</option></select><input value={link.label} onChange={e => updateLink(link.id, { label: e.target.value })} placeholder="表示名" /><input type="url" value={link.url} onChange={e => updateLink(link.id, { url: e.target.value })} placeholder="https://..." />{link.url && <a href={link.url} target="_blank" rel="noreferrer" aria-label="新しいタブで開く"><ExternalLink /></a>}<button type="button" onClick={() => update('links', draft.links.filter(l => l.id !== link.id))} aria-label="リンクを削除"><Trash2 /></button></div>)}</div>
    <div className="modal-actions">{!isNew && <button type="button" className="danger-btn" onClick={() => onDelete(draft.id)}><Trash2 /> 削除</button>}<span /><button type="button" className="ghost-btn" onClick={onClose}>キャンセル</button><button className="primary-btn">{isNew ? '本を登録する' : '変更を保存'}</button></div>
  </form></section></div>
}

function BackupModal({ onClose, onExport, onImport }: { onClose: () => void; onExport: () => void; onImport: () => void }) { return <div className="modal-backdrop"><section className="modal small"><div className="modal-head"><div><p className="eyebrow">DATA MANAGEMENT</p><h2>保存・バックアップ</h2></div><button className="icon-btn" onClick={onClose}><X /></button></div><div className="backup-info"><Cloud /><div><strong>データはこのブラウザに自動保存されています</strong><p>定期的にJSONをダウンロードし、Google Driveの所定フォルダへ保存してください。</p></div></div><div className="backup-cards"><button onClick={onExport}><Download /><span><strong>バックアップを書き出す</strong><small>全データをJSON形式で保存</small></span></button><button onClick={onImport}><Upload /><span><strong>データを読み込む</strong><small>JSONバックアップまたはCSV</small></span></button></div><p className="hint">読み込み時、JSONは現在のデータを置き換え、CSVは現在の本棚に追加されます。</p></section></div> }

function splitCsv(line: string) { const values: string[] = []; let value = '', quoted = false; for (let i = 0; i < line.length; i++) { const char = line[i]; if (char === '"' && line[i + 1] === '"') { value += '"'; i++ } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { values.push(value); value = '' } else value += char } values.push(value); return values }
function parseCsvLinks(value: string): BookLink[] { return value.split('|').map(v => v.trim()).filter(Boolean).map((entry, i) => { const [type = 'その他', label = '', url = ''] = entry.split('::'); return { id: `${crypto.randomUUID()}-${i}`, type: (['PDF', 'NotebookLM', 'その他'].includes(type) ? type : 'その他') as LinkType, label, url } }) }

export default App
