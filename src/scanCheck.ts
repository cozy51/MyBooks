// 全ページスキャンのリンク先のファイル名を取得する（詳細画面に表示して、別の本のファイルになっていないか目で確かめられるように）。
// ファイル名は書名とおおむね同じだが完全には一致しないので、自動の判定には使わない（別の本かどうかは、要約のときにAIが中身で確かめる）
import { driveFileId } from './cover'
import { currentToken, storedReadToken, storedToken } from './drive'

const names = new Map<string, Promise<string | null>>()

/** 全ページスキャンのDriveのファイル名（Driveのリンクでない・読めないときは null） */
export function scanFileName(scanUrl: string): Promise<string | null> {
  const id = driveFileId(scanUrl)
  if (!id) return Promise.resolve(null)
  let name = names.get(id)
  if (!name) {
    name = (async () => {
      const token = storedReadToken() ?? storedToken() ?? await currentToken()
      if (!token) return null
      try {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
        return res.ok ? (await res.json() as { name?: string }).name ?? null : null
      } catch { return null }
    })()
    // 読めなかったときは、あとで（ログイン後などに）もう一度確かめられるよう覚えない
    void name.then(n => { if (n === null) names.delete(id) })
    names.set(id, name)
  }
  return name
}
