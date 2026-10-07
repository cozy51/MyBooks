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

export type LibraryItemType = 'book' | 'youtube'
export interface VideoBookmark { id: string; time: number; note: string; createdAt: string }
export interface YouTubeVideo {
  id: string
  type: 'youtube'
  videoId: string
  title: string
  channelTitle: string
  channelId?: string
  description?: string
  thumbnailUrl?: string
  videoUrl: string
  publishedAt?: string
  duration?: string
  summary?: string
  keyPoints?: string[]
  category?: string
  subCategory?: string
  tags?: string[]
  concreteAbstractScore?: number
  technicalSocialScore?: number
  recommendedFor?: string
  aiComment?: string
  embeddingText?: string
  /** Future optional input; captions are never required or scraped. */
  transcript?: string
  analyzedAt?: string
  /** Time-stamped notes the user adds while watching. */
  bookmarks?: VideoBookmark[]
  /** Set when the like was removed from this app; hidden from the library but kept so Drive merges don't revive it. */
  unlikedAt?: string
  createdAt: string
  updatedAt: string
}
/** Read-only adapter for existing search, recommendations and UMAP. Never persist as Book. */
export interface LibraryItem extends Book {
  type: LibraryItemType
  tags?: string[]
  description?: string
  embeddingText?: string
}
