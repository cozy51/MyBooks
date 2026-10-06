import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** 小さなコピーボタン（読み上げアプリなどに貼り付けるため、文章だけをクリップボードにコピーする） */
export function CopyButton({ text, label = 'コピー', title }: { text: string; label?: string; title?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { alert('コピーできませんでした') }
  }
  return <button type="button" className={`copy-summary copy-mini${copied ? ' copied' : ''}`} onClick={copy} onKeyDown={e => e.stopPropagation()} title={copied ? 'コピーしました' : title ?? `${label}`} aria-label={title ?? label}>{copied ? <Check /> : <Copy />}{copied ? 'コピーしました' : label}</button>
}
