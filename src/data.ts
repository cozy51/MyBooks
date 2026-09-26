import type { Book, Category } from './types'

export const categories: Category[] = [
  { id: 'a', name: 'A. 機械工学' },
  { id: 'a1', name: 'A-1: 設計・製図・CAD', parent: 'a' },
  { id: 'a2', name: 'A-2: 力学・解析', parent: 'a' },
  { id: 'a3', name: 'A-3: 機械要素・材料', parent: 'a' },
  { id: 'a4', name: 'A-4: 電気・制御', parent: 'a' },
  { id: 'b', name: 'B. 生産・品質管理' },
  { id: 'b1', name: 'B-1: 加工技術・金型', parent: 'b' },
  { id: 'b2', name: 'B-2: 品質・信頼性', parent: 'b' },
  { id: 'b3', name: 'B-3: 生産管理・コスト', parent: 'b' },
  { id: 'c', name: 'C. IT・ソフトウェア' },
  { id: 'c1', name: 'C-1: プログラミング', parent: 'c' },
  { id: 'c2', name: 'C-2: オフィス系アプリ', parent: 'c' },
  { id: 'c3', name: 'C-3: その他アプリ', parent: 'c' },
  { id: 'c4', name: 'C-4: Web・ネットワーク・OS', parent: 'c' },
  { id: 'd', name: 'D. 基礎理数' },
  { id: 'd1', name: 'D-1: 数学', parent: 'd' },
  { id: 'd2', name: 'D-2: 物理・化学', parent: 'd' },
  { id: 'e', name: 'E. 語学' },
  { id: 'e1', name: 'E-1: 英語', parent: 'e' },
  { id: 'e2', name: 'E-2: その他', parent: 'e' },
  { id: 'f', name: 'F. ビジネス・一般' },
  { id: 'f1', name: 'F-1: ビジネススキル・法律', parent: 'f' },
  { id: 'f2', name: 'F-2: 趣味・実用・教養', parent: 'f' },
  { id: 'g', name: 'G. 雑誌・資料' },
  { id: 'g1', name: 'G-1: 定期刊行物', parent: 'g' },
  { id: 'g2', name: 'G-2: 便覧・事典', parent: 'g' },
]

const cover = (title: string, color: string) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="500"><rect width="360" height="500" fill="${color}"/><rect x="26" y="26" width="308" height="448" rx="5" fill="none" stroke="white" stroke-opacity=".55" stroke-width="3"/><text x="180" y="205" fill="white" font-family="sans-serif" font-size="27" font-weight="700" text-anchor="middle">${title}</text><text x="180" y="255" fill="white" fill-opacity=".75" font-family="sans-serif" font-size="15" text-anchor="middle">MY BOOKS LIBRARY</text></svg>`)}`

export const sampleBooks: Book[] = [
  { id: 'sample-1', title: 'なっとくする物理数学', author: '都筑 卓司', categoryId: 'd1', cover: cover('物理数学', '#cc7832'), baseMonth: '2014-05', status: '読了', memo: '物理で使う数学を直感的に復習。微分方程式の章を再読したい。', links: [{ id: 'l1', label: '読書メモ PDF', url: 'https://drive.google.com/' }, { id: 'l2', label: 'NotebookLM ノート', url: 'https://notebooklm.google.com/' }], updatedAt: '2026-09-20T09:00:00Z' },
  { id: 'sample-2', title: 'チャート式 代数・幾何', author: '数研出版編集部', categoryId: 'd1', cover: cover('代数・幾何', '#2397b0'), baseMonth: '2014-05', status: '読書中', memo: '例題を中心に進める。現在はベクトルの章。', links: [{ id: 'l3', label: '演習ノート', url: 'https://drive.google.com/' }], updatedAt: '2026-09-24T09:00:00Z' },
  { id: 'sample-3', title: 'フーリエ解析 I', author: '森 毅', categoryId: 'd1', cover: cover('フーリエ解析', '#e9a84a'), baseMonth: '2014-05', status: '未読', memo: '信号処理の基礎として読む予定。', links: [], updatedAt: '2026-08-12T09:00:00Z' },
  { id: 'sample-4', title: 'マイペース線形代数', author: '石村 園子', categoryId: 'd1', cover: cover('線形代数', '#2f9ab0'), baseMonth: '2017-11', status: '読了', memo: '行列計算の確認用。', links: [{ id: 'l4', label: '出版社ページ', url: 'https://www.kyoritsu-pub.co.jp/' }], updatedAt: '2026-05-02T09:00:00Z' },
  { id: 'sample-5', title: 'プログラミングTypeScript', author: 'Boris Cherny', categoryId: 'c1', cover: cover('TypeScript', '#5444a2'), baseMonth: '2024-02', status: '読書中', memo: '型設計のリファレンスとして利用。', links: [{ id: 'l5', label: '章ごとの要約', url: 'https://notebooklm.google.com/' }], updatedAt: '2026-09-25T09:00:00Z' },
]
