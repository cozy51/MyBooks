// AI選書の API（Vercel Function）。
// ユーザーが文章で書いた「知りたいこと・困っていること」に合う本を、ブラウザが意味検索（Embedding）で絞り込んだ候補の中から選び、
// 選定理由・関連するテーマ・得られそうなことを作る。
// 根拠にするのは、リクエストで渡された MyBooks のデータ（タイトル・著者・分類・要約）だけ。AIが本の内容を推測しないよう、
// 要約からの抜き出し（evidence）は要約に実際に含まれる文だけを残す。
//   PICK_MODEL … モデル名を変えるときだけ設定（既定: gemini-flash-latest / gpt-4.1-mini）
// リクエスト: { query: string, books: { id, title, author, category, summary, similarity? }[] }
// レスポンス: { picks: { id, relevance, reason, themes: { interest, theme }[], benefits: string[], evidence: string[] }[] }
import { authorized, fetchBefore, geminiModels, notConfigured, provider, reply, unauthorized, upstreamFailure, UpstreamError, type Provider } from './_lib.js'

const MAX_QUERY = 1000
const MAX_BOOKS = 20
const MAX_SUMMARY = 1500
const MAX_PICKS = 5
/** 全体の制限時間（Vercelの実行上限60秒より短くし、必ず応答を返す） */
const TIME_LIMIT = 50_000

interface Candidate { id: string; title: string; author: string; category: string; summary: string; similarity?: number }
interface Theme { interest: string; theme: string }
interface Pick { id: string; relevance: number; reason: string; themes: Theme[]; benefits: string[]; evidence: string[] }

const instructions = (query: string, books: Candidate[]) => `あなたは、ユーザー個人の蔵書（MyBooks）から本を選ぶ司書です。
ユーザーが今、知りたいこと・考えたいこと・困っていること・興味を文章で書きました。候補の本の中から、その内容に合う本を選んでください。

# ユーザーの入力
「${query}」

# 候補の本（MyBooks に保存されているデータ。意味の近さ＝ユーザーの入力と本のデータのEmbeddingのコサイン類似度）
${books.map((b, i) => `[${i + 1}] id: ${b.id}
タイトル: ${b.title}
著者: ${b.author || '（未登録）'}
分類: ${b.category || '（未登録）'}
要約: ${b.summary || '（未登録）'}${b.similarity !== undefined ? `\n意味の近さ: ${b.similarity.toFixed(3)}` : ''}`).join('\n\n')}

# 選び方
- 候補の中から、ユーザーの入力に合う本を最大${MAX_PICKS}冊、関連度の高い順に選ぶ。言葉が一致するかではなく、本の内容がユーザーの関心・悩みに応えるかという意味の近さで判断する。
- 関連が薄い本は無理に選ばない（${MAX_PICKS}冊未満になってもよい）。
- 根拠にしてよいのは、上に示したタイトル・著者・分類・要約だけ。あなたがもともと知っているその本の知識や、データに書かれていない内容の推測は使わない。要約が未登録の本は、タイトルと分類から言えることだけを書き、内容を断定しない。

# 各項目の書き方（日本語）
- id: 候補の id をそのまま。
- relevance: 関連度（0〜100の整数）。ユーザーの入力の中心的な関心に、要約の内容が直接応えているほど高くする。
- reason: 選定理由。抽象的な説明（「役立つ本です」など）にせず、ユーザーの入力のどの部分に対して、要約に書かれているどの内容を扱っているから選んだのかを、具体的に1〜2文で書く。
  例:「あなたが入力した『原因と結果を正しく見極めたい』という関心に対して、この本では因果関係と相関関係の違い、因果推論の考え方を扱っているため選定しました。」
- themes: ユーザーの入力内容と、この本のテーマの対応（1〜3個）。interest はユーザーの入力から関心の部分を短く抜き出したもの、theme はタイトル・分類・要約に書かれているこの本のテーマ。
- benefits: この本を読むことで得られそうなこと（1〜3個。各40字程度）。要約に書かれている内容から言えることだけにする。
- evidence: 選定の根拠にした要約の部分を、要約から一字一句そのまま抜き出したもの（1〜3個。各60字以内）。要約が未登録の本は空の配列。`

const PICK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    picks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          relevance: { type: 'INTEGER', description: '関連度（0〜100）' },
          reason: { type: 'STRING', description: '要約の内容を根拠にした具体的な選定理由' },
          themes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { interest: { type: 'STRING' }, theme: { type: 'STRING' } }, required: ['interest', 'theme'] } },
          benefits: { type: 'ARRAY', items: { type: 'STRING' } },
          evidence: { type: 'ARRAY', items: { type: 'STRING' }, description: '要約からそのまま抜き出した根拠の文' },
        },
        required: ['id', 'relevance', 'reason', 'themes', 'benefits', 'evidence'],
      },
    },
  },
  required: ['picks'],
}

async function askGemini(p: Provider, prompt: string): Promise<{ picks?: unknown }> {
  const deadline = Date.now() + TIME_LIMIT
  for (const model of geminiModels(process.env.PICK_MODEL)) {
    try { return await askGeminiModel(p, model, prompt, deadline) } catch (e) {
      if (!(e instanceof UpstreamError && e.status === 404)) throw e
      console.warn(`pick model ${model} is not available`)
    }
  }
  throw new UpstreamError(404, 'no available pick model')
}

async function askGeminiModel(p: Provider, model: string, prompt: string, deadline: number, thinking = true): Promise<{ picks?: unknown }> {
  const res = await fetchBefore(deadline, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        // 渡したデータから選ぶだけなので、考える時間（thinking）は短くして待ち時間を減らす
        ...(thinking && { thinkingConfig: { thinkingLevel: 'low' } }),
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: PICK_SCHEMA,
      },
    }),
  })
  if (!res.ok) {
    const detail = await res.text()
    // thinkingLevel に対応していないモデルでは、指定を外してもう一度
    if (thinking && res.status === 400 && /thinking/i.test(detail)) return askGeminiModel(p, model, prompt, deadline, false)
    throw new UpstreamError(res.status, detail)
  }
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  return JSON.parse(data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') || '{}')
}

async function askOpenAI(p: Provider, prompt: string): Promise<{ picks?: unknown }> {
  const model = process.env.PICK_MODEL?.trim() || 'gpt-4.1-mini'
  const res = await fetchBefore(Date.now() + TIME_LIMIT, 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model, temperature: 0.2, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: `${prompt}\n\n{"picks": [{"id": "...", "relevance": 0, "reason": "...", "themes": [{"interest": "...", "theme": "..."}], "benefits": ["..."], "evidence": ["..."]}]} のJSONだけを返してください。` }],
    }),
  })
  if (!res.ok) throw new UpstreamError(res.status, await res.text())
  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  return JSON.parse(data.choices?.[0]?.message?.content || '{}')
}

const text = (v: unknown, max = 400) => typeof v === 'string' ? v.trim().slice(0, max) : ''
const texts = (v: unknown, count: number, max: number) => Array.isArray(v) ? v.map(x => text(x, max)).filter(Boolean).slice(0, count) : []
/** 抜き出しの照合用に、全角半角・空白・句読点の違いをそろえる */
const compact = (s: string) => s.normalize('NFKC').replace(/[\s「」『』"“”。、，．,.]/g, '')

/** AIの答えを検証して整える（候補に無い本・要約に無い抜き出しは除く） */
function cleanPicks(raw: unknown, books: Candidate[]): Pick[] {
  const byId = new Map(books.map(b => [b.id, b]))
  const seen = new Set<string>()
  const picks: Pick[] = []
  for (const item of Array.isArray(raw) ? raw as Record<string, unknown>[] : []) {
    const book = byId.get(text(item?.id, 100))
    if (!book || seen.has(book.id)) continue
    const reason = text(item.reason, 600)
    if (!reason) continue
    seen.add(book.id)
    const summary = compact(book.summary)
    const evidence = summary ? texts(item.evidence, 3, 200).filter(e => compact(e).length >= 4 && summary.includes(compact(e))) : []
    const themes = (Array.isArray(item.themes) ? item.themes as Record<string, unknown>[] : [])
      .map(t => ({ interest: text(t?.interest, 100), theme: text(t?.theme, 100) })).filter(t => t.interest && t.theme).slice(0, 3)
    const relevance = Math.max(0, Math.min(100, Math.round(Number(item.relevance) || 0)))
    picks.push({ id: book.id, relevance, reason, themes, benefits: texts(item.benefits, 3, 150), evidence })
  }
  return picks.sort((a, b) => b.relevance - a.relevance).slice(0, MAX_PICKS)
}

export async function POST(request: Request): Promise<Response> {
  const p = provider()
  if (!p) return notConfigured()
  if (!await authorized(request)) return unauthorized()

  let body: { query?: unknown; books?: unknown }
  try { body = await request.json() } catch { return reply(400, { error: 'リクエストの形式が正しくありません' }) }
  const query = text(body.query, MAX_QUERY)
  if (!query) return reply(400, { error: '知りたいことを入力してください' })
  const books: Candidate[] = (Array.isArray(body.books) ? body.books as Record<string, unknown>[] : [])
    .map(b => ({ id: text(b?.id, 100), title: text(b?.title, 300), author: text(b?.author, 200), category: text(b?.category, 100), summary: text(b?.summary, MAX_SUMMARY), ...(typeof b?.similarity === 'number' && Number.isFinite(b.similarity) && { similarity: b.similarity }) }))
    .filter(b => b.id && b.title).slice(0, MAX_BOOKS)
  if (!books.length) return reply(400, { error: '候補の本がありません' })

  try {
    const prompt = instructions(query, books)
    const answer = p.name === 'gemini' ? await askGemini(p, prompt) : await askOpenAI(p, prompt)
    return reply(200, { picks: cleanPicks(answer?.picks, books) })
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 504) return reply(504, { error: 'AI選書が時間内に終わりませんでした。もう一度お試しください。', code: 'timeout' })
    if (e instanceof UpstreamError && e.status === 404) return reply(502, { error: 'AI選書に使うAIモデルが見つかりませんでした。環境変数 PICK_MODEL に利用できるモデル名（例: gemini-flash-latest）を設定してください。', code: 'model_unavailable' })
    if (e instanceof SyntaxError) return reply(502, { error: 'AIの答えを読み取れませんでした。もう一度お試しください。', code: 'temporary' })
    return upstreamFailure(e, 'AI選書')
  }
}
