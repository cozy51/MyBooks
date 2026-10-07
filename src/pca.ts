// 主成分分析（PCA）：Embeddingのベクトルを、ばらつきが最も大きい2方向（PC1・PC2）に射影して2次元にする。
// UMAPと違って線形で乱数も使わないため、同じデータなら必ず同じ配置になり、座標の向き（PC1・PC2）に意味がある。

export interface PcaResult {
  /** 各ベクトルの [PC1, PC2] の値（中心化したベクトルを主成分の向きに射影したもの） */
  coords: [number, number][]
  /** PC1・PC2 が全体のばらつきのうち何割を説明しているか（寄与率、0〜1） */
  ratios: [number, number]
}

/** べき乗法で上位2つの主成分を求める（共分散行列は作らず、X^T(Xv) を繰り返す） */
export function pca2(vectors: ArrayLike<number>[]): PcaResult | null {
  const n = vectors.length
  if (n < 3) return null
  const d = vectors[0].length
  const mean = new Float64Array(d)
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j] / n
  const x = vectors.map(v => { const c = new Float64Array(d); for (let j = 0; j < d; j++) c[j] = v[j] - mean[j]; return c })
  let total = 0
  for (const c of x) for (let j = 0; j < d; j++) total += c[j] * c[j]
  if (!total) return null

  const components: Float64Array[] = [], variances: number[] = []
  for (let k = 0; k < 2; k++) {
    // 初期値は固定（毎回同じ結果にするため）
    let v = new Float64Array(d).map((_, j) => Math.sin(j * 12.9898 + k * 78.233) + 0.5)
    let lambda = 0
    for (let iter = 0; iter < 300; iter++) {
      // 求め済みの主成分の向きを取り除いてから掛ける
      for (const u of components) { const p = dotF(v, u); for (let j = 0; j < d; j++) v[j] -= p * u[j] }
      const next = new Float64Array(d)
      for (const c of x) { const s = dotF(c, v); if (s) for (let j = 0; j < d; j++) next[j] += s * c[j] }
      for (const u of components) { const p = dotF(next, u); for (let j = 0; j < d; j++) next[j] -= p * u[j] }
      const norm = Math.sqrt(dotF(next, next))
      if (!norm) break
      for (let j = 0; j < d; j++) next[j] /= norm
      const delta = 1 - Math.abs(dotF(next, v) / (Math.sqrt(dotF(v, v)) || 1))
      v = next; lambda = norm
      if (delta < 1e-10) break
    }
    // 主成分の向き（正負）は任意なので、絶対値が最大の成分が正になるようにそろえ、再計算しても反転しないようにする
    let big = 0
    for (let j = 0; j < d; j++) if (Math.abs(v[j]) > Math.abs(big)) big = v[j]
    if (big < 0) for (let j = 0; j < d; j++) v[j] = -v[j]
    components.push(v); variances.push(lambda)
  }
  return {
    coords: x.map(c => [dotF(c, components[0]), dotF(c, components[1])]),
    ratios: [variances[0] / total, variances[1] / total],
  }
}

function dotF(a: Float64Array, b: Float64Array) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
