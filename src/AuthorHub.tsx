import { useEffect, useMemo, useState } from 'react'
import { BookMarked, BookOpen, CircleAlert, ExternalLink, Film, Globe, Info, Link2, LoaderCircle, RefreshCw, Search, Sparkles, Star, UserRound, X } from 'lucide-react'
import { RelatedRow } from './RelatedBooks'
import { booksByAuthor, fetchAuthorProfile, findOwned, loadCachedProfile, type AuthorProfile, type ProfileField, type ProfileSource, type Video } from './authorProfile'
import type { Book } from './types'

type HubTab = 'overview' | 'books' | 'picks' | 'videos' | 'info'
const TABS: [HubTab, string][] = [['overview', '概要'], ['books', '著書'], ['picks', 'おすすめ'], ['videos', '動画'], ['info', '関連情報']]
const VIDEO_KIND: Record<Video['kind'], string> = { lecture: '講演', interview: 'インタビュー', talk: '対談', other: '関連動画' }

/** 著者プロフィール（著者ハブ）。本の詳細画面の右側に開くパネル */
export function AuthorHub({ name, books, currentId, onOpen, onClose }: { name: string; books: Book[]; currentId: string; onOpen: (b: Book) => void; onClose: () => void }) {
  const [tab, setTab] = useState<HubTab>('overview')
  const [profile, setProfile] = useState<AuthorProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const own = useMemo(() => booksByAuthor(name, books), [name, books])

  const refresh = async () => {
    setLoading(true); setError('')
    try { setProfile(await fetchAuthorProfile(name, books)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }
  // 保存済みのプロフィールがあればそれを表示し、無ければ公開情報を検索する
  useEffect(() => {
    let alive = true
    void loadCachedProfile(name).then(saved => {
      if (!alive) return
      if (saved) { setProfile(saved); setLoading(false) } else void refresh()
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])
  useEffect(() => {
    // 本の詳細画面の操作（←→で前後の本へ）より先に受け取り、Escapeでこのパネルだけ閉じる
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const sources = profile?.sources ?? []
  return <div className="author-hub-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <aside className="author-hub" role="dialog" aria-modal="true" aria-labelledby="author-hub-title">
      <div className="author-hub-head">
        <div><p className="eyebrow">AUTHOR PROFILE</p><h2 id="author-hub-title"><UserRound /> {name}</h2></div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる"><X /></button>
      </div>
      <div className="modal-tabs author-hub-tabs" role="tablist">{TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}{id === 'books' && <small>{own.length}</small>}</button>)}</div>
      <div className="author-hub-body">
        {tab !== 'books' && <FetchStatus profile={profile} loading={loading} error={error} onRefresh={() => void refresh()} />}
        {tab === 'overview' && profile && <Overview profile={profile} sources={sources} onSource={() => setTab('info')} />}
        {tab === 'books' && <OwnBooks name={name} own={own} currentId={currentId} onOpen={onOpen} />}
        {tab === 'picks' && profile && <Picks profile={profile} name={name} books={books} sources={sources} onOpen={onOpen} />}
        {tab === 'videos' && profile && <Videos profile={profile} name={name} />}
        {tab === 'info' && profile && <RelatedInfo profile={profile} name={name} onOpen={id => { const b = books.find(x => x.id === id); if (b) onOpen(b) }} />}
        {tab === 'videos' && !profile && !loading && <Videos profile={null} name={name} />}
      </div>
    </aside>
  </div>
}

/** 取得の状態（検索中・失敗・取得日時と更新ボタン） */
function FetchStatus({ profile, loading, error, onRefresh }: { profile: AuthorProfile | null; loading: boolean; error: string; onRefresh: () => void }) {
  if (loading) return <p className="hub-status"><LoaderCircle className="spin" /> Wikipedia・Web上の公開情報を検索しています（20〜40秒ほどかかります）…</p>
  return <>
    {error && <p className="hub-status error"><CircleAlert /> {error}</p>}
    {profile ? <div className="hub-fetched"><span>{new Date(profile.fetchedAt).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} に取得した公開情報です</span><button type="button" onClick={onRefresh}><RefreshCw /> 最新の情報に更新</button></div>
      : !error ? null : <button type="button" className="secondary-btn" onClick={onRefresh}><RefreshCw /> もう一度検索する</button>}
  </>
}

/** 出典の番号（押すと関連情報タブの情報源一覧へ） */
function Cites({ field, sources, onSource }: { field: { sources: number[]; unverified?: boolean }; sources: ProfileSource[]; onSource?: () => void }) {
  if (field.unverified) return <span className="hub-cite unverified" title="Web検索の結果をもとにしていますが、この項目に対応する出典を特定できませんでした">出典未確認</span>
  return <span className="hub-cites">{field.sources.map(i => {
    const s = sources[i]
    if (!s) return null
    const label = s.kind === 'mybooks' ? 'MyBooks' : s.kind === 'wikipedia' ? 'Wikipedia' : s.kind === 'wikidata' ? 'Wikidata' : `${i + 1}`
    return s.url ? <a key={i} className={`hub-cite ${s.kind}`} href={s.url} target="_blank" rel="noreferrer" title={`${s.title}\n${s.url}`}>{label}</a>
      : <button key={i} type="button" className={`hub-cite ${s.kind}`} title={s.title} onClick={onSource}>{label}</button>
  })}</span>
}

function Overview({ profile, sources, onSource }: { profile: AuthorProfile; sources: ProfileSource[]; onSource: () => void }) {
  const facts: [string, ProfileField | null][] = [['生年月日', profile.birthDate], ['出身地', profile.birthPlace], ['職業', profile.occupation], ['専門分野', profile.specialty]]
  const photoSource = profile.photo ? sources[profile.photo.source] : undefined
  const empty = !facts.some(([, f]) => f) && !profile.career && !profile.intro && !profile.perspectives.length
  return <div className="hub-overview">
    <div className="hub-person">
      <div className="hub-photo">{profile.photo ? <img src={profile.photo.url} alt={`${profile.name}の写真`} referrerPolicy="no-referrer" /> : <span aria-hidden="true">{[...profile.name.replace(/\s/g, '')][0]}</span>}</div>
      <div>
        <h3>{profile.name}</h3>
        {profile.occupation && <p className="hub-occupation">{profile.occupation.value}</p>}
        {profile.photo ? photoSource?.url && <a className="hub-photo-credit" href={photoSource.url} target="_blank" rel="noreferrer">写真：{photoSource.title}</a> : <small className="hub-photo-credit">公開されている写真が見つかりませんでした</small>}
      </div>
    </div>
    {profile.found !== 'yes' && <p className="hub-warn"><CircleAlert /> {profile.found === 'no' ? 'この著者についての公開情報は見つかりませんでした。' : '同姓同名の別の人物の情報が含まれている可能性があります。'}{profile.identityNote && ` ${profile.identityNote}`}</p>}
    {empty ? <p className="hub-empty">情報源で確かめられたプロフィールがありません。AIの推測ではプロフィールを作らないため、表示できる項目がありません。</p> : <>
      <dl className="hub-facts">{facts.map(([label, f]) => <div key={label}><dt>{label}</dt><dd>{f ? <>{f.value}<Cites field={f} sources={sources} onSource={onSource} /></> : <span className="hub-none">情報源なし</span>}</dd></div>)}</dl>
      {profile.career && <section className="hub-section"><h4>経歴</h4><p>{profile.career.value}<Cites field={profile.career} sources={sources} onSource={onSource} /></p></section>}
      {profile.intro && <section className="hub-section"><h4>人物紹介</h4><p>{profile.intro.value}<Cites field={profile.intro} sources={sources} onSource={onSource} /></p></section>}
      {profile.perspectives.length > 0 && <section className="hub-section"><h4>著書・発言から見える人物像・考え方</h4>
        <ul className="hub-perspectives">{profile.perspectives.map((f, i) => <li key={i}><Sparkles />{f.value}<Cites field={f} sources={sources} onSource={onSource} /></li>)}</ul>
        <p className="hub-note">性格を断定するものではなく、著書や公開されたインタビュー・講演などから読み取れる考え方の傾向です。</p></section>}
    </>}
    <p className="hub-note"><Info /> プロフィールは、Wikipedia・Web検索で見つかった公開情報・MyBooksの要約だけをもとにAIがまとめています。番号やラベルを押すと情報源を開きます。「出典未確認」の項目は、情報源と照らして確かめてからご利用ください。</p>
  </div>
}

function OwnBooks({ name, own, currentId, onOpen }: { name: string; own: Book[]; currentId: string; onOpen: (b: Book) => void }) {
  if (!own.length) return <p className="related-empty">{name} の本は、MyBooksに登録されていません。</p>
  return <>
    <p className="related-lead"><BookMarked /> MyBooksに登録されている {name} の本（{own.length}冊）</p>
    <ul className="related-list">{own.map(b => <RelatedRow key={b.id} book={b} current={b.id === currentId} onOpen={onOpen} />)}</ul>
  </>
}

function Picks({ profile, name, books, sources, onOpen }: { profile: AuthorProfile; name: string; books: Book[]; sources: ProfileSource[]; onOpen: (b: Book) => void }) {
  const items = profile.recommendations.map(r => ({ ...r, owned: findOwned(r.title, name, books) }))
  if (!items.length) return <p className="related-empty">公開情報から、代表作・おすすめの本を確かめられませんでした。</p>
  const owned = items.filter(i => i.owned).length
  return <>
    <p className="related-lead"><Star /><span>Web上の公開情報から見つかった代表作・人気作・おすすめの本です。MyBooksに<b>{owned}冊</b>所蔵しています（{items.length}冊中）。</span></p>
    <ul className="hub-picks">{items.map((item, i) => <li key={i} className={item.owned ? 'owned' : undefined}>
      <span className={`hub-owned-badge${item.owned ? ' owned' : ''}`}>{item.owned ? '所蔵済み' : '未所蔵'}</span>
      <div className="hub-pick-body">
        <strong>{item.title}</strong>
        {item.note && <p>{item.note}</p>}
        <Cites field={item} sources={sources} />
      </div>
      {item.owned ? <button type="button" className="secondary-btn" onClick={() => onOpen(item.owned!)}><BookOpen /> 開く</button>
        : <a className="ghost-btn" href={`https://www.google.com/search?q=${encodeURIComponent(`${item.title} ${name}`)}`} target="_blank" rel="noreferrer"><Search /> 探す</a>}
    </li>)}</ul>
  </>
}

const youtubeSearch = (q: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`

function Videos({ profile, name }: { profile: AuthorProfile | null; name: string }) {
  const searches = <div className="hub-video-search"><span>YouTubeで探す：</span>{['講演', 'インタビュー', '対談'].map(k => <a key={k} href={youtubeSearch(`${name} ${k}`)} target="_blank" rel="noreferrer"><Film /> {k}</a>)}</div>
  const videos = profile?.videos
  if (!videos) return <>
    <p className="related-empty">{profile ? 'YouTubeの動画を一覧表示するには、サーバーの環境変数 YOUTUBE_API_KEY（YouTube Data API v3 のAPIキー）を設定してください。' : '動画の情報を取得できませんでした。'}下のリンクからYouTubeで検索できます。</p>
    {searches}
  </>
  return <>
    {videos.length ? <>
      <p className="related-lead"><Film /> YouTubeで「{name}」の講演・インタビュー・対談を探した結果です（講演・インタビュー・対談を優先して表示）。同姓同名の別の人物の動画が含まれることがあります。</p>
      <ul className="hub-videos">{videos.map(v => <li key={v.id}><a href={v.url} target="_blank" rel="noreferrer">
        <span className="hub-thumb"><img src={v.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /><span className={`hub-video-kind ${v.kind}`}>{VIDEO_KIND[v.kind]}</span></span>
        <strong>{v.title}</strong>
        <small>{v.channel}{v.publishedAt && ` ・ ${v.publishedAt.slice(0, 10)}`}</small>
      </a></li>)}</ul>
      <p className="hub-note">情報源：YouTube（YouTube Data API の検索結果）</p>
    </> : <p className="related-empty">「{name}」の名前が含まれる講演・インタビュー・対談の動画が見つかりませんでした。</p>}
    {searches}
  </>
}

function RelatedInfo({ profile, name, onOpen }: { profile: AuthorProfile; name: string; onOpen: (bookId: string) => void }) {
  const q = encodeURIComponent(name), compactName = encodeURIComponent(name.replace(/\s+/g, ''))
  const searches = [
    ['Google検索', `https://www.google.com/search?q=${q}`],
    ['Wikipedia', `https://ja.wikipedia.org/w/index.php?search=${compactName}`],
    ['国立国会図書館サーチ', `https://ndlsearch.ndl.go.jp/search?cs=bib&f-creator=${q}`],
    ['CiNii Research', `https://cir.nii.ac.jp/all?q=${q}`],
    ['YouTube', youtubeSearch(name)],
  ]
  return <div className="hub-info">
    {profile.links.length > 0 && <section className="hub-section"><h4><Globe /> 公式サイト・プロフィールページ</h4><ul className="hub-links">{profile.links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer"><ExternalLink />{l.label}<small>{l.url}</small></a></li>)}</ul></section>}
    <section className="hub-section"><h4><Link2 /> 情報源</h4>
      {profile.sources.length ? <ol className="hub-sources">{profile.sources.map((s, i) => <li key={i}><span className={`hub-cite ${s.kind}`}>{s.kind === 'web' ? i + 1 : s.kind === 'mybooks' ? 'MyBooks' : s.kind === 'wikipedia' ? 'Wikipedia' : 'Wikidata'}</span>
        {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}<small>{s.url}</small></a> : <button type="button" onClick={() => s.bookId && onOpen(s.bookId)}>{s.title}<small>MyBooksに登録されている要約</small></button>}
      </li>)}</ol> : <p className="hub-empty">情報源が見つかりませんでした。</p>}
      {profile.queries.length > 0 && <p className="hub-note">Web検索に使った言葉：{profile.queries.join(' ／ ')}</p>}
    </section>
    <section className="hub-section"><h4><Search /> ほかのサイトで調べる</h4><div className="hub-search-links">{searches.map(([label, url]) => <a key={label} href={url} target="_blank" rel="noreferrer"><ExternalLink /> {label}</a>)}</div></section>
  </div>
}
