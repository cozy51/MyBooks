// 表紙画像から、タイトル・著者・分類を読み取る（サーバーの /api/cover-info 経由。APIキーはブラウザに置かない）
import { categories } from './data'
import { storedToken } from './drive'

export interface CoverInfo { title: string; author: string; categoryId: string }

/** 送る画像を長辺1200pxのJPEGに縮める（通信量とAPIの制限を抑えるため） */
async function shrink(image: Blob): Promise<{ image: string; mimeType: string }> {
  const bitmap = await createImageBitmap(image)
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return { image: canvas.toDataURL('image/jpeg', 0.85).split(',')[1], mimeType: 'image/jpeg' }
}

/** 表紙（画像そのもの、または保存済みの DriveのファイルID・画像URL）を読み取る */
export async function readCoverInfo(source: { image: Blob } | { cover: string }): Promise<CoverInfo> {
  const token = storedToken()
  const choices = categories.filter(c => c.parent).map(c => ({ id: c.id, name: `${categories.find(p => p.id === c.parent)?.name} ＞ ${c.name}` }))
  const payload = 'image' in source ? await shrink(source.image) : { cover: source.cover }
  let res: Response
  try {
    // サーバーは50秒で打ち切って応答するが、通信が切れた場合にも待ち続けないよう65秒で止める
    res = await fetch('/api/cover-info', { signal: AbortSignal.timeout(65_000), method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...payload, categories: choices }) })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new Error('表紙の読み取りが時間内に終わりませんでした。もう一度お試しください。', { cause: e })
    throw new Error('表紙を読み取るAPIに接続できませんでした。ネットワークを確認してください。', { cause: e })
  }
  const data = await res.json().catch(() => null) as (Partial<CoverInfo> & { error?: string }) | null
  if (res.status === 404 && !data) throw new Error('表紙を読み取るAPI（/api/cover-info）が見つかりません。Vercelへのデプロイ、または npm run dev で起動してください。')
  if (res.status === 504 && !data) throw new Error('表紙の読み取りが時間内に終わりませんでした。もう一度お試しください。')
  if (!res.ok || !data) throw new Error(data?.error || `表紙を読み取れませんでした（${res.status}）`)
  return { title: data.title ?? '', author: data.author ?? '', categoryId: data.categoryId ?? '' }
}
