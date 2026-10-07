// 意味軸スコア：「社会 ↔ 技術」「理論 ↔ 実践」の2つの軸に対して、本・動画がどちら寄りかを数値にする。
// 両端を表す短い文（アンカー）と分類名をマップと同じEmbeddingでベクトル化し、
// 「タイトル＋要約」のベクトルと分類のベクトルを、両端の差の方向に射影して求める。
// 本と動画は要約の書き方が違うため、両者の平均の差の方向を軸から取り除き、文章の形式による偏りを抑える。
import { categories } from './data'
import { dequantize, dot, fetchEmbeddings, hash, loadLocal, quantize, saveLocal } from './embeddingStore'

type Pole = 'social' | 'tech' | 'theory' | 'practice'

/**
 * 各軸の両端を表すアンカー文。複数の言い方の平均をその端の向きとする。
 * もう一方の軸に引っ張られないよう、社会・技術の文には理論寄り・実践寄りの話題を、
 * 理論・実践の文には社会寄り・技術寄りの話題を、それぞれ同じくらい含める
 */
const ANCHORS: Record<Pole, string[]> = {
  social: ['社会、人間、心理、歴史、文化、生活についての内容', '経営、ビジネス、組織、働き方、マネジメント、コミュニケーション', '思想、社会学、心理学、経営理論、仕事術、生活の実用'],
  tech: ['工学、機械、製造、技術についての内容', 'IT、ソフトウェア、プログラミング、コンピュータ', '数学、物理、アルゴリズム、機械設計、生産管理、ソフトウェア開発'],
  theory: ['原理、概念、理論、背景、思想、仕組みの解説', '基礎から体系的に学び、なぜそうなるのか（Why）を理解する内容', '思想、社会学、心理学、経営理論、歴史、数学、物理、工学基礎、アルゴリズム、技術原理'],
  practice: ['手順、方法、操作、設計、実装、改善、活用の解説', '事例やノウハウをもとに、どうやるのか（How）を身につける内容', '仕事術、マネジメント、コミュニケーション、生活の実用、機械設計、生産管理、製造、プログラミング実装、現場改善'],
}
const POLES = Object.keys(ANCHORS) as Pole[]

/** 分類のEmbeddingに使う文（例:「機械工学：設計・製図・CAD」） */
function categoryText(id: string): string {
  const c = categories.find(c => c.id === id)!
  const parent = categories.find(p => p.id === c.parent)
  const strip = (name: string) => name.replace(/^[A-G](-\d+)?[.:]\s*/, '')
  return parent ? `${strip(parent.name)}：${strip(c.name)}` : strip(c.name)
}

const DB_KEY = 'semantic-axes-v2'
const TEXTS = [...POLES.flatMap(p => ANCHORS[p]), ...categories.map(c => categoryText(c.id))]
const TEXTS_HASH = hash(TEXTS.join('\n'))

export interface AxisRefs { poles: Record<Pole, Float32Array>; categories: Record<string, Float32Array> }
interface StoredRefs { model: string; h: string; vectors: string[] }

const loaded = new Map<string, Promise<AxisRefs>>()

/** アンカーと分類のベクトルを用意する（モデルごとに一度だけ計算して保存する） */
export function loadAxisRefs(model: string): Promise<AxisRefs> {
  let refs = loaded.get(model)
  if (!refs) {
    refs = loadAxisRefsNow(model)
    refs.catch(() => loaded.delete(model))
    loaded.set(model, refs)
  }
  return refs
}

async function loadAxisRefsNow(model: string): Promise<AxisRefs> {
  let stored = await loadLocal<StoredRefs>(DB_KEY)
  if (!stored || stored.model !== model || stored.h !== TEXTS_HASH || stored.vectors.length !== TEXTS.length) {
    const result = await fetchEmbeddings(TEXTS)
    if (result.model !== model) throw new Error(`意味軸の計算に使うEmbeddingのモデル（${result.model}）がマップ（${model}）と異なります。「配置を再計算」してください。`)
    stored = { model, h: TEXTS_HASH, vectors: result.vectors.map(quantize) }
    await saveLocal(DB_KEY, stored)
  }
  const vectors = stored.vectors.map(dequantize)
  let i = 0
  const poles = {} as Record<Pole, Float32Array>
  for (const pole of POLES) poles[pole] = normalize(mean(ANCHORS[pole].map(() => vectors[i++])))
  const cats: Record<string, Float32Array> = {}
  for (const c of categories) cats[c.id] = vectors[i++]
  return { poles, categories: cats }
}

export interface AxisItem { id: string; vector: Float32Array; categoryId: string; video: boolean }

/** 分類のベクトルをどれだけ混ぜるか（残りはタイトル＋要約） */
const CATEGORY_WEIGHT = 0.25

/**
 * 意味軸スコアを求める。戻り値は [横, 縦] で、横は +1 に近いほど技術寄り、縦は +1 に近いほど実践寄り。
 * ライブラリ全体の中央値を 0 とした相対的な位置で、外れ値があっても -1〜1 の中に収まるようにする
 */
export function computeAxisScores(items: AxisItem[], refs: AxisRefs): Map<string, [number, number]> {
  const scores = new Map<string, [number, number]>()
  if (items.length === 0) return scores
  let axisX = subtract(refs.poles.tech, refs.poles.social)
  let axisY = subtract(refs.poles.practice, refs.poles.theory)

  // 本と動画の平均の差（文章の形式の違い）の方向を軸から取り除き、その方向の差がスコアに出ないようにする
  const videos = items.filter(i => i.video), books = items.filter(i => !i.video)
  if (videos.length >= 10 && books.length >= 10) {
    const typeDir = normalize(subtract(mean(videos.map(i => i.vector)), mean(books.map(i => i.vector))))
    axisX = reject(axisX, typeDir); axisY = reject(axisY, typeDir)
  }

  const raw = items.map(item => {
    const cat = refs.categories[item.categoryId]
    const project = (axis: Float32Array) => cat ? (1 - CATEGORY_WEIGHT) * dot(item.vector, axis) + CATEGORY_WEIGHT * dot(cat, axis) : dot(item.vector, axis)
    return [project(axisX), project(axisY)] as const
  })
  const scaleX = robustScale(raw.map(r => r[0])), scaleY = robustScale(raw.map(r => r[1]))
  items.forEach((item, i) => scores.set(item.id, [scaleX(raw[i][0]), scaleY(raw[i][1])]))
  return scores
}

/** 中央値を 0、ばらつき（MADから求めた標準偏差の目安）の2倍で約 ±0.76 になるよう、-1〜1 に滑らかに収める */
function robustScale(values: number[]): (v: number) => number {
  const median = (list: number[]) => { const s = [...list].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
  const center = median(values)
  const spread = median(values.map(v => Math.abs(v - center))) * 1.4826 || 1
  return v => Math.round(Math.tanh((v - center) / spread / 2) * 10000) / 10000
}

function mean(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0].length)
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i] / vectors.length
  return out
}
function subtract(a: Float32Array, b: Float32Array): Float32Array { return a.map((v, i) => v - b[i]) }
function normalize(v: Float32Array): Float32Array { const n = Math.sqrt(dot(v, v)) || 1; return v.map(x => x / n) }
/** a から、長さ1のベクトル dir の方向の成分を取り除く */
function reject(a: Float32Array, dir: Float32Array): Float32Array { const k = dot(a, dir); return a.map((v, i) => v - k * dir[i]) }
