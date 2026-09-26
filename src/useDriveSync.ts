import { useCallback, useEffect, useRef, useState } from 'react'
import * as drive from './drive'
import type { Book } from './types'

const META_KEY = 'mybooks-drive-v1'
const SAVE_DELAY = 1500

/** syncedAt: 最後に同期したときのDriveファイルの更新日時 / dirty: Driveに未保存の変更があるか */
interface Meta { fileId?: string; syncedAt?: string; dirty: boolean; lastSync?: string }
export type SyncStatus = 'unavailable' | 'signedOut' | 'syncing' | 'synced' | 'pending' | 'error'

function loadMeta(storeKey: string): Meta {
  // 一度も同期していない場合、このブラウザで編集済みのデータがあれば未保存扱いにする
  const initial: Meta = { dirty: localStorage.getItem(storeKey) !== null }
  try { return { ...initial, ...JSON.parse(localStorage.getItem(META_KEY) || '{}') } } catch { return initial }
}

export function useDriveSync(storeKey: string, books: Book[], applyRemote: (books: Book[]) => void) {
  const meta = useRef<Meta>(loadMeta(storeKey))
  const [status, setStatus] = useState<SyncStatus>(() => !drive.DRIVE_CLIENT_ID ? 'unavailable' : drive.storedToken() ? 'syncing' : 'signedOut')
  const [message, setMessage] = useState('')
  const [lastSync, setLastSync] = useState(() => loadMeta(storeKey).lastSync)
  const booksRef = useRef(books)
  const version = useRef(0)
  const busy = useRef(false)
  useEffect(() => { booksRef.current = books }, [books])

  const saveMeta = (patch: Partial<Meta>) => {
    meta.current = { ...meta.current, ...patch }
    try { localStorage.setItem(META_KEY, JSON.stringify(meta.current)) } catch { /* noop */ }
    if (patch.lastSync) setLastSync(patch.lastSync)
  }

  const markDirty = useCallback(() => {
    version.current++
    saveMeta({ dirty: true })
    setStatus(s => s === 'synced' || s === 'error' ? 'pending' : s)
  }, [])

  const sync = useCallback(async (token: string) => {
    if (busy.current) return
    busy.current = true
    setStatus('syncing'); setMessage('')
    const startVersion = version.current
    const done = (file: drive.DriveFile) => saveMeta({ fileId: file.id, syncedAt: file.modifiedTime, dirty: version.current !== startVersion, lastSync: new Date().toISOString() })
    try {
      const m = meta.current
      let file = m.fileId ? await drive.getFile(token, m.fileId) : null
      file ??= await drive.findFile(token)
      if (!file) done(await drive.create(token, booksRef.current))
      else if (file.modifiedTime !== m.syncedAt) {
        // 別の端末でDriveのデータが更新されている
        const remote = await drive.download(token, file.id)
        const useRemote = !m.dirty || confirm(`Google Driveに、別の端末で保存されたデータ（${remote.length}冊）があります。\n\nOK：Driveのデータを読み込む（このブラウザの${booksRef.current.length}冊は置き換わります）\nキャンセル：このブラウザのデータでDriveを上書きする`)
        if (useRemote) { applyRemote(remote); done(file) }
        else done(await drive.update(token, file.id, booksRef.current))
      } else if (m.dirty) done(await drive.update(token, file.id, booksRef.current))
      else saveMeta({ lastSync: new Date().toISOString() })
      setStatus(meta.current.dirty ? 'pending' : 'synced')
    } catch (e) {
      setStatus(e instanceof drive.DriveAuthError ? 'signedOut' : 'error')
      setMessage(e instanceof Error ? e.message : String(e))
    } finally { busy.current = false }
  }, [applyRemote])

  const connect = useCallback(async () => {
    try { await sync(await drive.signIn()) } catch (e) { setStatus('signedOut'); setMessage(e instanceof Error ? e.message : String(e)) }
  }, [sync])

  const syncNow = useCallback(() => { const token = drive.storedToken(); return token ? sync(token) : connect() }, [sync, connect])

  const disconnect = useCallback(() => { drive.signOut(); setStatus('signedOut'); setMessage('') }, [])

  // 起動時：このタブでログイン済みなら最新データを取得
  useEffect(() => {
    const token = drive.DRIVE_CLIENT_ID && drive.storedToken()
    if (!token) return
    const timer = setTimeout(() => void sync(token))
    return () => clearTimeout(timer)
  }, [sync])

  // 編集後、少し待ってからDriveへ保存
  useEffect(() => {
    if (status !== 'pending') return
    const timer = setTimeout(() => {
      const token = drive.storedToken()
      if (token) void sync(token)
      else { setStatus('signedOut'); setMessage('Googleのログインの有効期限が切れました。再接続すると保存されます。') }
    }, SAVE_DELAY)
    return () => clearTimeout(timer)
  }, [status, books, sync])

  return { status, message, lastSync, markDirty, connect, syncNow, disconnect }
}
