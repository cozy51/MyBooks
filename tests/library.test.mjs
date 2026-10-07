import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-unit-tests', server: { middlewareMode: true, watch: null }, appType: 'custom' })
after(() => server.close())
const library = await server.ssrLoadModule('/src/library.ts')
const search = await server.ssrLoadModule('/src/semanticSearch.ts')
const picks = await server.ssrLoadModule('/src/aiPicks.ts')
const interests = await server.ssrLoadModule('/src/interestAnalysis.ts')
const analyze = await server.ssrLoadModule('/api/youtube-analyze.ts')
const videoText = await server.ssrLoadModule('/src/videoText.ts')
const interestApi = await server.ssrLoadModule('/api/library-interests.ts')
const video = (id = 'aaaaaaaaaaa', extra = {}) => ({ id: `youtube:${id}`, type: 'youtube', videoId: id, title: 'AIと仕事', channelTitle: '技術チャンネル', description: '製造業の生成AI活用', videoUrl: `https://www.youtube.com/watch?v=${id}`, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra })
const book = { id: 'book-1', title: 'AIの本', author: '著者', categoryId: 'c1', cover: '', baseMonth: '', status: '未読', memo: 'データを用いた改善', links: [], updatedAt: '2026-10-01T00:00:00Z' }
const analysis = { summary: 'タイトルと概要欄に基づく整理。生成AIの活用について解説しています。', keyPoints: ['活用', '課題', '改善'], category: 'wrong-parent', subCategory: 'c1', tags: ['AI', '仕事', '技術', '改善', '生成AI'], recommendedFor: '生成AIを使いたい人', concreteAbstractScore: 20, technicalSocialScore: 40 }

test('sync appends only new IDs and preserves saved analyses', () => {
 const old = video(undefined, { summary: '保存した解析', analyzedAt: '2026-10-02' })
 const result = library.appendVideos([old], [video(), video('bbbbbbbbbbb'), video('bbbbbbbbbbb')])
 assert.equal(result.added, 1); assert.equal(result.existing, 2); assert.equal(result.videos.length, 2); assert.equal(result.videos[0], old)
})
test('Drive union keeps local imports and selects the newest remote analysis', () => {
 const a = video(), b = video('bbbbbbbbbbb'), newer = video(undefined, { updatedAt: '2026-10-03', summary: '最新' })
 const merged = library.mergeVideoLibraries([a, b], [newer, video('ccccccccccc')])
 assert.equal(merged.length, 3); assert.equal(merged.find(v => v.videoId === a.videoId).summary, '最新')
})
test('adapters leave legacy book objects unchanged and index video metadata and tags', () => {
 const before = JSON.stringify(book)
 assert.equal(library.bookItem(book).type, 'book'); assert.equal(JSON.stringify(book), before)
 const v = library.videoItem(video(undefined, { summary: '要約', tags: ['未来'], subCategory: 'c1' }))
 assert.match(search.searchText(v), /技術チャンネル/); assert.match(search.searchText(v), /製造業/); assert.match(search.searchText(v), /未来/)
 assert.equal(search.searchText(book), 'AIの本\n著者\nC. IT・ソフトウェア / C-1: プログラミング\nデータを用いた改善')
})
test('backup validation rejects invalid IDs and malformed analysis arrays', () => {
 assert.throws(() => library.validateVideos([video('invalid')]))
 assert.throws(() => library.validateVideos([video(undefined, { tags: {} })]))
 assert.equal(library.validateVideos([video(), video()]).length, 1)
 const safe = library.validateVideos([video(undefined, { videoUrl: 'javascript:alert(1)', thumbnailUrl: 'https://evil.example/x' })])[0]
 assert.match(safe.videoUrl, /^https:\/\/www.youtube.com/); assert.equal(safe.thumbnailUrl, '')
})
test('AI output keeps existing categories and normalizes near-miss fields', () => {
 assert.equal(analyze.cleanAnalysis(analysis).category, 'c')
 for (const patch of [{ subCategory: 'unknown', category: 'unknown' }, { keyPoints: [] }, { summary: '' }]) assert.throws(() => analyze.cleanAnalysis({ ...analysis, ...patch }))
 const loose = analyze.cleanAnalysis({ ...analysis, subCategory: 'F-2: 趣味・実用・教養', concreteAbstractScore: 101, technicalSocialScore: '40', keyPoints: ['one'], tags: [] })
 assert.equal(loose.subCategory, 'f2'); assert.equal(loose.concreteAbstractScore, 100); assert.equal(loose.technicalSocialScore, 40); assert.deepEqual(loose.tags, [])
 assert.equal(analyze.cleanAnalysis({ ...analysis, subCategory: 'F-1' }).subCategory, 'f1')
 assert.equal(analyze.cleanAnalysis({ ...analysis, subCategory: undefined, category: 'f' }).subCategory, 'f1')
 assert.equal(analyze.cleanAnalysis([analysis]).category, 'c')
})
test('video summaries drop the fixed metadata disclaimer', () => {
 assert.equal(videoText.cleanSummary('タイトルと概要欄に基づく整理。本動画は、ロックバンドの解説です。'), '本動画は、ロックバンドの解説です。')
 assert.equal(videoText.cleanSummary('本動画は解説です。タイトルと概要欄に基づく整理'), '本動画は解説です。タイトルと概要欄に基づく整理')
 assert.equal(analyze.cleanAnalysis({ ...analysis, summary: 'タイトルと概要欄に基づく整理。要約本文' }).summary, '要約本文')
 const copied = videoText.videoCopyText({ title: 'T', videoUrl: 'https://www.youtube.com/watch?v=x', summary: 'タイトルと概要欄に基づく整理。S', keyPoints: ['a', 'b'] })
 assert.equal(copied, 'T\n\nhttps://www.youtube.com/watch?v=x\n\nS\n\n重要ポイント\n・a\n・b')
})
test('video durations are shown in Japanese', () => {
 assert.equal(videoText.formatDuration('PT1H2M3S'), '1時間2分')
 assert.equal(videoText.formatDuration('PT28M32S'), '28分32秒')
 assert.equal(videoText.formatDuration('PT45S'), '45秒')
 assert.equal(videoText.formatDuration('P1DT2H'), '26時間0分')
 assert.equal(videoText.formatDuration(''), '')
 assert.equal(videoText.formatDuration('P0D'), '')
})
test('candidate pool retains both media and ranking still includes keyword matches', () => {
 const books = Array.from({ length: 20 }, (_, i) => ({ ...book, id: `book-${i}` }))
 const v = library.videoItem(video())
 const selected = picks.balancedCandidates([...books, v], 15)
 assert.equal(selected.length, 15); assert.ok(selected.includes(v))
 const ranked = search.rankBooks([{ book, haystack: book.title }, { book: v, haystack: v.title }], 'AI', new Map([[book.id, 0.8], [v.id, 0.7]]))
 assert.equal(ranked.length, 2)
})
test('interest percentages use all entries, scopes work, and absent axes stay absent', () => {
 const videos = [video(undefined, { subCategory: 'c1', analyzedAt: '2026-10-02', concreteAbstractScore: 20, technicalSocialScore: 40 }), video('bbbbbbbbbbb')]
 const all = [library.bookItem(book), ...videos.map(library.videoItem)]
 const both = interests.interestSnapshot(all, videos, 'all')
 assert.equal(both.total, 3); assert.equal(both.categories.reduce((s, c) => s + c.count, 0), 3)
 assert.equal(both.videoAxes.count, 1); assert.equal(both.videoAxes.concreteAbstract, 20)
 assert.equal(interests.interestSnapshot(all, videos, 'book').total, 1)
 assert.equal(interests.interestSnapshot(all, videos, 'youtube').total, 2)
 assert.equal(interests.interestSnapshot(all, [], 'all').videoAxes.concreteAbstract, null)
})
test('AI endpoints validate requests and sanitize provider output without real credentials', async t => {
 const previous = Object.fromEntries(['GEMINI_API_KEY', 'OPENAI_API_KEY', 'VITE_GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID'].map(k => [k, process.env[k]]))
 const oldFetch = globalThis.fetch
 t.after(() => { globalThis.fetch = oldFetch; for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
 process.env.GEMINI_API_KEY = 'test-only'; delete process.env.OPENAI_API_KEY; delete process.env.VITE_GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_ID
 const req = data => new Request('http://test/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
 let calls = 0
 globalThis.fetch = async () => { calls++; return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(analysis) }] } }] }) }
 assert.equal((await analyze.POST(req(null))).status, 400)
 assert.equal((await analyze.POST(req({ videoId: 'bad', title: 'test' }))).status, 400); assert.equal(calls, 0)
 const good = await analyze.POST(req({ videoId: 'aaaaaaaaaaa', title: 'test', channelTitle: 'test' }))
 assert.equal(good.status, 200); assert.equal((await good.json()).analysis.category, 'c'); assert.equal(calls, 1)
 globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: '{"summary":"incomplete"}' }] } }] })
 assert.equal((await analyze.POST(req({ videoId: 'aaaaaaaaaaa', title: 'test' }))).status, 502)
 assert.equal((await interestApi.POST(req(null))).status, 400)
 assert.equal((await interestApi.POST(req({ scope: 'all', books: { total: 0 }, youtube: { total: 0 } }))).status, 400)
 process.env.VITE_GOOGLE_CLIENT_ID = 'test-client'
 globalThis.fetch = async () => Response.json({ aud: 'another-client' })
 assert.equal((await analyze.POST(new Request('http://test/api', { method: 'POST', headers: { Authorization: 'Bearer test-only' }, body: JSON.stringify({ videoId: 'aaaaaaaaaaa', title: 'test' }) }))).status, 401)
 delete process.env.GEMINI_API_KEY
 assert.equal((await analyze.POST(req({}))).status, 503)
})

test('book-only AI recommendations preserve the shared video index', async t => {
 const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch })
 const v = library.videoItem(video(undefined, { tags: ['未来'] })), b = library.bookItem(book)
 let requested
 globalThis.fetch = async (url, init) => {
  const data = JSON.parse(init.body)
  if (url === '/api/embed') return Response.json({ model: 'mock:768', vectors: data.texts.map(() => [1, 0.1]) })
  assert.equal(url, '/api/ai-picks'); requested = data
  return Response.json({ picks: [{ id: data.books[0].id, relevance: 90, reason: '関心に合います', themes: [], benefits: [], evidence: [] }] })
 }
 const result = await picks.pickBooks('仕事を考えたい', [b], () => {}, undefined, [b, v])
 assert.equal(result[0].book.id, b.id); assert.equal(requested.books.length, 1)
 assert.ok((await search.currentIndex()).entries[v.id])
 assert.equal((await picks.pickBooks('仕事を考えたい', [v], () => {}, undefined, [b, v]))[0].book.id, v.id)
 assert.ok((await search.currentIndex()).entries[b.id])
})
test('corrupt local video data is reported and is never silently discarded', t => {
 const previous = globalThis.localStorage
 const raw = '{broken-json'
 globalThis.localStorage = { getItem: () => raw }
 t.after(() => { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous })
 assert.throws(() => library.loadVideos(), /元のデータは保持/)
})
