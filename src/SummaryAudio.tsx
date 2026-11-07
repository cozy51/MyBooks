import { useSyncExternalStore, type MouseEvent } from 'react'
import { CircleAlert, LoaderCircle, Play, Square } from 'lucide-react'
import { driveFileId } from './cover'
import { DRIVE_CLIENT_ID, currentToken, downloadBlob, signInForRead, storedReadToken } from './drive'

/**
 * 要約音声（WAVなど）を、カードの上でそのまま再生する。
 * 再生器は画面全体で1つだけにし、別のカードで再生を始めたら前の音声は止める。
 */
type Status = 'idle' | 'loading' | 'playing' | 'error'
interface State { url: string; status: Status; message: string }

let state: State = { url: '', status: 'idle', message: '' }
const listeners = new Set<() => void>()
const set = (next: State) => { state = next; listeners.forEach(l => l()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

let audio: HTMLAudioElement | null = null
/** 一度読み込んだ音声は覚えておき、もう一度押したときはすぐに再生する */
const sources = new Map<string, string>()

function player(): HTMLAudioElement {
  if (audio) return audio
  audio = new Audio()
  audio.preload = 'auto'
  audio.addEventListener('ended', () => { if (state.status === 'playing') set({ ...state, status: 'idle' }) })
  return audio
}

async function tryDownload(token: string | null, id: string): Promise<string | null> {
  if (!token) return null
  try { return URL.createObjectURL(await downloadBlob(token, id)) } catch { return null }
}

/**
 * 再生に使うURL。Google Driveのファイルは、ログイン中の権限で中身を受け取って再生する
 * （共有リンクのURLは再生できる形ではないため）。受け取れないときは、リンク共有されたファイル向けのURLを試す
 */
async function resolveSource(url: string): Promise<string> {
  const cached = sources.get(url)
  if (cached) return cached
  const id = driveFileId(url)
  if (!id) return url
  let src = await tryDownload(storedReadToken(), id) ?? await tryDownload(await currentToken(), id)
  // 初回だけ、要約の作成と同じ読み取りの許可を求める（2回目以降は自動）
  if (!src && DRIVE_CLIENT_ID) src = await tryDownload(await signInForRead().catch(() => null), id)
  src ??= `https://drive.google.com/uc?export=download&id=${id}`
  sources.set(url, src)
  return src
}

function stop() {
  audio?.pause()
  set({ url: '', status: 'idle', message: '' })
}

async function play(url: string) {
  const el = player()
  el.pause()
  set({ url, status: 'loading', message: '' })
  try {
    const src = await resolveSource(url)
    if (state.url !== url) return
    if (el.src !== src) el.src = src
    el.currentTime = 0
    await el.play()
    if (state.url === url) set({ url, status: 'playing', message: '' })
  } catch (error) {
    if (state.url !== url) return
    // 再生できなかった形のURLは覚えず、次に押したときにもう一度試せるようにする
    const cached = sources.get(url)
    if (cached?.startsWith('https://drive.google.com/uc')) sources.delete(url)
    console.warn('要約音声を再生できませんでした', error)
    set({ url, status: 'error', message: '再生できませんでした。もう一度押すとリンクを開きます' })
  }
}

/** カード用の小さな再生ボタン（押すと再生、再生中に押すと停止） */
export function SummaryAudioButton({ url }: { url: string }) {
  const current = useSyncExternalStore(subscribe, () => state)
  const mine = current.url === url
  const status: Status = mine ? current.status : 'idle'
  const onClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (status === 'playing' || status === 'loading') { stop(); return }
    if (status === 'error') { window.open(url, '_blank', 'noreferrer'); stop(); return }
    void play(url)
  }
  const title = status === 'playing' ? '要約音声を停止' : status === 'loading' ? '要約音声を読み込み中…（押すと中止）' : status === 'error' ? current.message : '要約音声を再生'
  const Icon = status === 'playing' ? Square : status === 'loading' ? LoaderCircle : status === 'error' ? CircleAlert : Play
  return <button type="button" className={`card-audio ${status}`} onClick={onClick} onKeyDown={e => e.stopPropagation()} title={title} aria-label={title} aria-pressed={status === 'playing'}>
    <Icon className={status === 'loading' ? 'spin' : undefined} />
  </button>
}
