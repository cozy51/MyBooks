import { useCallback, useEffect, useRef, useState } from 'react'
import * as drive from './drive'
import type { Book } from './types'

const META_KEY = 'mybooks-drive-v1'
const SAVE_DELAY = 1500

/** syncedAt: 最後に同期したときのDriveファイルの更新日時 / dirty: Driveに未保存の変更があるか */
interface Meta { fileId?: string; syncedAt?: string; dirty: boolean; lastSync?: string }
export type SyncStatus = 'unavailable' | 'signedOut' | 'needsFolder' | 'syncing' | 'synced' | 'pending' | 'error'

function loadMeta(storeKey: string, metaKey = META_KEY): Meta {
  // 一度も同期していない場合、このブラウザで編集済みのデータがあれば未保存扱いにする
  const initial: Meta = { dirty: localStorage.getItem(storeKey) !== null }
  try { return { ...initial, ...JSON.parse(localStorage.getItem(metaKey) || '{}') } } catch { return initial }
}

export interface SyncAdapter<T> { mergeRemote?: (local: T[], remote: T[]) => T[]; metaKey: string; findFile: typeof drive.findFile; getFile: typeof drive.getFile; download: (token: string, id: string) => Promise<T[]>; create: (token: string, items: T[]) => Promise<drive.DriveFile>; update: (token: string, id: string, items: T[]) => Promise<drive.DriveFile> }
const bookAdapter: SyncAdapter<Book> = { ...drive, metaKey: META_KEY }

export function useDriveSync<T = Book>(storeKey: string, books: T[], applyRemote: (books: T[]) => void, adapter: SyncAdapter<T> = bookAdapter as unknown as SyncAdapter<T>, enabled = true) {
  const meta = useRef<Meta>(loadMeta(storeKey, adapter.metaKey))
  // ログインが保管されていれば起動時に自動で受け取り直すので、最初は「同期中」にしておく
  const [status, setStatus] = useState<SyncStatus>(() => !enabled ? 'error' : !drive.DRIVE_CLIENT_ID ? 'unavailable' : 'syncing')
  const [message, setMessage] = useState('')
  const [lastSync, setLastSync] = useState(() => loadMeta(storeKey, adapter.metaKey).lastSync)
  const booksRef = useRef(books)
  const version = useRef(0)
  const busy = useRef(false)
  useEffect(() => { booksRef.current = books }, [books])

  const saveMeta = useCallback((patch: Partial<Meta>) => {
    meta.current = { ...meta.current, ...patch }
    try { localStorage.setItem(adapter.metaKey, JSON.stringify(meta.current)) } catch { /* noop */ }
    if (patch.lastSync) setLastSync(patch.lastSync)
  }, [adapter.metaKey])

  const markDirty = useCallback((items?: T[]) => {
    if (items) booksRef.current = items
    version.current++
    saveMeta({ dirty: true })
    setStatus(s => s === 'synced' || s === 'error' ? 'pending' : s)
  }, [saveMeta])

  const sync = useCallback(async (token: string) => {
    if (!enabled || busy.current) return
    busy.current = true
    setStatus('syncing'); setMessage('')
    const startVersion = version.current
    const done = (file: drive.DriveFile) => saveMeta({ fileId: file.id, syncedAt: file.modifiedTime, dirty: version.current !== startVersion, lastSync: new Date().toISOString() })
    try {
      const m = meta.current
      let file = m.fileId ? await adapter.getFile(token, m.fileId) : null
      file ??= await adapter.findFile(token)
      if (!file) done(await adapter.create(token, booksRef.current))
      else if (file.modifiedTime !== m.syncedAt) {
        // 別の端末でDriveのデータが更新されている
        const remote = await adapter.download(token, file.id)
        if (adapter.mergeRemote) {
          const merged = adapter.mergeRemote(booksRef.current, remote)
          applyRemote(merged)
          done(await adapter.update(token, file.id, merged))
        } else {
          const useRemote = (!m.dirty && version.current === startVersion) || confirm(`Google Driveに、別の端末で保存されたデータ（${remote.length}件）があります。\n\nOK：Driveのデータを読み込む（このブラウザの${booksRef.current.length}件は置き換わります）\nキャンセル：このブラウザのデータでDriveを上書きする`)
          if (useRemote) { applyRemote(remote); done(file) }
          else done(await adapter.update(token, file.id, booksRef.current))
        }
      } else if (m.dirty) done(await adapter.update(token, file.id, booksRef.current))
      else saveMeta({ lastSync: new Date().toISOString() })
      setStatus(meta.current.dirty ? 'pending' : 'synced')
    } catch (e) {
      setStatus(e instanceof drive.DriveAuthError ? 'signedOut' : e instanceof drive.FolderAccessError ? 'needsFolder' : 'error')
      setMessage(e instanceof Error ? e.message : String(e))
    } finally { busy.current = false }
  }, [applyRemote, adapter, saveMeta, enabled])

  const connect = useCallback(async () => {
    try { await sync(await drive.signIn()) } catch (e) { setStatus('signedOut'); setMessage(e instanceof Error ? e.message : String(e)) }
  }, [sync])

  const syncNow = useCallback(async () => { const token = await drive.currentToken(); return token ? sync(token) : connect() }, [sync, connect])

  const grantFolder = useCallback(async () => {
    try { if (await drive.grantFolderAccess()) await syncNow() } catch (e) { setMessage(e instanceof Error ? e.message : String(e)) }
  }, [syncNow])

  const disconnect = useCallback(() => { drive.signOut(); setStatus('signedOut'); setMessage('') }, [])

  // 起動時：ログイン済み（このタブ、またはサーバーに保管したログイン）なら最新データを取得
  useEffect(() => {
    if (!enabled || !drive.DRIVE_CLIENT_ID) return
    let cancelled = false
    void drive.currentToken().then(token => {
      if (cancelled) return
      if (token) void sync(token)
      else setStatus('signedOut')
    })
    return () => { cancelled = true }
  }, [sync, enabled])

  // ほかの操作（要約・表紙の読み取りなど）でログインし直したら、未接続の表示を解消して同期する
  const statusRef = useRef(status)
  useEffect(() => { statusRef.current = status }, [status])
  useEffect(() => drive.onToken(token => { if (statusRef.current === 'signedOut') void sync(token) }), [sync])

  // 編集後、少し待ってからDriveへ保存
  useEffect(() => {
    if (status !== 'pending') return
    const timer = setTimeout(() => {
      void drive.currentToken().then(token => {
        if (token) void sync(token)
        else { setStatus('signedOut'); setMessage('Googleのログインの有効期限が切れました。再接続すると保存されます。') }
      })
    }, SAVE_DELAY)
    return () => clearTimeout(timer)
  }, [status, books, sync])

  return { status, message, lastSync, markDirty, connect, syncNow, grantFolder, disconnect }
}
