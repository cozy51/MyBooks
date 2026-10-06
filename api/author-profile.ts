// 著者プロフィール（著者ハブ）の API（Vercel Function）。
// AIが推測だけでプロフィールを作らないよう、次の公開情報を集め、それを根拠にした項目だけを返す。
//   1. Wikipedia（日本語版）の記事と、そのWikidataの項目（生年月日・出身地・職業・専門分野・顔写真）
//   2. Web検索（Gemini の Google検索グラウンディング、または OpenAI の web_search）の結果
//   3. MyBooks に登録されているこの著者の本（タイトル・分類・要約）
// AIの答えの各項目には、根拠にした情報源（Wikipedia・MyBooksの本・検索結果のページ）を付ける。
// どの情報源にも結びつかない項目は、検索結果が1件も無いときは捨て、検索結果があるときは「出典未確認」として返す。
// 同姓同名の別人の情報を混ぜないよう、名前だけでなく MyBooks の著書名・分野（と利用者が入れた手がかり）を組み合わせて検索し、
// 検索結果・Wikipedia・動画のそれぞれについて、著書の著者と同じ人物かを確かめてから使う。
//   AUTHOR_MODEL … モデル名を変えるときだけ設定（既定: gemini-flash-latest / gpt-4.1-mini）
//   YOUTUBE_API_KEY … 設定すると、YouTube Data API で講演・インタビュー・対談の動画を探す（未設定ならYouTubeの検索リンクだけ）
// リクエスト: { name: string, books: { id, title, category, summary }[], hint?: 所属・分野など人物を見分ける手がかり }
import { authorized, fetchBefore, geminiModels, notConfigured, provider, reply, unauthorized, upstreamFailure, UpstreamError, type Provider } from './_lib.js'

/** 全体の制限時間（vercel.json の実行上限60秒より短くし、必ず応答を返す） */
const TIME_LIMIT = 52_000
const MAX_BOOKS = 30
const UA = { 'User-Agent': 'MyBooks/1.0 (author profile; https://github.com/cozy51/MyBooks)' }

type SourceKind = 'wikipedia' | 'wikidata' | 'web' | 'mybooks' | 'youtube'
export interface Source { title: string; url?: string; kind: SourceKind; bookId?: string }
/** sources: Source の番号 / unverified: 検索結果はあるが、この項目に対応する出典を確かめられなかった */
export interface Field { value: string; sources: number[]; unverified?: boolean }
interface Candidate { id: string; title: string; category: string; summary: string }

// ---- Wikipedia / Wikidata ----

interface WikiPage { title: string; url: string; extract: string; thumbnail?: string; wikidata?: string }
interface WikiFacts { birthDate?: string; deathDate?: string; birthPlace?: string; occupation?: string; fields?: string; works: string[]; wikidataUrl: string }

const compact = (s: string) => s.normalize('NFKC').replace(/[\s\u3000]+/g, '')

async function wikiQuery(deadline: number, params: Record<string, string>) {
  const url = `https://ja.wikipedia.org/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`
  const res = await fetchBefore(deadline, url, { headers: UA })
  if (!res.ok) throw new Error(`wikipedia ${res.status}`)
  return await res.json() as { query?: { pages?: { title: string; missing?: boolean; extract?: string; fullurl?: string; thumbnail?: { source: string }; pageprops?: { disambiguation?: string; wikibase_item?: string } }[]; search?: { title: string }[] } }
}

async function wikiPage(deadline: number, title: string): Promise<WikiPage | null> {
  const data = await wikiQuery(deadline, { action: 'query', redirects: '1', titles: title, prop: 'extracts|pageimages|pageprops|info', explaintext: '1', exchars: '2500', piprop: 'thumbnail', pithumbsize: '400', inprop: 'url', ppprop: 'disambiguation|wikibase_item' })
  const page = data.query?.pages?.[0]
  if (!page || page.missing || page.pageprops?.disambiguation !== undefined || !page.extract) return null
  return { title: page.title, url: page.fullurl ?? `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title)}`, extract: page.extract, thumbnail: page.thumbnail?.source, wikidata: page.pageprops?.wikibase_item }
}

/** 著者名のWikipedia記事の候補（同名の記事・「山田学 (技術者)」のような記事） */
async function findWikiPage(deadline: number, name: string): Promise<WikiPage | null> {
  const titles = [...new Set([compact(name), name.trim()])]
  for (const title of titles) {
    try { const page = await wikiPage(deadline, title); if (page) return page } catch { /* 次を試す */ }
  }
  try {
    const data = await wikiQuery(deadline, { action: 'query', list: 'search', srsearch: `intitle:${compact(name)}`, srlimit: '5' })
    const hit = data.query?.search?.find(s => compact(s.title).startsWith(compact(name)))
    if (hit) return await wikiPage(deadline, hit.title)
  } catch { /* 見つからなければ使わない */ }
  return null
}

interface Claim { mainsnak?: { datavalue?: { value?: { id?: string; time?: string; precision?: number } | string } } }
async function wikidataFacts(deadline: number, id: string): Promise<WikiFacts | null> {
  const get = async (params: Record<string, string>) => {
    const res = await fetchBefore(deadline, `https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbgetentities', format: 'json', origin: '*', ...params })}`, { headers: UA })
    if (!res.ok) throw new Error(`wikidata ${res.status}`)
    return await res.json() as { entities?: Record<string, { claims?: Record<string, Claim[]>; labels?: Record<string, { value: string }> }> }
  }
  const claims = (await get({ ids: id, props: 'claims' })).entities?.[id]?.claims ?? {}
  const ids = (p: string) => (claims[p] ?? []).map(c => (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id).filter((v): v is string => Boolean(v))
  const wanted = { place: ids('P19').slice(0, 1), occupation: ids('P106').slice(0, 6), fields: ids('P101').slice(0, 6), works: ids('P800').slice(0, 10) }
  const all = [...new Set(Object.values(wanted).flat())]
  const labels = all.length ? (await get({ ids: all.join('|'), props: 'labels', languages: 'ja|en' })).entities ?? {} : {}
  const label = (q: string) => labels[q]?.labels?.ja?.value ?? labels[q]?.labels?.en?.value
  const names = (qs: string[]) => qs.map(label).filter((v): v is string => Boolean(v))
  // 日付（精度が日・月・年のどれかに合わせて「1947年7月14日」「1947年7月」「1947年」にする）
  const date = (p: string) => {
    const time = claims[p]?.[0]?.mainsnak?.datavalue?.value as { time?: string; precision?: number } | undefined
    const m = time?.time?.match(/^\+?(\d{1,4})-(\d{2})-(\d{2})/)
    if (!m) return undefined
    const precision = time!.precision ?? 11
    return precision >= 11 ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : precision === 10 ? `${Number(m[1])}年${Number(m[2])}月` : `${Number(m[1])}年`
  }
  return { birthDate: date('P569'), deathDate: date('P570'), birthPlace: names(wanted.place)[0], occupation: names(wanted.occupation).join('、') || undefined, fields: names(wanted.fields).join('、') || undefined, works: names(wanted.works), wikidataUrl: `https://www.wikidata.org/wiki/${id}` }
}

// ---- AI（Web検索つき） ----

const FIELD = { type: 'OBJECT', properties: { value: { type: 'STRING' }, refs: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['value', 'refs'] }
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'STRING', enum: ['yes', 'unsure', 'no'], description: 'MyBooksの著書の著者についての公開情報が見つかったか' },
    identityNote: { type: 'STRING' },
    wikipediaIsSamePerson: { type: 'BOOLEAN' },
    birthDate: FIELD, deathDate: FIELD, birthPlace: FIELD, occupation: FIELD, career: FIELD, specialty: FIELD, intro: FIELD,
    perspectives: { type: 'ARRAY', items: FIELD },
    recommendations: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, note: { type: 'STRING' }, refs: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['title', 'note', 'refs'] } },
    links: { type: 'ARRAY', items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, url: { type: 'STRING' } }, required: ['label', 'url'] } },
    videoIds: { type: 'ARRAY', items: { type: 'STRING' }, description: 'MyBooksの著書の著者と同じ人物の動画のid' },
  },
  required: ['found', 'identityNote', 'wikipediaIsSamePerson', 'birthDate', 'deathDate', 'birthPlace', 'occupation', 'career', 'specialty', 'intro', 'perspectives', 'recommendations', 'links', 'videoIds'],
}

const instructions = (name: string, books: Candidate[], wiki: WikiPage | null, topics: string[], hint: string, videos: Video[]) => `あなたは本の著者について、公開情報を調べてまとめる調査担当です。
次の著者について、Web検索で公開情報を調べ、下の資料とあわせてプロフィールをまとめてください。

# 著者
${name}（著書の分野: ${topics.join('・') || '不明'}）${hint ? `\n人物を見分ける手がかり（利用者が入力）: ${hint}` : ''}

# この著者の本として MyBooks に登録されている本（同じ人物かを見分ける手がかり。資料 B1〜）
${books.map((b, i) => `[B${i + 1}] ${b.title}${b.category ? `（分類: ${b.category}）` : ''}${b.summary ? `\n要約: ${b.summary.slice(0, 400)}` : ''}`).join('\n')}

# Wikipediaの記事（資料 W。同名の別人の記事のこともある）
${wiki ? `${wiki.title}\n${wiki.extract.slice(0, 2000)}` : '（見つかりませんでした）'}

# YouTubeの動画の候補（資料 V。名前で検索したもので、同姓同名の別人の動画が多く含まれる）
${videos.length ? videos.map(v => `[${v.id}] ${v.title}（チャンネル: ${v.channel}）${v.description ? ` ${v.description}` : ''}`).join('\n') : '（なし）'}

# 検索のしかた
- 著者名だけで検索しない。同姓同名の別人（スポーツ選手・芸能人など）が上位に出やすいため、必ず「${name} ${books[0]?.title ?? ''}」のように著者名と著書名、または著者名と分野（${topics.join('・') || '著書の分野'}）${hint ? '・手がかり' : ''}を組み合わせて検索する。
- 出版社・書店（Amazonの著者ページなど）・所属先の著者紹介は、本人を見分けやすい情報源として優先する。

# ルール
- 書いてよいのは、Web検索の結果・資料W・資料B に書かれている事実だけ。あなたがもともと知っていることや推測で補わない。確かめられない項目は value を空文字にする。
- 同姓同名の別人の情報を混ぜない。上の MyBooks の本の著者と同じ人物だと確かめられる情報だけを使う。
- 同じ人物かの判断: そのページや資料に、MyBooks の著書名のどれか、または著書の分野（${topics.join('・') || '著書の分野'}）の仕事・活動が書かれているときだけ同じ人物とみなす。名前が同じだけのページは別人として扱い、一切使わない。
- found: 上の基準で同じ人物の公開情報が見つかったら yes、別人かもしれず確信がなければ unsure、見つからなければ no。identityNote にはその判断の理由（同姓同名の別人がいた場合はそのことも）を1文で書く。
- wikipediaIsSamePerson: 資料Wが MyBooks の本の著者と同じ人物の記事なら true（上の基準で判断する。分野が違えば false）。
- refs: その項目の根拠にした資料の記号（"W"・"B1" など）。Web検索の結果を根拠にした場合は refs に入れなくてよい（検索結果は自動で出典として記録される）。
- birthDate（生年月日）・birthPlace（出身地）・occupation（職業）は短く。生年月日は西暦で「1947年7月14日」の形にする（分からない部分は省き「1947年」などにする）。
- deathDate: 亡くなっている場合だけ、没年月日を同じ形で。存命または不明なら空文字。
- career: 経歴（学歴・職歴・主な活動）を2〜4文で。
- specialty: 専門分野を短く。
- intro: 簡単な人物紹介を2文程度で。
- perspectives: 著書や公開インタビュー・講演などから分かる考え方や特徴（2〜4個）。性格を断定しない。「〜を重視している」「〜と述べている」「著書では〜を一貫して扱っている」のように、根拠のある著書・発言に基づく書き方にする。
- recommendations: この著者の代表作・人気作・おすすめの本（最大8冊）。Web上の公開情報（出版社・書店のランキング・書評・Wikipedia など）で確かめられたものだけ。title は書名だけ、note はおすすめの理由（代表作・ロングセラー・受賞など、根拠のある内容）を1文で。
- links: 著者の公式サイト・所属先のプロフィールページ・公式SNSなど、検索結果で確認できたURLだけ（無ければ空の配列）。
- videoIds: 資料Vのうち、題名・チャンネル・説明から MyBooks の著書の著者本人の講演・インタビュー・対談・解説などだと分かる動画の id だけ。分野が違う動画（同姓同名のスポーツ選手・芸能人など）や、本人か分からない動画は入れない。
- 日本語で答える。`

interface AiAnswer {
  found?: string; identityNote?: string; wikipediaIsSamePerson?: boolean
  birthDate?: RawField; deathDate?: RawField; birthPlace?: RawField; occupation?: RawField; career?: RawField; specialty?: RawField; intro?: RawField
  perspectives?: RawField[]; recommendations?: { title?: string; note?: string; refs?: string[] }[]; links?: { label?: string; url?: string }[]; videoIds?: string[]
}
interface RawField { value?: string; refs?: string[] }
/** text: AIの答え（JSON） / citations: 答えの文字範囲と、その根拠になった検索結果 / web: 検索結果のページ */
interface AiResult { text: string; answer: AiAnswer; citations: { start: number; end: number; web: number[] }[]; web: { title: string; url: string }[]; queries: string[] }

function parseJson(text: string): AiAnswer {
  const body = text.match(/\{[\s\S]*\}/)?.[0]
  if (!body) throw new SyntaxError('no json')
  return JSON.parse(body)
}

async function askGemini(p: Provider, prompt: string, deadline: number): Promise<AiResult> {
  for (const model of geminiModels(process.env.AUTHOR_MODEL)) {
    try { return await askGeminiModel(p, model, prompt, deadline, true) } catch (e) {
      if (!(e instanceof UpstreamError && e.status === 404)) throw e
      console.warn(`author model ${model} is not available`)
    }
  }
  throw new UpstreamError(404, 'no available author model')
}

async function askGeminiModel(p: Provider, model: string, prompt: string, deadline: number, structured: boolean): Promise<AiResult> {
  const res = await fetchBefore(deadline, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: structured ? prompt : `${prompt}\n\n次の形のJSONだけを返してください（コードブロックは付けない）。\n${JSON.stringify(SCHEMA)}` }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, ...(structured && { responseMimeType: 'application/json', responseSchema: SCHEMA }) },
    }),
  })
  if (!res.ok) {
    const detail = await res.text()
    // 検索ツールと構造化出力を同時に使えないモデルでは、JSONを文章で返してもらう
    if (structured && res.status === 400) return askGeminiModel(p, model, prompt, deadline, false)
    throw new UpstreamError(res.status, detail)
  }
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri?: string; title?: string } }[]; groundingSupports?: { segment?: { text?: string }; groundingChunkIndices?: number[] }[] } }[] }
  const candidate = data.candidates?.[0]
  const text = candidate?.content?.parts?.map(part => part.text ?? '').join('') ?? ''
  const meta = candidate?.groundingMetadata
  const web = (meta?.groundingChunks ?? []).map(c => ({ title: c.web?.title ?? '', url: c.web?.uri ?? '' }))
  const citations = (meta?.groundingSupports ?? []).flatMap(s => {
    const segment = s.segment?.text
    const start = segment ? text.indexOf(segment) : -1
    return start >= 0 ? [{ start, end: start + segment!.length, web: s.groundingChunkIndices ?? [] }] : []
  })
  return { text, answer: parseJson(text), citations, web, queries: meta?.webSearchQueries ?? [] }
}

async function askOpenAI(p: Provider, prompt: string, deadline: number): Promise<AiResult> {
  const model = process.env.AUTHOR_MODEL?.trim() || 'gpt-4.1-mini'
  const res = await fetchBefore(deadline, 'https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({ model, temperature: 0.2, tools: [{ type: 'web_search' }], input: `${prompt}\n\n次の形のJSONだけを返してください（コードブロックは付けない）。\n${JSON.stringify(SCHEMA)}` }),
  })
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  const data = await res.json() as { output?: { type: string; content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string; start_index?: number; end_index?: number }[] }[] }[] }
  const parts = (data.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? []).filter(c => c.type === 'output_text')
  const text = parts.map(c => c.text ?? '').join('')
  const web: { title: string; url: string }[] = []
  const citations: AiResult['citations'] = []
  let offset = 0
  for (const part of parts) {
    for (const a of part.annotations ?? []) {
      if (a.type !== 'url_citation' || !a.url) continue
      let index = web.findIndex(w => w.url === a.url)
      if (index < 0) { index = web.length; web.push({ title: a.title ?? '', url: a.url }) }
      if (a.start_index !== undefined && a.end_index !== undefined) citations.push({ start: offset + a.start_index, end: offset + a.end_index, web: [index] })
    }
    offset += part.text?.length ?? 0
  }
  return { text, answer: parseJson(text), citations, web, queries: [] }
}

/** Gemini の検索結果のURLは転送用のURLなので、転送先（実際のページ）を調べる */
async function resolveUrl(url: string): Promise<string> {
  if (!/^https:\/\/vertexaisearch\.cloud\.google\.com\//.test(url)) return url
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000), headers: UA })
    const location = res.headers.get('location')
    await res.body?.cancel()
    return location && /^https?:\/\//.test(location) ? location : url
  } catch { return url }
}

// ---- YouTube ----

export interface Video { id: string; title: string; channel: string; publishedAt: string; thumbnail: string; url: string; kind: 'lecture' | 'interview' | 'talk' | 'other'; description?: string }
const VIDEO_KIND: [Video['kind'], RegExp][] = [['lecture', /講演|講義|セミナー|講座|基調|ウェビナー|lecture|keynote|seminar/i], ['interview', /インタビュー|interview|取材|に聞く|語る/i], ['talk', /対談|鼎談|対話|トーク|座談|talk|クロストーク/i]]

/**
 * YouTube の動画の候補。名前だけで探すと同姓同名の別人の動画ばかりになるため、著者名と分野・手がかりの組み合わせでも探す。
 * ここで集めるのは候補だけで、同じ人物かどうかはAIが著書と照らして判断する
 */
async function searchVideos(deadline: number, name: string, topics: string[]): Promise<Video[] | null> {
  const key = process.env.YOUTUBE_API_KEY?.trim()
  if (!key) return null
  const queries = [...topics.slice(0, 2).map(t => `${name} ${t}`), `${name} 講演|インタビュー|対談`]
  const target = compact(name)
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  const results = await Promise.all(queries.map(async q => {
    const res = await fetchBefore(deadline, `https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '15', relevanceLanguage: 'ja', regionCode: 'JP', safeSearch: 'moderate', q, key })}`)
    if (!res.ok) { console.error('youtube search failed', res.status, (await res.text()).slice(0, 200)); return [] }
    const data = await res.json() as { items?: { id?: { videoId?: string }; snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string }; high?: { url?: string } } } }[] }
    return data.items ?? []
  }).map(p => p.catch(() => [])))
  const seen = new Set<string>()
  return results.flat().flatMap(item => {
    const id = item.id?.videoId, s = item.snippet
    if (!id || !s || seen.has(id)) return []
    seen.add(id)
    const title = decode(s.title ?? ''), description = decode(s.description ?? '').replace(/\s+/g, ' ').slice(0, 150)
    // 著者名が動画の題名・説明・チャンネル名に含まれるものだけ（関係のない動画を減らす）
    if (!compact(`${title} ${description} ${s.channelTitle ?? ''}`).includes(target)) return []
    const kind = VIDEO_KIND.find(([, re]) => re.test(`${title} ${description}`))?.[0] ?? 'other'
    return [{ id, title, description, channel: decode(s.channelTitle ?? ''), publishedAt: s.publishedAt ?? '', thumbnail: s.thumbnails?.medium?.url ?? s.thumbnails?.high?.url ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, url: `https://www.youtube.com/watch?v=${id}`, kind }]
  }).slice(0, 30)
}

/** 著書の分野（「A-1: 設計・製図・CAD」→「設計」「製図」…）と利用者の手がかり。検索と同じ人物かの判断に使う */
function topicsOf(books: Candidate[], hint: string): string[] {
  const count = new Map<string, number>()
  for (const b of books) {
    // 子分類の言葉（設計・製図…）を優先し、親分類（機械工学）は少し後ろにする
    const [parent, child] = b.category.includes('/') ? b.category.split('/').map(t => t.trim()) : ['', b.category.trim()]
    const words = [...(child ?? '').replace(/^[A-Z]-\d+\s*[:：]\s*/i, '').split(/[・、,，\s/]+/), parent.replace(/^[A-Z][.．]\s*/i, '')]
    words.forEach((word, i) => { if (word.length >= 2) count.set(word, (count.get(word) ?? 0) + (i === words.length - 1 ? 0.5 : 1)) })
  }
  const words = [...count].sort((a, b) => b[1] - a[1]).map(([w]) => w)
  return [...new Set([...hint.split(/[\s、,，・]+/).filter(w => w.length >= 2), ...words])].slice(0, 4)
}

// ---- まとめる ----

const str = (v: unknown, max = 600) => typeof v === 'string' ? v.replace(/\[([^\]]*)\]\((https?:[^)]+)\)/g, '$1').replace(/\s*\(\s*\[?\d+\]?\s*\)\s*$/, '').trim().slice(0, max) : ''

export async function POST(request: Request): Promise<Response> {
  const p = provider()
  if (!p) return notConfigured()
  if (!await authorized(request)) return unauthorized()

  let body: { name?: unknown; books?: unknown; hint?: unknown }
  try { body = await request.json() } catch { return reply(400, { error: 'リクエストの形式が正しくありません' }) }
  const name = str(body.name, 100).replace(/[\s\u3000]+/g, ' ')
  if (!name) return reply(400, { error: '著者名を指定してください' })
  const books: Candidate[] = (Array.isArray(body.books) ? body.books as Record<string, unknown>[] : [])
    .map(b => ({ id: str(b?.id, 100), title: str(b?.title, 300), category: str(b?.category, 100), summary: str(b?.summary, 800) }))
    .filter(b => b.id && b.title).slice(0, MAX_BOOKS)
  const hint = str(body.hint, 100)
  const topics = topicsOf(books, hint)

  const deadline = Date.now() + TIME_LIMIT
  try {
    const [wiki, videoCandidates] = await Promise.all([findWikiPage(deadline, name).catch(() => null), searchVideos(deadline, name, topics).catch(() => [] as Video[])])
    const prompt = instructions(name, books, wiki, topics, hint, videoCandidates ?? [])
    const ai = p.name === 'gemini' ? await askGemini(p, prompt, deadline) : await askOpenAI(p, prompt, deadline)
    const a = ai.answer
    const found = a.found === 'yes' || a.found === 'unsure' || a.found === 'no' ? a.found : 'unsure'
    // Wikipediaの記事は、AIが同じ人物と判断し、さらに記事に著書名か分野の言葉が書かれているときだけ使う（名前が同じだけの記事を使わない）
    const extract = wiki ? compact(wiki.extract) : ''
    const mentionsWork = books.some(b => compact(b.title).length >= 4 && extract.includes(compact(b.title).slice(0, 8))) || topics.some(t => extract.includes(compact(t)))
    const sameWiki = Boolean(wiki && a.wikipediaIsSamePerson === true && found !== 'no' && mentionsWork)
    const facts = sameWiki && wiki?.wikidata ? await wikidataFacts(deadline, wiki.wikidata).catch(() => null) : null

    // 情報源の一覧（番号で参照する）
    const sources: Source[] = []
    const addSource = (s: Source) => { const i = sources.findIndex(x => x.kind === s.kind && x.url === s.url && x.bookId === s.bookId); if (i >= 0) return i; sources.push(s); return sources.length - 1 }
    const wikiSource = sameWiki ? addSource({ kind: 'wikipedia', title: `Wikipedia「${wiki!.title}」`, url: wiki!.url }) : -1
    const dataSource = facts ? addSource({ kind: 'wikidata', title: 'Wikidata', url: facts.wikidataUrl }) : -1
    const resolved = await Promise.all(ai.web.map(w => resolveUrl(w.url)))
    const webSource = ai.web.map((w, i) => /^https?:\/\//.test(resolved[i]) ? addSource({ kind: 'web', title: w.title || new URL(resolved[i]).hostname, url: resolved[i] }) : -1)
    const bookSource = (i: number) => books[i] ? addSource({ kind: 'mybooks', title: `MyBooks「${books[i].title}」`, bookId: books[i].id }) : -1
    // 同じ人物の公開情報が見つからなかったときは、検索結果は別人のものとみなして使わない
    const trustWeb = found !== 'no'
    const hasWeb = trustWeb && webSource.some(i => i >= 0)

    const refSources = (refs: unknown): number[] => (Array.isArray(refs) ? refs : []).flatMap(r => {
      const ref = String(r).trim().toUpperCase()
      if (ref === 'W') return wikiSource >= 0 ? [wikiSource] : []
      const m = ref.match(/^B(\d+)$/)
      return m ? [bookSource(Number(m[1]) - 1)].filter(i => i >= 0) : []
    })
    /** 答えの中でこの文が書かれている範囲に付いた検索結果 */
    const citedWeb = (value: string): number[] => {
      const escaped = JSON.stringify(value).slice(1, -1)
      const start = ai.text.indexOf(escaped)
      if (start < 0) return []
      const end = start + escaped.length
      if (!trustWeb) return []
      return [...new Set(ai.citations.filter(c => c.start < end && c.end > start).flatMap(c => c.web.map(i => webSource[i])).filter(i => i >= 0))]
    }
    const field = (raw: RawField | undefined, max = 600): Field | null => {
      const value = str(raw?.value, max)
      if (!value) return null
      const src = [...new Set([...refSources(raw?.refs), ...citedWeb(raw?.value ?? '')])]
      if (src.length) return { value, sources: src }
      // どの情報源とも結びつかない項目は推測とみなして捨てる。同じ人物の情報が見つかったときだけ「出典未確認」として残す
      return hasWeb && found === 'yes' ? { value, sources: [], unverified: true } : null
    }
    const fact = (value: string | undefined, fallback: RawField | undefined, max = 200): Field | null => value ? { value, sources: [dataSource] } : field(fallback, max)

    const recommendations = (a.recommendations ?? []).flatMap(r => {
      const f = field({ value: str(r.title, 200), refs: r.refs }, 200)
      if (!f) return []
      const cited = citedWeb(r.note ?? '')
      return [{ title: f.value, note: str(r.note, 300), sources: [...new Set([...f.sources, ...cited])], unverified: f.unverified && !cited.length || undefined }]
    }).slice(0, 8)
    for (const work of facts?.works ?? []) {
      if (!recommendations.some(r => compact(r.title).includes(compact(work)) || compact(work).includes(compact(r.title)))) recommendations.push({ title: work, note: 'Wikidataに主な作品として登録されています。', sources: [dataSource], unverified: undefined })
    }
    // 公式サイトなどのリンクは、検索結果に出てきたサイトのものだけ残す（AIが作ったURLは使わない）
    const hosts = new Set(sources.flatMap(s => { try { return s.url ? [new URL(s.url).hostname.replace(/^www\./, '')] : [] } catch { return [] } }))
    const links = (a.links ?? []).flatMap(l => {
      const url = str(l.url, 500), label = str(l.label, 100)
      try { return label && /^https:\/\//.test(url) && hosts.has(new URL(url).hostname.replace(/^www\./, '')) ? [{ label, url }] : [] } catch { return [] }
    }).slice(0, 8)

    // 動画は、AIが著書の著者本人のものと判断したものだけ
    const picked = new Set((a.videoIds ?? []).map(id => String(id).replace(/^V?\[?|\]$/g, '').trim()))
    const videos = videoCandidates && videoCandidates.filter(v => picked.has(v.id)).sort((x, y) => Number(x.kind === 'other') - Number(y.kind === 'other')).slice(0, 12).map(v => ({ ...v, description: undefined }))

    return reply(200, {
      name,
      found,
      identityNote: str(a.identityNote, 300),
      photo: sameWiki && wiki?.thumbnail ? { url: wiki.thumbnail, source: wikiSource } : null,
      birthDate: fact(facts?.birthDate, a.birthDate),
      deathDate: fact(facts?.deathDate, a.deathDate),
      birthPlace: fact(facts?.birthPlace, a.birthPlace),
      occupation: fact(facts?.occupation, a.occupation),
      specialty: fact(facts?.fields, a.specialty),
      career: field(a.career, 800),
      intro: field(a.intro, 500),
      perspectives: (a.perspectives ?? []).map(f => field(f, 400)).filter(Boolean).slice(0, 5),
      recommendations,
      links,
      videos,
      sources,
      queries: ai.queries.slice(0, 8),
      topics,
      hint,
      fetchedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 504) return reply(504, { error: '著者の情報の検索が時間内に終わりませんでした。もう一度お試しください。', code: 'timeout' })
    if (e instanceof UpstreamError && e.status === 404) return reply(502, { error: '著者プロフィールに使うAIモデルが見つかりませんでした。環境変数 AUTHOR_MODEL に利用できるモデル名（例: gemini-flash-latest）を設定してください。', code: 'model_unavailable' })
    if (e instanceof SyntaxError) return reply(502, { error: 'AIの答えを読み取れませんでした。もう一度お試しください。', code: 'temporary' })
    return upstreamFailure(e, '著者プロフィール')
  }
}
