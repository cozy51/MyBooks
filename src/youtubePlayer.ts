/** Minimal wrapper around the YouTube IFrame Player API (needed to read the current time and seek). */
export interface YTPlayer { getCurrentTime(): number; seekTo(seconds: number, allowSeekAhead: boolean): void; playVideo(): void; pauseVideo(): void; destroy(): void }
interface YTNamespace { Player: new (el: HTMLElement, options: { videoId: string; host?: string; playerVars?: Record<string, number | string>; events?: { onReady?: () => void; onStateChange?: (e: { data: number }) => void } }) => YTPlayer; PlayerState: { PLAYING: number } }
declare global { interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void } }

let loading: Promise<YTNamespace> | null = null
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  loading ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { previous?.(); if (window.YT) resolve(window.YT) }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.onerror = () => { loading = null; script.remove(); reject(new Error('YouTubeのプレーヤーを読み込めませんでした')) }
    document.head.appendChild(script)
  })
  return loading
}
/** Exposed by the modal player so bookmarks can read the position and jump. */
export interface PlayerHandle { currentTime: () => number | null; seek: (seconds: number) => void }

/** Players on the page; starting one pauses the rest so videos never play at the same time. */
const players = new Set<{ pause: () => void }>()
export function registerPlayer(pause: () => void) {
  const entry = { pause }
  players.add(entry)
  return { pauseOthers: () => { for (const p of players) if (p !== entry) try { p.pause() } catch { /* player already gone */ } }, unregister: () => { players.delete(entry) } }
}
/** For the plain-iframe fallback: commands sent via postMessage (needs enablejsapi=1). */
export function pauseIframe(frame: HTMLIFrameElement | null) {
  frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*')
}
