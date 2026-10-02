import { useMemo, useState, type ReactNode } from 'react'
import { coverSources } from './cover'

export type Zoom = { src: string; alt: string }

export function CoverImage({ src, alt, fallback, width, onZoom }: { src: string; alt: string; fallback: ReactNode; width?: number; onZoom?: (z: Zoom) => void }) {
  const sources = useMemo(() => coverSources(src, width), [src, width])
  const [failed, setFailed] = useState({ src, count: 0 })
  const count = failed.src === src ? failed.count : 0
  if (count >= sources.length) return <>{fallback}</>
  const zoom = onZoom && ((e: React.SyntheticEvent) => { e.stopPropagation(); onZoom({ src, alt }) })
  return <img src={sources[count]} alt={alt} referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed({ src, count: count + 1 })}
    className={zoom ? 'zoomable' : undefined} title={zoom ? 'クリックで拡大' : undefined} onClick={zoom} />
}
