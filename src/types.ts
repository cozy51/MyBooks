export type ReadingStatus = '未読' | '読書中' | '読了'
export type LinkType = 'PDF' | 'NotebookLM' | 'その他'

export interface BookLink { id: string; type: LinkType; label: string; url: string }
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
