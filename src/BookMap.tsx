import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronRight, Cloud, LoaderCircle, Maximize2, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react'
import { CoverImage } from './CoverImage'
import { categories, statusClass } from './data'
import { embedText, recheckRemote, updateBookMap, type MapCache, type MapProgress } from './bookMapData'
import type { SyncStatus } from './useDriveSync'
import type { Book } from './types'

/** 親分類（A〜G）ごとの色。座標は内容の近さ、色は既存の分類を表す */
const PARENT_COLORS: Record<string, string> = { a: '#2a78d6', b: '#eb6834', c: '#1baf7a', d: '#eda100', e: '#e87ba4', f: '#008300', g: '#4a3aa7' }
const OTHER_COLOR = '#8a8494'
const DIM_COLOR = '#d9d4e0'
const parents = categories.filter(c => !c.parent)
const parentOf = (categoryId: string) => { const c = categories.find(c => c.id === categoryId); return c?.parent ?? c?.id ?? '' }
const MIN_ZOOM = 0.5, MAX_ZOOM = 80

interface Point { book: Book; x: number; y: number; color: string; active: boolean }
interface View { k: number; tx: number; ty: number }

export default function BookMap({ books, visibleIds, category, onCategory, onSelect, driveStatus, onConnect }: {
  books: Book[]
  /** 検索・絞り込みに合う本（それ以外は薄く表示する） */
  visibleIds: Set<string>
  category: string
  onCategory: (id: string) => void
  onSelect: (book: Book) => void
  driveStatus: SyncStatus
  onConnect: () => void
}) {
  const { cache, progress, error, driveError, relayout } = useBookMapData(books, driveStatus)

  const points = useMemo<Point[]>(() => {
    if (!cache) return []
    const list: Point[] = []
    for (const book of books) {
      const p = cache.layout[book.id]
      if (!p || !embedText(book)) continue
      list.push({ book, x: p[0], y: p[1], color: PARENT_COLORS[parentOf(book.categoryId)] ?? OTHER_COLOR, active: visibleIds.has(book.id) })
    }
    // 薄い点を先に描き、絞り込みに合う点を上に重ねる
    return list.sort((a, b) => Number(a.active) - Number(b.active))
  }, [books, cache, visibleIds])
  const untitled = books.filter(b => !embedText(b)).length
  const pending = books.length - untitled - points.length
  const activeCount = points.filter(p => p.active).length
  const counts = useMemo(() => { const m = new Map<string, number>(); for (const p of points) { const id = parentOf(p.book.categoryId); m.set(id, (m.get(id) ?? 0) + 1) } return m }, [points])
  const selectedParent = category === 'all' ? '' : parentOf(category)
  const busy = progress.phase !== 'ready'

  return <section className="book-map panel">
    <div className="map-bar">
      <div className="map-legend" aria-label="分類の色（押すとその分類で絞り込み）">
        {parents.map(p => <button key={p.id} className={selectedParent === p.id ? 'active' : selectedParent ? 'muted' : ''} onClick={() => onCategory(category === p.id ? 'all' : p.id)} title={`${p.name}で絞り込む`}>
          <i style={{ background: PARENT_COLORS[p.id] }} />{p.name.replace(/^[A-G]\.\s*/, '')}<small>{counts.get(p.id) ?? 0}</small>
        </button>)}
      </div>
      <button className="secondary-btn map-relayout" disabled={busy || points.length === 0} onClick={relayout} title="すべての本の配置をUMAPで計算し直します"><RefreshCw /> 配置を再計算</button>
    </div>
    <MapCanvas points={points} onSelect={onSelect} />
    <div className="map-foot">
      {busy ? <span className="map-progress"><LoaderCircle className="spin" />{progressLabel(progress)}{progress.total ? <progress value={progress.done} max={progress.total} /> : null}</span>
        : <span>{activeCount === points.length ? `${points.length}冊を配置` : `${points.length}冊中 ${activeCount}冊が条件に一致`}{untitled > 0 && `・タイトルのない${untitled}冊は対象外`}{pending > 0 && `・未計算 ${pending}冊`}</span>}
      <span className="map-note">位置はタイトルと要約の内容の近さ、色は分類を表します。軸は厳密な意味を持ちませんが、横方向は『社会 ↔ 技術』、縦方向は『抽象 ↔ 具体』の傾向として見ることができます。</span>
    </div>
    {error && <div className="map-error" role="alert"><p>{error.message}</p>{error.code === 'unauthorized' && driveStatus !== 'unavailable' && <button className="primary-btn" onClick={onConnect}><Cloud /> Googleでログインして接続</button>}</div>}
    {!error && driveError && <p className="map-drive-note">マップのデータをGoogle Driveに保存できませんでした（このブラウザには保存済み）：{driveError}</p>}
  </section>
}

function progressLabel(p: MapProgress) {
  if (p.phase === 'loading') return '保存済みのマップを読み込み中…'
  if (p.phase === 'embedding') return `内容をベクトル化しています（${p.done}/${p.total}冊）…`
  if (p.phase === 'layout') return `内容の近さから配置を計算しています（${p.done}%）…`
  return ''
}

/** 本の一覧が変わるたびに、変わった本だけを計算してマップを更新する */
function useBookMapData(books: Book[], driveStatus: SyncStatus) {
  const [cache, setCache] = useState<MapCache | null>(null)
  const [progress, setProgress] = useState<MapProgress>({ phase: 'loading' })
  const [error, setError] = useState<Error & { code?: string } | null>(null)
  const [driveError, setDriveError] = useState<string>()
  const running = useRef(false)
  const queued = useRef<{ relayout: boolean } | null>(null)
  const booksRef = useRef(books)
  useEffect(() => { booksRef.current = books }, [books])

  const run = useCallback(async (relayout = false) => {
    if (running.current) { queued.current = { relayout: relayout || Boolean(queued.current?.relayout) }; return }
    running.current = true
    // 計算中に本が変わったら、終わったあとにもう一度更新する
    for (let next: { relayout: boolean } | null = { relayout }; next; next = queued.current, queued.current = null) {
      try {
        const result = await updateBookMap(booksRef.current, setProgress, next)
        setCache(result.cache); setError(result.error ?? null); setDriveError(result.driveError)
      } catch (e) { setError(e instanceof Error ? e : new Error(String(e))); setProgress({ phase: 'ready' }) }
    }
    running.current = false
  }, [])

  // 本の追加・編集のあと、少し待ってから更新
  useEffect(() => { const timer = setTimeout(() => void run(), 400); return () => clearTimeout(timer) }, [books, run])
  // Driveに接続できたら、Drive上のマップデータも確認する
  const connected = driveStatus === 'synced' || driveStatus === 'pending'
  useEffect(() => { if (connected) { recheckRemote(); void run() } }, [connected, run])

  return { cache, progress, error, driveError, relayout: () => void run(true) }
}

/** Canvasに点を描き、ズーム・ドラッグ移動・ホバー・クリックを扱う */
function MapCanvas({ points, onSelect }: { points: Point[]; onSelect: (book: Book) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 })
  const [hover, setHover] = useState<Point | null>(null)
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])

  useEffect(() => {
    const el = wrapRef.current; if (!el) return
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const base = Math.min(size.w, size.h) / 2 * 0.9
  const toScreen = useCallback((p: { x: number; y: number }, v: View = viewRef.current) => ({ x: size.w / 2 + v.tx + p.x * base * v.k, y: size.h / 2 + v.ty + p.y * base * v.k }), [size, base])

  // ホバー中の本が絞り込みで外れたらツールチップを消す
  const shownHover = hover && points.some(p => p.book.id === hover.book.id && p.active) ? hover : null

  // 描画
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas || !size.w) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr); canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d'); if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const r = Math.min(9, 4 * Math.pow(view.k, 0.25))
    const onScreen: { p: Point; x: number; y: number }[] = []
    for (const p of points) {
      const s = toScreen(p, view)
      if (s.x < -10 || s.y < -10 || s.x > size.w + 10 || s.y > size.h + 10) continue
      if (p.active) onScreen.push({ p, ...s })
      ctx.beginPath()
      ctx.arc(s.x, s.y, p.active ? r : r * 0.6, 0, Math.PI * 2)
      ctx.fillStyle = p.active ? p.color : DIM_COLOR
      ctx.fill()
      if (p.active) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke() }
    }
    // 表示中の点が少ないとき（ズームしたときや絞り込んだとき）はタイトルを添える
    if (onScreen.length <= 150) {
      ctx.font = '500 11px "Noto Sans JP", sans-serif'
      ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'
      const placed: { x: number; y: number; w: number }[] = []
      for (const { p, x, y } of onScreen) {
        const label = p.book.title.length > 16 ? `${p.book.title.slice(0, 16)}…` : p.book.title
        const w = ctx.measureText(label).width, lx = x + r + 4
        if (lx + w > size.w || placed.some(q => lx < q.x + q.w + 4 && q.x < lx + w + 4 && Math.abs(q.y - y) < 14)) continue
        placed.push({ x: lx, y, w })
        ctx.lineWidth = 3; ctx.strokeStyle = '#ffffffd9'; ctx.strokeText(label, lx, y)
        ctx.fillStyle = '#3b3446'; ctx.fillText(label, lx, y)
      }
    }
    if (shownHover) {
      const s = toScreen(shownHover, view)
      ctx.beginPath(); ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2)
      ctx.fillStyle = shownHover.color; ctx.fill()
      ctx.lineWidth = 3; ctx.strokeStyle = '#5c22d4'; ctx.stroke()
    }
  }, [points, size, view, shownHover, toScreen])


  /** 画面上の位置に一番近い点（近くに無ければ null） */
  const pick = (x: number, y: number, radius = 12) => {
    let best: Point | null = null, bestD = radius * radius
    for (const p of points) {
      if (!p.active) continue
      const s = toScreen(p), d = (s.x - x) ** 2 + (s.y - y) ** 2
      if (d <= bestD) { best = p; bestD = d }
    }
    return best
  }

  const zoomAt = useCallback((factor: number, x: number, y: number) => {
    setView(v => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor)), ratio = k / v.k
      const ox = size.w / 2 + v.tx, oy = size.h / 2 + v.ty
      return { k, tx: x - (x - ox) * ratio - size.w / 2, ty: y - (y - oy) * ratio - size.h / 2 }
    })
  }, [size])

  // ホイールでズーム（ページのスクロールを止めるため passive: false で登録）
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - rect.left, e.clientY - rect.top)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // ドラッグ移動・ピンチズーム・クリック
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ moved: boolean; startX: number; startY: number; dist?: number }>({ moved: false, startX: 0, startY: 0 })
  const local = (e: React.PointerEvent) => { const rect = canvasRef.current!.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top } }
  const onPointerDown = (e: React.PointerEvent) => {
    const pos = local(e)
    canvasRef.current?.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, pos)
    if (pointers.current.size === 1) gesture.current = { moved: false, startX: pos.x, startY: pos.y }
    else { const [a, b] = [...pointers.current.values()]; gesture.current = { ...gesture.current, moved: true, dist: Math.hypot(a.x - b.x, a.y - b.y) } }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const pos = local(e)
    const prev = pointers.current.get(e.pointerId)
    if (!prev) { if (e.pointerType === 'mouse') setHover(pick(pos.x, pos.y)); return }
    pointers.current.set(e.pointerId, pos)
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (gesture.current.dist) zoomAt(dist / gesture.current.dist, (a.x + b.x) / 2, (a.y + b.y) / 2)
      gesture.current.dist = dist
      setView(v => ({ ...v, tx: v.tx + (pos.x - prev.x) / 2, ty: v.ty + (pos.y - prev.y) / 2 }))
      return
    }
    if (!gesture.current.moved && Math.hypot(pos.x - gesture.current.startX, pos.y - gesture.current.startY) < 5) return
    gesture.current.moved = true
    setHover(null)
    setView(v => ({ ...v, tx: v.tx + pos.x - prev.x, ty: v.ty + pos.y - prev.y }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const wasTap = pointers.current.size === 1 && !gesture.current.moved
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) gesture.current.dist = undefined
    if (!wasTap) return
    const pos = local(e)
    const hit = pick(pos.x, pos.y, e.pointerType === 'mouse' ? 12 : 20)
    if (!hit) { setHover(null); return }
    // マウスはクリックで開く。タッチは1回目で内容を表示し、同じ点をもう一度タップで開く
    if (e.pointerType === 'mouse' || hover?.book.id === hit.book.id) { setHover(null); onSelect(hit.book) }
    else setHover(hit)
  }
  const onPointerCancel = (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); gesture.current.dist = undefined }

  const center = (factor: number) => zoomAt(factor, size.w / 2, size.h / 2)
  return <div className="map-stage" ref={wrapRef}>
    <div className="map-guides" aria-hidden="true"><i className="h" /><i className="v" /></div>
    <canvas ref={canvasRef} role="img" aria-label="本の分類マップ。内容が近い本ほど近くに表示されます" className={shownHover ? 'pointing' : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onPointerLeave={e => { if (e.pointerType === 'mouse' && !pointers.current.size) setHover(null) }} />
    <MapAxes />
    {points.length === 0 && <div className="map-empty"><BookOpen /><p>マップに表示できる本がまだありません</p></div>}
    <div className="map-zoom">
      <button onClick={() => center(1.5)} aria-label="拡大" title="拡大"><ZoomIn /></button>
      <button onClick={() => center(1 / 1.5)} aria-label="縮小" title="縮小"><ZoomOut /></button>
      <button onClick={() => setView({ k: 1, tx: 0, ty: 0 })} aria-label="全体を表示" title="全体を表示"><Maximize2 /></button>
    </div>
    {shownHover && <MapTooltip point={shownHover} pos={toScreen(shownHover)} size={size} touch={!window.matchMedia('(hover: hover)').matches} />}
  </div>
}

/**
 * 軸の読み方の目安。配置（UMAP）の軸そのものに意味はないが、見る人の手がかりとして四辺に傾向を添える。
 * 埋め込みや配置の計算から求めたものではなく、ズーム・移動しても画面の枠に固定して表示する。
 */
function MapAxes() {
  return <div className="map-axes" aria-hidden="true">
    <span className="left">← 社会</span>
    <span className="right">技術 →</span>
    <span className="top">↑ 具体</span>
    <span className="bottom">↓ 抽象</span>
  </div>
}

function MapTooltip({ point, pos, size, touch }: { point: Point; pos: { x: number; y: number }; size: { w: number; h: number }; touch: boolean }) {
  const { book } = point
  const child = categories.find(c => c.id === book.categoryId)
  const parent = categories.find(c => c.id === child?.parent)
  const memo = book.memo.trim()
  const width = Math.min(300, size.w - 24)
  const left = pos.x + 16 + width > size.w ? Math.max(8, pos.x - 16 - width) : pos.x + 16
  const top = Math.min(Math.max(8, pos.y - 40), Math.max(8, size.h - 190))
  return <div className="map-tooltip" style={{ left, top, width }}>
    <div className="map-tooltip-cover"><CoverImage src={book.cover} alt="" width={200} fallback={<BookOpen />} /></div>
    <div className="map-tooltip-body">
      <div className="category-line"><i style={{ background: point.color }} />{parent && <><span>{parent.name}</span><ChevronRight /></>}<b>{child?.name}</b></div>
      <strong>{book.title}</strong>
      <p>{memo ? (memo.length > 100 ? `${memo.slice(0, 100)}…` : memo) : '要約は未登録です'}</p>
      <span className={`status mini ${statusClass[book.status]}`}>{book.status}</span>
      {touch && <small className="map-tooltip-hint">もう一度タップで詳細を開く</small>}
    </div>
  </div>
}
