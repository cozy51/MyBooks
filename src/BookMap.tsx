import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronRight, Cloud, LoaderCircle, Maximize2, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react'
import { CoverImage } from './CoverImage'
import { categories, statusClass } from './data'
import { computeAxisScores, loadAxisRefs, type AxisRefs } from './semanticAxes'
import { dequantize } from './embeddingStore'
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
const isVideo = (book: Book) => 'type' in book && book.type === 'youtube'

/** 意味軸スコア [横, 縦]。横は +1 に近いほど技術寄り、縦は +1 に近いほど実践寄り */
type AxisScore = [number, number]
interface Point { book: Book; x: number; y: number; color: string; active: boolean; axis?: AxisScore }
/** 近さで配置（UMAP）／意味軸で配置（意味軸スコアをそのまま座標にする） */
type MapMode = 'similar' | 'axes'
const MODE_KEY = 'mybooks-map-mode'
const readMode = (): MapMode => { try { return localStorage.getItem(MODE_KEY) === 'axes' ? 'axes' : 'similar' } catch { return 'similar' } }

/**
 * 「近さで配置」で、分類ごとの重心を置く画面上のおおよその向き（画面のyは下向きが正）。
 * UMAPの配置は回転・反転しても意味が変わらず、計算し直すたびに向きが変わるため、
 * 再計算しても見慣れた向きで表示されるよう、この向きに最も近くなるように配置を回転・反転する。
 * 座標そのものに意味を持たせるものではない（意味で見るときは「意味軸で配置」を使う）。
 */
const AXIS_TARGETS: Record<string, [number, number]> = { a: [1, -1], b: [0.3, -1], c: [1, 0.3], d: [0.5, 0.6], e: [-1, 1], f: [-1, 0] }

/** 配置を回転・反転して向きをそろえ、中心0・広がりがおおむね -1〜1 になるよう縮尺を合わせ直す */
function orientLayout(items: { x: number; y: number; group: string; anchor: boolean }[]): [number, number][] {
  if (items.length < 4) return items.map(p => [p.x, p.y])
  const mx = items.reduce((t, p) => t + p.x, 0) / items.length, my = items.reduce((t, p) => t + p.y, 0) / items.length
  const sums = new Map<string, { x: number; y: number; n: number }>()
  for (const p of items) {
    if (!p.anchor || !AXIS_TARGETS[p.group]) continue
    const s = sums.get(p.group) ?? { x: 0, y: 0, n: 0 }
    s.x += p.x - mx; s.y += p.y - my; s.n++; sums.set(p.group, s)
  }
  // 冊数の多い分類に引っ張られないよう、分類ごとの重心を同じ重みで扱う
  const fit = (flip: number) => {
    let a = 0, b = 0
    for (const [g, s] of sums) {
      if (s.n < 3) continue
      const cx = s.x / s.n, cy = flip * s.y / s.n, [tx, ty] = AXIS_TARGETS[g]
      a += cx * tx + cy * ty; b += cx * ty - cy * tx
    }
    return { flip, angle: Math.atan2(b, a), score: Math.hypot(a, b) }
  }
  const plain = fit(1), flipped = fit(-1)
  const { flip, angle } = flipped.score > plain.score ? flipped : plain
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const rotated = items.map(p => { const x = p.x - mx, y = flip * (p.y - my); return [x * cos - y * sin, x * sin + y * cos] as [number, number] })
  // 回転で四隅にはみ出した分を、外れ値を除いた範囲で縮尺し直す
  const range = (values: number[]) => { const v = [...values].sort((a, b) => a - b), q = (r: number) => v[Math.round((v.length - 1) * r)]; return v.length >= 50 ? [q(0.02), q(0.98)] : [v[0], v[v.length - 1]] }
  const [x0, x1] = range(rotated.map(c => c[0])), [y0, y1] = range(rotated.map(c => c[1]))
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, span = Math.max(x1 - x0, y1 - y0) / 2 || 1
  return rotated.map(([x, y]) => [(x - cx) / span, (y - cy) / span])
}
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
  const [mode, setModeState] = useState<MapMode>(readMode)
  const setMode = (m: MapMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* noop */ } }
  const { refs, error: axisError } = useAxisRefs(cache?.model)

  // 意味軸スコアは表示モードに関係なく求め、ツールチップの割合表示にも使う
  const axisScores = useMemo(() => {
    if (!cache || !refs) return null
    const items = books.flatMap(book => { const entry = cache.entries[book.id]; return entry && embedText(book) ? [{ id: book.id, vector: dequantize(entry.e), categoryId: book.categoryId, video: isVideo(book) }] : [] })
    return computeAxisScores(items, refs)
  }, [books, cache, refs])

  const points = useMemo<Point[]>(() => {
    if (!cache) return []
    let list: Point[]
    if (mode === 'axes') {
      if (!axisScores) return []
      // 意味軸スコアを座標にする。画面のyは下向きが正なので縦は符号を反転し、値が大きいほど上（右上が技術・実践寄り）にする
      list = books.flatMap(book => { const a = axisScores.get(book.id); return a ? [{ book, x: a[0], y: -a[1], axis: a, color: PARENT_COLORS[parentOf(book.categoryId)] ?? OTHER_COLOR, active: visibleIds.has(book.id) }] : [] })
    } else {
      const placed = books.flatMap(book => { const p = cache.layout[book.id]; return p && embedText(book) ? [{ book, x: p[0], y: p[1], group: parentOf(book.categoryId), anchor: !isVideo(book) }] : [] })
      // 向きの基準には本だけを使う（動画は分類の付き方が本と異なるため）
      const coords = orientLayout(placed)
      list = placed.map(({ book, group }, i) => ({ book, x: coords[i][0], y: coords[i][1], axis: axisScores?.get(book.id), color: PARENT_COLORS[group] ?? OTHER_COLOR, active: visibleIds.has(book.id) }))
    }
    // 薄い点を先に描き、絞り込みに合う点を上に重ねる
    return list.sort((a, b) => Number(a.active) - Number(b.active))
  }, [books, cache, visibleIds, mode, axisScores])
  const axesPreparing = mode === 'axes' && Boolean(cache) && !axisScores && !axisError
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
      <div className="map-actions">
        <div className="view-switch map-mode" role="group" aria-label="マップの配置方法">
          <button className={mode === 'similar' ? 'active' : ''} aria-pressed={mode === 'similar'} onClick={() => setMode('similar')} title="内容が似ている本・動画を近くに置きます">近さで配置</button>
          <button className={mode === 'axes' ? 'active' : ''} aria-pressed={mode === 'axes'} onClick={() => setMode('axes')} title="横を『社会 ↔ 技術』、縦を『理論 ↔ 実践』の意味軸スコアで置きます">意味軸で配置</button>
        </div>
        {mode === 'similar' && <button className="secondary-btn map-relayout" disabled={busy || points.length === 0} onClick={relayout} title="すべての本の配置をUMAPで計算し直します"><RefreshCw /> 配置を再計算</button>}
      </div>
    </div>
    <MapCanvas key={mode} points={points} mode={mode} preparing={axesPreparing} onSelect={onSelect} />
    <div className="map-foot">
      {busy ? <span className="map-progress"><LoaderCircle className="spin" />{progressLabel(progress)}{progress.total ? <progress value={progress.done} max={progress.total} /> : null}</span>
        : <span>{activeCount === points.length ? `${points.length}件を配置` : `${points.length}件中 ${activeCount}件が条件に一致`}{untitled > 0 && `・タイトルのない${untitled}冊は対象外`}{pending > 0 && `・未計算 ${pending}冊`}</span>}
      <span className="map-note">{mode === 'similar'
        ? '● 本・■ 動画、色は分類。位置は内容の類似度をもとに配置しています。縦横の座標そのものに意味はありません（全体として社会寄り・技術寄りなどの傾向が見える場合があります）。'
        : '● 本・■ 動画、色は分類。横は『社会 ↔ 技術』、縦は『理論 ↔ 実践』の意味軸スコアで配置しています。スコアはタイトル・要約・分類から本と動画で同じ方法で求めた、ライブラリ全体の中での相対的な位置です（中央が中央値）。'}</span>
    </div>
    {axisError && <p className="map-drive-note">意味軸スコアを計算できませんでした：{axisError}</p>}
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

/** 意味軸のアンカー・分類のベクトルを用意する（マップと同じEmbeddingのモデルで） */
function useAxisRefs(model: string | undefined) {
  const [state, setState] = useState<{ model: string; refs: AxisRefs | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!model) return
    let alive = true
    loadAxisRefs(model).then(refs => { if (alive) setState({ model, refs, error: null }) }, e => { if (alive) setState({ model, refs: null, error: e instanceof Error ? e.message : String(e) }) })
    return () => { alive = false }
  }, [model])
  return state && state.model === model ? state : { refs: null, error: null }
}

/** Canvasに点を描き、ズーム・ドラッグ移動・ホバー・クリックを扱う */
function MapCanvas({ points, mode, preparing, onSelect }: { points: Point[]; mode: MapMode; preparing: boolean; onSelect: (book: Book) => void }) {
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
      // 動画は円と同じくらいの面積に見える四角で描く
      if (isVideo(p.book)) { const half = (p.active ? r : r * 0.6) * 0.89; ctx.rect(s.x - half, s.y - half, half * 2, half * 2) } else ctx.arc(s.x, s.y, p.active ? r : r * 0.6, 0, Math.PI * 2)
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
      ctx.beginPath()
      if (isVideo(shownHover.book)) { const half = (r + 4) * 0.89; ctx.rect(s.x - half, s.y - half, half * 2, half * 2) } else ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2)
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
    {/* 中心線と四辺のラベルは、座標に意味がある「意味軸で配置」のときだけ表示する */}
    {mode === 'axes' && <div className="map-guides" aria-hidden="true"><i className="h" /><i className="v" /></div>}
    <canvas ref={canvasRef} role="img" aria-label={mode === 'axes' ? '本の意味軸マップ。横は社会から技術、縦は下の理論から上の実践への傾きを表します' : '本の分類マップ。内容が近い本ほど近くに表示されます'} className={shownHover ? 'pointing' : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onPointerLeave={e => { if (e.pointerType === 'mouse' && !pointers.current.size) setHover(null) }} />
    {mode === 'axes' && <MapAxes />}
    {points.length === 0 && <div className="map-empty">{preparing ? <><LoaderCircle className="spin" /><p>意味軸スコアを計算しています…</p></> : <><BookOpen /><p>マップに表示できる本がまだありません</p></>}</div>}
    <div className="map-zoom">
      <button onClick={() => center(1.5)} aria-label="拡大" title="拡大"><ZoomIn /></button>
      <button onClick={() => center(1 / 1.5)} aria-label="縮小" title="縮小"><ZoomOut /></button>
      <button onClick={() => setView({ k: 1, tx: 0, ty: 0 })} aria-label="全体を表示" title="全体を表示"><Maximize2 /></button>
    </div>
    {shownHover && <MapTooltip point={shownHover} pos={toScreen(shownHover)} size={size} touch={!window.matchMedia('(hover: hover)').matches} />}
  </div>
}

/** 「意味軸で配置」の四辺のラベル。ズーム・移動しても画面の枠に固定して表示する */
function MapAxes() {
  return <div className="map-axes" aria-hidden="true">
    <span className="left">← 社会</span>
    <span className="right">技術 →</span>
    <span className="top">↑ 実践</span>
    <span className="bottom">↓ 理論</span>
  </div>
}

function MapTooltip({ point, pos, size, touch }: { point: Point; pos: { x: number; y: number }; size: { w: number; h: number }; touch: boolean }) {
  const { book } = point
  const child = categories.find(c => c.id === book.categoryId)
  const parent = categories.find(c => c.id === child?.parent)
  const memo = book.memo.trim()
  const video = isVideo(book)
  // 動画はサムネイルが横長なので、ツールチップも少し広げる
  const width = Math.min(video ? 340 : 300, size.w - 24)
  const left = pos.x + 16 + width > size.w ? Math.max(8, pos.x - 16 - width) : pos.x + 16
  const top = Math.min(Math.max(8, pos.y - 40), Math.max(8, size.h - 240))
  // 表紙・サムネイルは左に回り込ませ、その下のスペースまで文章を流す
  return <div className={`map-tooltip${video ? ' video' : ''}`} style={{ left, top, width }}>
    <div className="map-tooltip-cover"><CoverImage src={book.cover} alt="" width={200} fallback={<BookOpen />} /></div>
    <div className="category-line"><i style={{ background: point.color }} />{parent && <><span>{parent.name}</span><ChevronRight /></>}<b>{child?.name}</b></div>
    <strong>{video ? '▶ ' : '📕 '}{book.title}</strong>
    <p>{memo ? (memo.length > 100 ? `${memo.slice(0, 100)}…` : memo) : '要約は未登録です'}</p>
    {point.axis && <AxisMeters score={point.axis} />}
    <div className="map-tooltip-foot">
      <span className={`status mini ${statusClass[book.status]}`}>{video ? (book.memo ? 'AI解析済み' : 'AI未解析') : book.status}</span>
      {touch && <small className="map-tooltip-hint">もう一度タップで詳細を開く</small>}
    </div>
  </div>
}

/**
 * 意味軸スコアを、両端に対する割合（%）で示す（表示モードに関係なく同じ値）。
 * ライブラリ全体の中央値が50%で、どちらかの端に寄るほどその側の割合が大きくなる
 */
function AxisMeters({ score }: { score: AxisScore }) {
  const pct = (v: number) => Math.round(Math.max(0, Math.min(1, (v + 1) / 2)) * 100)
  const rows = [{ left: '社会', right: '技術', value: pct(score[0]) }, { left: '理論', right: '実践', value: pct(score[1]) }]
  return <div className="map-tooltip-axes">
    {rows.map(r => <div key={r.left} title={`${r.left} ${100 - r.value}% ・ ${r.right} ${r.value}%`}>
      <span className={r.value < 50 ? 'strong' : ''}>{r.left} {100 - r.value}%</span>
      <i><b style={{ left: `${r.value}%` }} /></i>
      <span className={r.value > 50 ? 'strong' : ''}>{r.value}% {r.right}</span>
    </div>)}
  </div>
}
