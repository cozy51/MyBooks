const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const url = process.env.MYBOOKS_TEST_URL || 'http://127.0.0.1:5175'
const book = { id: 'legacy-book', title: 'データとAIの本', author: '既存の著者', categoryId: 'c1', cover: '', baseMonth: '2026-10', status: '読書中', memo: '仕事の未来を分析する', links: [], updatedAt: '2026-10-01T00:00:00Z' }
const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']
const source = id => ({ id, snippet: { title: `動画${ids.indexOf(id) + 1}`, channelTitle: '技術チャンネル', description: '生成AIと仕事を考える概要欄', publishedAt: '2026-10-01T00:00:00Z', thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } } }, contentDetails: { duration: 'PT5M' } })
async function waitServer() { for (let n = 0; n < 100; n++) { try { if ((await fetch(url)).ok) return } catch {} await new Promise(r => setTimeout(r, 100)) } throw new Error('Test server did not start') }
async function main() {
 const service = process.env.MYBOOKS_TEST_URL ? null : spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'tests/vite.config.ts', '--host', '127.0.0.1', '--port', '5175', '--strictPort'], { cwd: process.cwd(), env: { ...process.env, VITE_GOOGLE_CLIENT_ID: 'mybooks-test-client', GOOGLE_CLIENT_ID: 'mybooks-test-client', GEMINI_API_KEY: '', OPENAI_API_KEY: '', GOOGLE_CLIENT_SECRET: '' }, detached: true, stdio: 'ignore' })
 let browser
 try {
  await waitServer()
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] })
  const page = await browser.newPage(); page.setDefaultTimeout(15_000)
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(book => {
   if (!localStorage.getItem('test-initialized')) { localStorage.setItem('mybooks-library-v1', JSON.stringify([book])); localStorage.setItem('mybooks-semantic-search', '0'); localStorage.setItem('test-initialized', '1') }
   window.google = { accounts: { oauth2: { initTokenClient(config) { return { requestAccessToken() { if (config.include_granted_scopes !== false || config.scope.includes('drive.file') && config.scope.includes('youtube.readonly')) throw new Error('OAuth scopes must be isolated'); sessionStorage.setItem('test-token-scope', config.scope); config.callback({ access_token: config.scope.includes('youtube.readonly') ? 'test-youtube-token' : 'test-drive-token', expires_in: 3600, scope: config.scope }) }, get callback() { return config.callback }, set callback(v) { config.callback = v }, set error_callback(v) { config.error_callback = v } } }, revoke() {} } } }
  }, book)
  await page.route('https://accounts.google.com/gsi/client', r => r.fulfill({ body: '', contentType: 'application/javascript' }))
  await page.route('https://i.ytimg.com/**', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#5b21d2"/></svg>' }))
  await page.route('**/api/auth', r => r.fulfill({ status: 501, json: { code: 'not_configured' } }))
  const files = new Map(); let revision = 0
  const modified = () => new Date(Date.UTC(2026, 9, 7, 0, 0, ++revision)).toISOString()
  await page.route('https://www.googleapis.com/drive/**', r => {
   assert.equal(r.request().headers().authorization, 'Bearer test-drive-token'); const u = new URL(r.request().url()); const id = u.pathname.split('/').at(-1)
   if (id !== 'files') { const f = [...files.values()].find(v => v.id === id); return r.fulfill(f ? { json: u.searchParams.has('alt') ? f.data : { id: f.id, modifiedTime: f.modifiedTime, trashed: false, parents: ['12T2RtZHu_lpq8_zVeExmYHiAh_v7cKIW'] } } : { status: 404, json: {} }) }
   const name = u.searchParams.get('q')?.match(/name='([^']+)'/)?.[1]; const f = files.get(name)
   return r.fulfill({ json: { files: f ? [{ id: f.id, modifiedTime: f.modifiedTime }] : [] } })
  })
  await page.route('https://www.googleapis.com/upload/**', r => {
   assert.equal(r.request().headers().authorization, 'Bearer test-drive-token'); const req = r.request(), body = req.postData() || ''
   if (req.method() === 'POST') {
    const name = body.match(/"name":"([^"]+)"/)?.[1]
    const raw = body.match(/name="file"[^]*?\r\n\r\n([^]*?)\r\n--/)?.[1]
    const f = { id: `file-${files.size}`, modifiedTime: modified(), data: raw ? JSON.parse(raw) : {} }; files.set(name, f)
    return r.fulfill({ json: { id: f.id, modifiedTime: f.modifiedTime } })
   }
   const id = new URL(req.url()).pathname.split('/').at(-1); const f = [...files.values()].find(v => v.id === id)
   assert.ok(f, `Unknown Drive file ${id}`); f.data = JSON.parse(body); f.modifiedTime = modified()
   return r.fulfill({ json: { id: f.id, modifiedTime: f.modifiedTime } })
  })
  let youtubeCalls = 0, syncFailure = false
  await page.route('https://www.googleapis.com/youtube/v3/videos?*', r => {
   assert.equal(r.request().headers().authorization, 'Bearer test-youtube-token'); youtubeCalls++
   if (syncFailure) return r.fulfill({ status: 403, json: { error: { errors: [{ reason: 'quotaExceeded' }] } } })
   const next = new URL(r.request().url()).searchParams.has('pageToken')
   return r.fulfill({ json: { items: (next ? [ids[2]] : ids.slice(0, 2)).map(source), ...(next ? {} : { nextPageToken: 'next' }) } })
  })
  let analysisCalls = 0, failBatch = true
  await page.route('**/api/youtube-analyze', r => {
   analysisCalls++; const v = r.request().postDataJSON()
   if (v.videoId === ids[1] && failBatch) return r.fulfill({ status: 429, json: { error: 'AIの利用上限に達しました。少し待って再試行してください。', code: 'rate_limited' } })
   return r.fulfill({ json: { analysis: { summary: `${v.title}のAI要約：概要欄に基づき生成AIと仕事を整理します。`, keyPoints: ['仕事', 'AI', '技術'], category: 'c', subCategory: 'c1', tags: ['AI', '仕事', '生成AI', '技術', '未来'], concreteAbstractScore: 20, technicalSocialScore: 40, recommendedFor: 'AIの仕事への活用を考えたい人', aiComment: '本編は未確認', embeddingText: '生成AIの仕事への活用' } } })
  })
  const embeddingInputs = []
  await page.route('**/api/embed', r => { const b = r.request().postDataJSON(); embeddingInputs.push(b); return r.fulfill({ json: { model: `test:${b.dimensions || 256}`, vectors: b.texts.map((_, i) => [1, (i + 1) / 10, 0.2]) } }) })
  let recommendationInput
  await page.route('**/api/ai-picks', r => { const b = r.request().postDataJSON(); recommendationInput = b; const chosen = [b.books.find(v => v.type === 'book'), b.books.find(v => v.type === 'youtube')].filter(Boolean); return r.fulfill({ json: { picks: chosen.map(v => ({ id: v.id, relevance: 90, reason: 'AIと仕事についての関心に合うため選びました。', themes: [{ interest: '仕事の未来', theme: '生成AI' }], benefits: ['仕事への応用を考える'], evidence: [] })) } }) })
  let interestCalls = 0
  await page.route('**/api/library-interests', r => { interestCalls++; const b = r.request().postDataJSON(); assert.equal(b.books.total, 1); assert.equal(b.youtube.total, 3); return r.fulfill({ json: { analysis: { summary: 'AIと仕事に関心があります。', bookPattern: '本は概念を整理する傾向です。', videoPattern: '動画は技術への応用を選んでいます。', differences: ['本と動画では知識の取り入れ方に違いがあります。'], limitations: 'メタデータと少数のサンプルからの分析です。' } } }) })
  await page.goto(url)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('test-token-scope')), null)
  await page.getByRole('button', { name: 'YouTube', exact: true }).click()
  await page.getByRole('button', { name: 'YouTubeと同期', exact: true }).click()
  await page.getByText(/新規：3件/).waitFor(); assert.equal(youtubeCalls, 2); assert.equal(analysisCalls, 0)
  assert.equal(await page.locator('.video-card').count(), 3)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('mybooks-drive-token')), null, 'YouTube must not connect Drive')
  await page.evaluate(async () => { const drive = await import('/src/drive.ts'); await drive.signIn() })
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('mybooks-youtube-token')).token), 'test-youtube-token')
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('mybooks-drive-token')).token), 'test-drive-token')
  await page.getByRole('button', { name: 'YouTubeと同期', exact: true }).click(); await page.getByText(/新規：0件/).waitFor()
  assert.equal(await page.locator('.video-card').count(), 3)
  syncFailure = true
  await page.getByRole('button', { name: 'YouTubeと同期', exact: true }).click(); await page.getByText(/YouTube APIの利用上限/).waitFor(); assert.equal(await page.locator('.video-card').count(), 3); syncFailure = false
  await page.route('https://www.googleapis.com/youtube/v3/videos?*', r => r.abort()); await page.getByRole('button', { name: 'YouTubeと同期', exact: true }).click(); await page.getByText(/YouTubeに接続できませんでした/).waitFor(); assert.equal(await page.locator('.video-card').count(), 3); await page.unroute('https://www.googleapis.com/youtube/v3/videos?*'); await page.route('https://www.googleapis.com/youtube/v3/videos?*', r => r.fulfill({ json: { items: [] } })); await page.getByRole('button', { name: 'YouTubeと同期', exact: true }).click(); await page.getByText(/高評価した動画がありませんでした/).waitFor(); assert.equal(await page.locator('.video-card').count(), 3)
  await page.getByRole('button', { name: '意味検索', exact: true }).click(); await page.waitForTimeout(1700); assert.equal(embeddingInputs.length, 0, 'Sync with an empty query must not automatically embed videos'); await page.getByRole('button', { name: '意味検索', exact: true }).click()
  await page.getByRole('checkbox', { name: '動画1を選択', exact: true }).check()
  await page.getByRole('button', { name: /選択動画のみ解析/ }).click(); await page.getByText(/AI解析完了：成功 1件/).waitFor(); assert.equal(analysisCalls, 1)
  await page.getByRole('button', { name: /選択動画のみ解析/ }).click(); await page.getByText(/未解析の動画がありません/).waitFor(); assert.equal(analysisCalls, 1)
  const confirmations = []; page.on('dialog', d => { confirmations.push(d.message()); void d.accept() })
  await page.getByRole('button', { name: '未解析動画を一括解析', exact: true }).click(); await page.getByText(/AI解析停止：成功 0件／失敗 1件／未実行 1件/).waitFor(); assert.equal(analysisCalls, 2); assert.match(confirmations[0], /2件/)
  failBatch = false
  await page.getByRole('button', { name: '未解析動画を一括解析', exact: true }).click(); await page.getByText(/AI解析完了：成功 2件/).waitFor(); assert.equal(analysisCalls, 4)
  await page.locator('.video-card h3').first().click(); const detail = page.getByRole('dialog', { name: '動画の詳細' }); await detail.waitFor(); await detail.getByText('重要ポイント', { exact: true }).waitFor(); await detail.getByText('20/100（0：具体、100：抽象）', { exact: true }).waitFor(); await detail.getByRole('button', { name: '閉じる' }).click()
  await page.getByRole('button', { name: 'すべて', exact: true }).click(); assert.equal(await page.locator('.book-card').count(), 4)
  if (process.env.MYBOOKS_SCREENSHOT) await page.screenshot({ path: process.env.MYBOOKS_SCREENSHOT, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile layout overflows viewport'); await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole('button', { name: 'リスト', exact: true }).click(); assert.equal(await page.locator('tbody tr').count(), 4)
  await page.getByRole('button', { name: '意味検索', exact: true }).click()
  await page.getByRole('textbox').first().fill('人間に残る仕事を考えたい')
  await page.getByText(/意味の近い順に表示しています/).waitFor()
  assert.ok(embeddingInputs.some(i => i.task === 'document' && i.texts.some(t => t.includes('技術チャンネル')) && i.texts.some(t => t.includes('既存の著者'))))
  await page.getByRole('button', { name: 'AIセレクト', exact: true }).click(); const recommendation = page.getByRole('dialog', { name: 'AIセレクト' }); await recommendation.locator('textarea').fill('AI時代の仕事を考えたい'); await recommendation.getByRole('button', { name: 'おすすめを選ぶ', exact: true }).click(); await recommendation.getByText('▶ YouTube', { exact: true }).waitFor(); await recommendation.getByText('📕 本', { exact: true }).waitFor(); assert.ok(recommendationInput.books.some(v => v.type === 'book')); assert.ok(recommendationInput.books.some(v => v.type === 'youtube')); await recommendation.getByRole('button', { name: '閉じる' }).click()
  await page.getByRole('textbox').first().fill(''); await page.getByRole('button', { name: 'マップ', exact: true }).click(); try { await page.getByText('4件を配置', { exact: true }).waitFor() } catch (e) { console.error('Browser errors:', errors); console.error(await page.locator('body').innerText({ timeout: 1_000 })); await page.screenshot({ path: '/tmp/mybooks-browser-failure.png', fullPage: true }); throw e } assert.ok(await page.locator('canvas').count())
  console.log('PASS: sync, analysis, search, recommendation and map'); await page.getByRole('button', { name: '興味分析', exact: true }).click(); const interest = page.getByRole('dialog', { name: '興味分析' }); await interest.getByRole('button', { name: 'AIで関心と本・動画の違いを分析', exact: true }).click(); await interest.getByText('AIと仕事に関心があります。', { exact: true }).waitFor(); await interest.getByRole('button', { name: '閉じる' }).click(); await page.getByRole('button', { name: '興味分析', exact: true }).click(); await page.getByText('保存済みのAI分析を表示中', { exact: true }).waitFor(); assert.equal(interestCalls, 1); await page.getByRole('dialog', { name: '興味分析' }).getByRole('button', { name: 'YouTubeだけ', exact: true }).click(); await page.getByText('3件の分類を集計しています。未解析・未分類の動画も件数に含みます。', { exact: true }).waitFor(); await page.getByRole('dialog', { name: '興味分析' }).getByRole('button', { name: '閉じる' }).click()
  await page.getByRole('button', { name: '設定', exact: true }).click(); await page.getByText('AI解析済み：3 / 3', { exact: true }).waitFor(); await page.getByRole('dialog', { name: '設定' }).getByRole('button', { name: '閉じる' }).click()
  try { await page.waitForFunction(() => JSON.parse(localStorage.getItem('mybooks-youtube-drive-v1') || '{}').dirty === false, undefined, { timeout: 15_000 }) } catch (e) { console.error('Drive state', await page.evaluate(() => localStorage.getItem('mybooks-youtube-drive-v1'))); console.error(await page.locator('main').innerText()); throw e }
  assert.equal(files.get('MyBooks-youtube.json').data.videos.length, 3); assert.equal(files.get('MyBooks-library.json').data.books[0].id, book.id)
  await page.reload(); await page.getByRole('button', { name: 'YouTube', exact: true }).click(); await page.getByRole('button', { name: 'カード', exact: true }).click(); assert.equal(await page.locator('.video-card').count(), 3); assert.equal(await page.getByRole('button', { name: 'AI解析済み', exact: true }).count(), 3)
  await page.getByRole('button', { name: '本', exact: true }).click(); assert.equal(await page.locator('.book-card').count(), 1); await page.getByText('データとAIの本', { exact: true }).click(); await page.getByRole('button', { name: '変更を保存', exact: true }).click(); await page.getByRole('button', { name: '本を追加', exact: true }).click(); await page.locator('.fields label').filter({ hasText: /^タイトル/ }).locator('input').fill('既存機能の回帰テスト'); await page.getByRole('button', { name: '本を登録する', exact: true }).click(); await page.getByText('既存機能の回帰テスト', { exact: true }).waitFor()
  await page.locator('.backup-label').click(); const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: /バックアップを書き出す/ }).click(); const backup = JSON.parse(readFileSync(await (await downloaded).path(), 'utf8')); assert.equal(backup.version, 2); assert.equal(backup.videos.length, 3); assert.equal(backup.books.length, 2); assert.ok(backup.books.every(b => b.type === undefined)); await page.locator('input[type=file]').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, books: [book] })) }); await page.waitForFunction(() => JSON.parse(localStorage.getItem('mybooks-library-v1')).length === 1, undefined, { timeout: 15_000 }); assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mybooks-youtube-v1')).length), 3); const invalidAlert = page.waitForEvent('dialog'); await page.locator('input[type=file]').setInputFiles({ name: 'invalid-videos.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 2, books: [], videos: [{ videoId: 'bad' }] })) }); assert.match((await invalidAlert).message(), /形式/); assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mybooks-library-v1')).length), 1)
  const denied = await browser.newPage(); denied.setDefaultTimeout(15_000); await denied.route('**/api/**', r => r.fulfill({ status: 401, json: { error: 'テストでは未接続です' } })); await denied.addInitScript(() => { window.google = { accounts: { oauth2: { initTokenClient(c) { return { requestAccessToken() { c.callback({ access_token: 'test-only', scope: 'https://www.googleapis.com/auth/drive.file' }) }, set callback(v) { c.callback = v }, set error_callback(v) { c.error_callback = v } } } } } } }); await denied.route('https://accounts.google.com/gsi/client', r => r.fulfill({ body: '', contentType: 'application/javascript' })); await denied.route('**/api/auth', r => r.fulfill({ status: 501, json: { code: 'not_configured' } })); await denied.goto(url); await denied.getByRole('button', { name: 'YouTube', exact: true }).click(); await denied.getByRole('button', { name: 'YouTubeと同期', exact: true }).click(); await denied.getByText('必要な権限が許可されませんでした', { exact: true }).waitFor(); await denied.close()
  const codeFlow = await browser.newPage(); codeFlow.setDefaultTimeout(15_000)
  await codeFlow.addInitScript(() => {
   window.google = { accounts: { oauth2: {
    initCodeClient(c) { return { requestCode() { if (c.include_granted_scopes !== false) throw new Error('Combined grants'); sessionStorage.setItem('test-code-scope', c.scope); c.callback({ code: 'test-only-code' }) } } },
    initTokenClient(c) { return { requestAccessToken() { if (c.scope !== 'https://www.googleapis.com/auth/youtube.readonly' || c.include_granted_scopes !== false) throw new Error('Combined YouTube scopes'); sessionStorage.setItem('test-youtube-scope', c.scope); c.callback({ access_token: 'isolated-youtube-token', expires_in: 3600, scope: c.scope }) }, set callback(v) { c.callback = v }, set error_callback(v) { c.error_callback = v } } }
   } } }
  })
  await codeFlow.route('https://accounts.google.com/gsi/client', r => r.fulfill({ body: '', contentType: 'application/javascript' }))
  await codeFlow.route('https://www.googleapis.com/**', r => r.fulfill({ json: { files: [] } }))
  await codeFlow.route('https://www.googleapis.com/youtube/v3/videos?*', r => { assert.equal(r.request().headers().authorization, 'Bearer isolated-youtube-token'); return r.fulfill({ json: { items: [] } }) })
  await codeFlow.route('**/api/**', r => r.fulfill({ status: 401, json: { error: '未接続' } }))
  let exchanges = 0
  await codeFlow.route('**/api/auth', r => {
   if (r.request().postDataJSON().action === 'exchange') { exchanges++; return r.fulfill({ json: { access_token: 'test-code-token', expires_in: 3600, scope: exchanges > 1 ? 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly' : 'https://www.googleapis.com/auth/drive.file' } }) }
   return r.fulfill({ status: 401, json: { code: 'signed_out' } })
  })
  await codeFlow.goto(url)
  await codeFlow.evaluate(async () => { const drive = await import('/src/drive.ts'); await drive.signIn() })
  assert.equal(await codeFlow.evaluate(() => sessionStorage.getItem('test-code-scope')), 'https://www.googleapis.com/auth/drive.file')
  assert.equal(await codeFlow.evaluate(() => sessionStorage.getItem('mybooks-youtube-token')), null)
  await codeFlow.getByRole('button', { name: 'YouTube', exact: true }).click(); await codeFlow.getByRole('button', { name: 'YouTubeと同期', exact: true }).click(); await codeFlow.getByText(/高評価した動画がありませんでした/).waitFor()
  assert.equal(exchanges, 1, 'YouTube must not exchange codes or overwrite the Drive cookie')
  assert.equal(await codeFlow.evaluate(() => JSON.parse(sessionStorage.getItem('mybooks-drive-token')).token), 'test-code-token')
  assert.equal(await codeFlow.evaluate(() => sessionStorage.getItem('test-youtube-scope')), 'https://www.googleapis.com/auth/youtube.readonly')
  await codeFlow.evaluate(async () => { const drive = await import('/src/drive.ts'); await drive.signInForRead() })
  assert.equal(await codeFlow.evaluate(() => sessionStorage.getItem('test-code-scope')), 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly')
  await codeFlow.close()
  assert.deepEqual(errors, [])
  console.log('PASS: OAuth, paginated sync, deduplication, quota error preservation, explicit/selected/batch AI analysis, cost confirmation, stop/retry, details, mixed cards/list, semantic search, balanced recommendation, UMAP, interest cache/scopes, settings, separate Drive persistence, reload, mobile layout, OAuth denial, legacy book creation and backup compatibility')
 } finally { await browser?.close(); if (service) { try { process.kill(-service.pid, 'SIGTERM') } catch {} } }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
