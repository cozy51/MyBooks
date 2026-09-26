export type ReadingStatus = '未読' | '読書中' | '読了'

/** 関連リンク。label は表示名（インフォグラフィック、音声解説など） */
export interface BookLink { id: string; label: string; url: string }
export interface Category { id: string; name: string; parent?: string }
export interface Book {
  id: string
  title: string
  author: string
  categoryId: string
  cover: string
  baseMonth: string
  status: ReadingStatus
  memo: string
  links: BookLink[]
  updatedAt: string
}
