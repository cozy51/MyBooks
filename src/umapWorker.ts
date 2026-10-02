// UMAPで高次元のベクトルを2次元に圧縮する Web Worker
import { UMAP } from 'umap-js'

/** 毎回同じ配置になるよう、固定シードの乱数を使う（mulberry32） */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

self.onmessage = (e: MessageEvent<{ vectors: number[][] }>) => {
  const { vectors } = e.data
  const umap = new UMAP({ nComponents: 2, nNeighbors: Math.max(2, Math.min(15, vectors.length - 1)), minDist: 0.12, random: seeded(42) })
  const epochs = umap.initializeFit(vectors)
  for (let i = 0; i < epochs; i++) {
    umap.step()
    if (i % 10 === 0) self.postMessage({ progress: i / epochs })
  }
  self.postMessage({ coords: umap.getEmbedding() })
}
