import type { Book, Category } from './types'

export const categories: Category[] = [
  { id: 'd', name: 'D. 基礎理数' }, { id: 'd1', name: 'D-1: 数学', parent: 'd' }, { id: 'd2', name: 'D-2: 物理', parent: 'd' },
  { id: 'e', name: 'E. 情報・技術' }, { id: 'e1', name: 'E-1: プログラミング', parent: 'e' },
  { id: 'f', name: 'F. 人文・社会' }, { id: 'f1', name: 'F-1: 哲学', parent: 'f' },
]

const cover = (title: string, color: string) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="500"><rect width="360" height="500" fill="${color}"/><rect x="26" y="26" width="308" height="448" rx="5" fill="none" stroke="white" stroke-opacity=".55" stroke-width="3"/><text x="180" y="205" fill="white" font-family="sans-serif" font-size="27" font-weight="700" text-anchor="middle">${title}</text><text x="180" y="255" fill="white" fill-opacity=".75" font-family="sans-serif" font-size="15" text-anchor="middle">MY BOOKS LIBRARY</text></svg>`)}`

export const sampleBooks: Book[] = [
  { id: 'sample-1', title: 'なっとくする物理数学', author: '都筑 卓司', categoryId: 'd1', cover: cover('物理数学', '#cc7832'), baseMonth: '2014-05', status: '読了', memo: '物理で使う数学を直感的に復習。微分方程式の章を再読したい。', links: [{ id: 'l1', type: 'PDF', label: '読書メモ PDF', url: 'https://drive.google.com/' }, { id: 'l2', type: 'NotebookLM', label: 'NotebookLM ノート', url: 'https://notebooklm.google.com/' }], updatedAt: '2026-09-20T09:00:00Z' },
  { id: 'sample-2', title: 'チャート式 代数・幾何', author: '数研出版編集部', categoryId: 'd1', cover: cover('代数・幾何', '#2397b0'), baseMonth: '2014-05', status: '読書中', memo: '例題を中心に進める。現在はベクトルの章。', links: [{ id: 'l3', type: 'PDF', label: '演習ノート', url: 'https://drive.google.com/' }], updatedAt: '2026-09-24T09:00:00Z' },
  { id: 'sample-3', title: 'フーリエ解析 I', author: '森 毅', categoryId: 'd1', cover: cover('フーリエ解析', '#e9a84a'), baseMonth: '2014-05', status: '未読', memo: '信号処理の基礎として読む予定。', links: [], updatedAt: '2026-08-12T09:00:00Z' },
  { id: 'sample-4', title: 'マイペース線形代数', author: '石村 園子', categoryId: 'd1', cover: cover('線形代数', '#2f9ab0'), baseMonth: '2017-11', status: '読了', memo: '行列計算の確認用。', links: [{ id: 'l4', type: 'その他', label: '出版社ページ', url: 'https://www.kyoritsu-pub.co.jp/' }], updatedAt: '2026-05-02T09:00:00Z' },
  { id: 'sample-5', title: 'プログラミングTypeScript', author: 'Boris Cherny', categoryId: 'e1', cover: cover('TypeScript', '#5444a2'), baseMonth: '2024-02', status: '読書中', memo: '型設計のリファレンスとして利用。', links: [{ id: 'l5', type: 'NotebookLM', label: '章ごとの要約', url: 'https://notebooklm.google.com/' }], updatedAt: '2026-09-25T09:00:00Z' },
]
