"use client"
import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"

// ---------- types + helpers ----------
type RollupDay = { date: string; calls: number; qualifiedLeads: number; sessions: number; conversions: number; gbpViews: number; gbpActions: number; adLeads: number; adSpend: number }
type Kpi = { lab: string; val: string }
type ApiKey = { keyId: string; prefix: string; capabilities: string[]; label?: string; createdAt: string; revokedAt?: string | null }

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86400_000))
const bars = (seed: number) => Array.from({ length: 12 }, (_, i) => Math.round(30 + ((Math.sin((i + seed) * 1.1) + 1) / 2) * 68))
const humanize = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim()
const fmtNum = (v: unknown) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v))

function sampleRollup(from: string, to: string): RollupDay[] {
  const out: RollupDay[] = []
  let i = 0
  for (let t = new Date(from).getTime(); t <= new Date(to).getTime(); t += 86400_000, i++) {
    const w = (Math.sin(i * 1.3) + 1) / 2
    out.push({ date: ymd(new Date(t)), calls: Math.round(8 + w * 12), qualifiedLeads: Math.round(3 + w * 6), sessions: Math.round(120 + w * 110), conversions: Math.round(4 + w * 7), gbpViews: Math.round(200 + w * 160), gbpActions: Math.round(14 + w * 14), adLeads: Math.round(2 + w * 5), adSpend: Math.round((60 + w * 90) * 100) / 100 })
  }
  return out
}

// ---------- per-service demo config ----------
// `connect` = the Connections card id to deep-link to; `needsClient` = also needs a mapped client.
type Service = { id: string; name: string; color: string; ico: string; chart: string; bars: number[]; kpis: Kpi[]; live: (c: string) => string; connect: string; blurb: string; needsClient?: boolean }
const SERVICES: Service[] = [
  { id: "callrail", name: "CallRail", color: "#e8590c", ico: "C", chart: "Calls per day", bars: bars(1), connect: "callrail", needsClient: true, blurb: "Calls, qualified leads, missed calls and durations will appear here once your CallRail account is connected.", live: (c) => `/api/v1/callrail/metrics?client=${encodeURIComponent(c)}`, kpis: [{ lab: "Calls", val: "1,284" }, { lab: "Answered", val: "1,041" }, { lab: "Missed", val: "243" }, { lab: "Qualified leads", val: "512" }, { lab: "First-time callers", val: "388" }, { lab: "Avg duration", val: "3:12" }] },
  { id: "ga4", name: "GA4", color: "#e37400", ico: "G", chart: "Sessions per day", bars: bars(2), connect: "ga4sa", needsClient: true, blurb: "Sessions, users, conversions and channel breakdowns from Google Analytics 4.", live: (c) => `/api/v1/ga4/metrics?client=${encodeURIComponent(c)}`, kpis: [{ lab: "Sessions", val: "18,204" }, { lab: "Users", val: "12,880" }, { lab: "New users", val: "7,410" }, { lab: "Conversions", val: "486" }, { lab: "Engaged sessions", val: "11,900" }, { lab: "Conv. rate", val: "2.7%" }] },
  { id: "gbp", name: "Google Business", color: "#1a73e8", ico: "B", chart: "Views per day", bars: bars(3), connect: "gbiz", needsClient: true, blurb: "Local views, calls, directions, website clicks and reviews from your Google Business Profile.", live: (c) => `/api/v1/gbp/metrics?client=${encodeURIComponent(c)}`, kpis: [{ lab: "Total views", val: "24,300" }, { lab: "Search views", val: "16,100" }, { lab: "Maps views", val: "8,200" }, { lab: "Calls", val: "512" }, { lab: "Directions", val: "388" }, { lab: "Website clicks", val: "640" }] },
  { id: "lsa", name: "Google Ads / LSA", color: "#34a853", ico: "A", chart: "Leads per day", bars: bars(4), connect: "gads", needsClient: true, blurb: "Leads by type, impressions, ad spend and cost-per-lead from Google Local Services Ads.", live: (c) => `/api/v1/lsa/metrics?client=${encodeURIComponent(c)}`, kpis: [{ lab: "Leads", val: "342" }, { lab: "Phone calls", val: "210" }, { lab: "Messages", val: "96" }, { lab: "Bookings", val: "36" }, { lab: "Ad spend", val: "$9,420" }, { lab: "Cost / lead", val: "$27.5" }] },
  { id: "meta", name: "Meta Ads", color: "#0866ff", ico: "M", chart: "Spend per day", bars: bars(5), connect: "meta", needsClient: true, blurb: "Spend, impressions, clicks, leads and cost-per-lead from your Meta ad account.", live: (c) => `/api/v1/meta/metrics?client=${encodeURIComponent(c)}`, kpis: [{ lab: "Spend", val: "$6,140" }, { lab: "Impressions", val: "512k" }, { lab: "Clicks", val: "8,900" }, { lab: "CTR", val: "1.7%" }, { lab: "Leads", val: "214" }, { lab: "Cost / lead", val: "$28.7" }] },
  { id: "semrush", name: "SEMrush", color: "#ff642f", ico: "S", chart: "Organic traffic (est.)", bars: bars(6), connect: "semrush", blurb: "Organic traffic, keyword ranks, backlinks and authority score from SEMrush.", live: (c) => `/api/v1/seo/metrics?domain=${encodeURIComponent(c)}`, kpis: [{ lab: "Organic traffic", val: "42,100" }, { lab: "Keywords", val: "3,210" }, { lab: "Domain rank", val: "84,500" }, { lab: "Backlinks", val: "128k" }, { lab: "Ref. domains", val: "3,400" }, { lab: "Authority", val: "46" }] },
  { id: "gsc", name: "Search Console", color: "#4285f4", ico: "W", chart: "Clicks per day", bars: bars(7), connect: "ga4sa", needsClient: true, blurb: "Clicks, impressions, CTR and average position from Google Search Console.", live: (c) => `/api/v1/gsc/metrics?client=${encodeURIComponent(c)}`, kpis: [{ lab: "Clicks", val: "9,240" }, { lab: "Impressions", val: "410k" }, { lab: "CTR", val: "2.3%" }, { lab: "Avg. position", val: "12.4" }] },
  { id: "stripe", name: "Stripe", color: "#635bff", ico: "$", chart: "Gross volume", bars: bars(8), connect: "stripe", blurb: "MRR, active subscriptions, gross volume and failed payments from Stripe.", live: () => `/api/v1/stripe/metrics?client=all`, kpis: [{ lab: "MRR", val: "$24,800" }, { lab: "Active subs", val: "96" }, { lab: "Gross volume", val: "$58,200" }, { lab: "Failed payments", val: "3" }, { lab: "Churn", val: "1.8%" }, { lab: "ARPU", val: "$258" }] },
]

// ---------- connections config ----------
// `check` = the stored provider name that indicates this card is connected.
type ConnCard = { id: string; title: string; desc: string; kind: "key" | "credential" | "oauth"; provider?: string; service?: string; field: string; textarea?: boolean; json?: boolean; ico: string; color: string; check: string }
const CONNECTIONS: { group: string; cards: ConnCard[] }[] = [
  { group: "API-key sources", cards: [
    { id: "callrail", title: "CallRail", desc: "Paste your CallRail API key.", kind: "key", provider: "callrail", field: "API key", ico: "C", color: "#e8590c", check: "callrail" },
    { id: "semrush", title: "SEMrush", desc: "Paste your SEMrush API key.", kind: "key", provider: "semrush", field: "API key", ico: "S", color: "#ff642f", check: "semrush" },
    { id: "stripe", title: "Stripe", desc: "Paste your Stripe secret key (sk_live_…).", kind: "key", provider: "stripe", field: "Secret key", ico: "$", color: "#635bff", check: "stripe" },
  ] },
  { group: "Google", cards: [
    { id: "ga4sa", title: "GA4 / Search Console", desc: "Paste your service-account JSON. Share your GA4 property + Search Console with its email.", kind: "credential", provider: "ga4_service_account", field: "Service account JSON", textarea: true, json: true, ico: "G", color: "#e37400", check: "ga4_service_account" },
    { id: "gads", title: "Google Ads / LSA", desc: "Connect via OAuth using your Google OAuth app.", kind: "oauth", service: "google_ads", field: "", ico: "A", color: "#34a853", check: "google_ads" },
    { id: "gbiz", title: "Google Business Profile", desc: "Connect via OAuth to pull local performance.", kind: "oauth", service: "google_business", field: "", ico: "B", color: "#1a73e8", check: "google_business" },
  ] },
  { group: "Meta & AI", cards: [
    { id: "meta", title: "Meta Ads", desc: "Connect via OAuth using your Meta app.", kind: "oauth", service: "meta", field: "", ico: "M", color: "#0866ff", check: "facebook" },
    { id: "llm", title: "AI classifier key", desc: "Your LLM key, used to classify call transcriptions.", kind: "credential", provider: "llm", field: "API key", json: true, ico: "AI", color: "#8b5cf6", check: "llm" },
  ] },
  { group: "Advanced — bring your own OAuth apps", cards: [
    { id: "oauth_google_ads", title: "Google OAuth app", desc: "Format: client_id:client_secret", kind: "credential", provider: "oauth_app_google_ads", field: "client_id:client_secret", ico: "⚙", color: "#5b5bd6", check: "oauth_app_google_ads" },
    { id: "oauth_meta", title: "Meta OAuth app", desc: "Format: client_id:client_secret", kind: "credential", provider: "oauth_app_meta", field: "client_id:client_secret", ico: "⚙", color: "#5b5bd6", check: "oauth_app_meta" },
  ] },
]

export default function Dashboard() {
  const router = useRouter()
  const [tab, setTab] = useState("overview")
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [client, setClient] = useState("demo-client")
  const [from, setFrom] = useState(daysAgo(13))
  const [to, setTo] = useState(daysAgo(0))
  const [rows, setRows] = useState<RollupDay[]>(() => sampleRollup(daysAgo(13), daysAgo(0)))
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [live, setLive] = useState<Record<string, Kpi[] | "empty" | "loading">>({})
  const [connMsg, setConnMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [connVal, setConnVal] = useState<Record<string, string>>({})
  const [configured, setConfigured] = useState<string[]>([])
  const [flash, setFlash] = useState<string | null>(null)

  function goConnect(cardId: string) {
    setTab("connections")
    setTimeout(() => {
      document.getElementById(`conn-${cardId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      setFlash(cardId)
      setTimeout(() => setFlash(null), 1700)
    }, 70)
  }
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [newKey, setNewKey] = useState<string | null>(null)

  const loadOverview = useCallback(async (isAuthed: boolean) => {
    if (!isAuthed) {
      setRows(sampleRollup(from, to))
      return
    }
    const r = await fetch(`/api/v1/rollup?client=${encodeURIComponent(client)}&from=${from}&to=${to}`, { credentials: "include" })
    const j = (await r.json().catch(() => ({}))) as { data?: RollupDay[] }
    setRows(j.data ?? [])
    const u = (await fetch("/api/v1/usage", { credentials: "include" }).then((x) => x.json()).catch(() => ({}))) as { usage?: Record<string, number> }
    setUsage(u.usage ?? {})
  }, [client, from, to])

  useEffect(() => {
    void (async () => {
      const me = (await fetch("/api/auth/me", { credentials: "include" }).then((r) => r.json()).catch(() => ({ authenticated: false }))) as { authenticated?: boolean }
      const a = Boolean(me.authenticated)
      setAuthed(a)
      await loadOverview(a)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load a service's live metrics when its tab is opened (authed only).
  useEffect(() => {
    const svc = SERVICES.find((s) => s.id === tab)
    if (!svc || !authed) return
    if (live[svc.id]) return
    setLive((m) => ({ ...m, [svc.id]: "loading" }))
    void (async () => {
      try {
        const r = await fetch(svc.live(client), { credentials: "include" })
        const j = (await r.json().catch(() => ({}))) as { data?: Record<string, unknown> }
        if (r.ok && j.data && typeof j.data === "object") {
          const kpis = Object.entries(j.data).filter(([, v]) => typeof v === "number").map(([k, v]) => ({ lab: humanize(k), val: fmtNum(v) }))
          setLive((m) => ({ ...m, [svc.id]: kpis.length ? kpis : "empty" }))
        } else {
          setLive((m) => ({ ...m, [svc.id]: "empty" }))
        }
      } catch {
        setLive((m) => ({ ...m, [svc.id]: "empty" }))
      }
    })()
  }, [tab, authed, client, live])

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {})
    router.push("/login")
  }

  const loadConnStatus = useCallback(async () => {
    const r = await fetch("/api/connect/status", { credentials: "include" })
    const j = (await r.json().catch(() => ({}))) as { configured?: string[] }
    setConfigured(j.configured ?? [])
  }, [])
  useEffect(() => {
    if (tab === "connections" && authed) void loadConnStatus()
  }, [tab, authed, loadConnStatus])

  async function saveConn(card: ConnCard) {
    const val = (connVal[card.id] ?? "").trim()
    if (card.kind === "oauth") {
      const r = await fetch("/api/connect/oauth/start", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: card.service }) })
      const j = (await r.json().catch(() => ({}))) as { authorizeUrl?: string; error?: string }
      if (r.ok && j.authorizeUrl) window.location.href = j.authorizeUrl
      else setConnMsg((m) => ({ ...m, [card.id]: { ok: false, text: j.error ?? `Failed (HTTP ${r.status})` } }))
      return
    }
    if (!val) {
      setConnMsg((m) => ({ ...m, [card.id]: { ok: false, text: "Enter a value first." } }))
      return
    }
    let path = "/api/connect/credential"
    let payload: Record<string, unknown>
    if (card.kind === "key") {
      path = "/api/connect/key"
      payload = { provider: card.provider, apiKey: val }
    } else if (card.provider === "ga4_service_account") {
      let parsed: unknown
      try {
        parsed = JSON.parse(val)
      } catch {
        setConnMsg((m) => ({ ...m, [card.id]: { ok: false, text: "That isn't valid JSON." } }))
        return
      }
      payload = { provider: card.provider, value: parsed }
    } else if (card.provider === "llm") {
      payload = { provider: "llm", value: { apiKey: val } }
    } else if (card.provider?.startsWith("oauth_app_")) {
      const [client_id, client_secret] = val.split(":")
      if (!client_id || !client_secret) {
        setConnMsg((m) => ({ ...m, [card.id]: { ok: false, text: "Use client_id:client_secret" } }))
        return
      }
      payload = { provider: card.provider, value: { client_id, client_secret } }
    } else {
      payload = { provider: card.provider, value: val }
    }
    const r = await fetch(path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    const j = (await r.json().catch(() => ({}))) as { error?: string }
    setConnMsg((m) => ({ ...m, [card.id]: r.ok ? { ok: true, text: "Saved · encrypted in your vault." } : { ok: false, text: j.error ?? `Failed (HTTP ${r.status})` } }))
    if (r.ok) {
      setConnVal((v) => ({ ...v, [card.id]: "" }))
      void loadConnStatus()
    }
  }

  const loadKeys = useCallback(async () => {
    const r = await fetch("/api/auth/api-keys", { credentials: "include" })
    const j = (await r.json().catch(() => ({}))) as { data?: ApiKey[] }
    setKeys(j.data ?? [])
  }, [])
  async function createKey() {
    const r = await fetch("/api/auth/api-keys", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capabilities: ["read", "write", "admin"], label: "developer key" }) })
    const j = (await r.json().catch(() => ({}))) as { apiKey?: string }
    if (j.apiKey) setNewKey(j.apiKey)
    await loadKeys()
  }
  async function revokeKey(keyId: string) {
    await fetch(`/api/auth/api-keys?keyId=${encodeURIComponent(keyId)}`, { method: "DELETE", credentials: "include" })
    await loadKeys()
  }
  useEffect(() => {
    if (tab === "developer" && authed) void loadKeys()
  }, [tab, authed, loadKeys])

  // ---------- render helpers ----------
  const demo = authed === false
  const sum = (k: keyof RollupDay) => rows.reduce((s, r) => s + (r[k] as number), 0)
  const money = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  const maxCalls = Math.max(1, ...rows.map((r) => r.calls))

  const NavItem = ({ id, label, ico, color }: { id: string; label: string; ico?: string; color?: string }) => (
    <button className={`item${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
      {ico && <span className="ico" style={{ background: color ?? "linear-gradient(135deg,var(--brand),var(--brand-2))" }}>{ico}</span>}
      {label}
    </button>
  )

  const Chart = ({ data, max, label }: { data: number[]; max: number; label: string }) => (
    <div className="panel">
      <h3>{label}</h3>
      <div className="bars">{data.map((h, i) => <div className="bar" key={i} style={{ height: `${(h / max) * 100}%` }} />)}</div>
    </div>
  )
  const Kpis = ({ items }: { items: Kpi[] }) => (
    <div className="kpis">{items.map((k) => <div className="kpi" key={k.lab}><div className="lab">{k.lab}</div><div className="val">{k.val}</div></div>)}</div>
  )

  function ServiceView({ svc }: { svc: Service }) {
    const l = live[svc.id]
    const loading = authed === null || (authed && (l === undefined || l === "loading"))
    const showLive = authed === true && Array.isArray(l)
    const empty = authed === true && l === "empty"
    const badge = demo ? { cls: "badge-sample", t: "Demo preview" } : showLive ? { cls: "badge-live", t: "Live data" } : loading ? { cls: "badge-sample", t: "Loading…" } : { cls: "badge-sample", t: "Not connected" }

    return (
      <>
        <div className="app-top">
          <h1>{svc.name}</h1>
          <span className={`badge ${badge.cls}`}>{badge.t}</span>
        </div>

        {loading ? (
          <div className="panel" style={{ marginTop: 16 }}><span style={{ color: "var(--muted)", fontSize: 14 }}>Loading {svc.name}…</span></div>
        ) : empty ? (
          <div className="empty">
            <span className="empty-ico" style={{ background: svc.color }}>{svc.ico}</span>
            <h2>Connect {svc.name}</h2>
            <p>{svc.blurb}</p>
            <button className="btn btn-primary" onClick={() => goConnect(svc.connect)}>Connect {svc.name}</button>
            {svc.needsClient && <p className="hint">After connecting, map a client so its data shows up here.</p>}
          </div>
        ) : (
          <>
            <Kpis items={showLive ? (l as Kpi[]) : svc.kpis} />
            <Chart data={svc.bars} max={Math.max(...svc.bars)} label={svc.chart} />
          </>
        )}
      </>
    )
  }

  return (
    <div className="app">
      <aside className="side">
        <Link className="brand" href="/dashboard">
          <span className="brand-mark" aria-hidden />
          Marketing Data Hub
        </Link>
        <div className="side-nav">
          <NavItem id="overview" label="Overview" ico="∑" />
          <div className="side-sep">Sources</div>
          {SERVICES.map((s) => <NavItem key={s.id} id={s.id} label={s.name} ico={s.ico} color={s.color} />)}
          <div className="side-sep">Workspace</div>
          <NavItem id="connections" label="Connections" ico="⇄" />
          <NavItem id="developer" label="Developer" ico="{ }" />
        </div>
      </aside>

      <main className="app-main">
        <div className="topbar">
          <span className="who">{authed === null ? "…" : authed ? "Signed in" : "Preview mode"}</span>
          {authed ? <button className="btn btn-ghost btn-sm" onClick={logout}>Log out</button> : <Link className="btn btn-primary btn-sm" href="/login">Log in</Link>}
        </div>
        <div className="app-inner">

        {tab === "overview" && (
          <>
            <div className="app-top">
              <h1>Overview</h1>
              <span className={`badge ${demo ? "badge-sample" : rows.length ? "badge-live" : "badge-sample"}`}>{demo ? "Demo preview" : rows.length ? "Live data" : "No data yet"}</span>
            </div>
            {demo && (
              <div className="panel" style={{ marginTop: 12, background: "#fef9ec", borderColor: "#f6e2b3" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                  <span style={{ color: "#8a6d1f", fontSize: 14 }}><strong>You&apos;re viewing a demo</strong> with sample data. Log in to see your workspace.</span>
                  <Link className="btn btn-primary btn-sm" href="/login">Log in</Link>
                </div>
              </div>
            )}
            <div className="controls">
              <label className="fld"><span>Client id</span><input value={client} onChange={(e) => setClient(e.target.value)} /></label>
              <label className="fld"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="fld"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              <button className="btn btn-primary btn-sm" style={{ height: 40 }} onClick={() => loadOverview(Boolean(authed))}>Load</button>
            </div>
            <div className="kpis">
              {[["Calls", sum("calls").toLocaleString()], ["Qualified leads", sum("qualifiedLeads").toLocaleString()], ["Sessions", sum("sessions").toLocaleString()], ["GBP actions", sum("gbpActions").toLocaleString()], ["Ad leads", sum("adLeads").toLocaleString()], ["Ad spend", money(sum("adSpend"))]].map(([lab, val]) => (
                <div className="kpi" key={lab}><div className="lab">{lab}</div><div className="val">{val}</div></div>
              ))}
            </div>
            <div className="grid-2">
              <div>
                <div className="panel">
                  <h3>Calls per day</h3>
                  {rows.length ? <div className="bars">{rows.map((r) => <div className="bar" key={r.date} style={{ height: `${(r.calls / maxCalls) * 100}%` }} title={`${r.date}: ${r.calls}`} />)}</div> : <p style={{ fontSize: 13.5, color: "var(--muted)" }}>No calls in range.</p>}
                </div>
                <div className="panel">
                  <h3>Daily rollup</h3>
                  <div style={{ overflowX: "auto" }}>
                    <table className="rolltable">
                      <thead><tr><th>Date</th><th className="num">Calls</th><th className="num">Leads</th><th className="num">Sessions</th><th className="num">Ad spend</th></tr></thead>
                      <tbody>
                        {rows.length === 0 ? <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No data for this range.</td></tr> : rows.slice().reverse().map((r) => (
                          <tr key={r.date}><td>{r.date}</td><td className="num">{r.calls}</td><td className="num">{r.qualifiedLeads}</td><td className="num">{r.sessions}</td><td className="num">{money(r.adSpend)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div>
                <div className="panel">
                  <h3>Connected sources</h3>
                  <div className="src-chips">
                    {SERVICES.map((s) => <span className="src-chip" key={s.id}><span className={`dot ${!demo && rows.length ? "dot-on" : "dot-off"}`} />{s.name}</span>)}
                  </div>
                </div>
                <div className="panel">
                  <h3>API usage this month</h3>
                  {Object.keys(usage).length === 0 ? <p style={{ fontSize: 13.5, color: "var(--ink-soft)" }}>No metered reads yet.</p> : (
                    <ul className="activity">{Object.entries(usage).map(([m, n]) => <li key={m}><span>{m}</span><strong>{n.toLocaleString()}</strong></li>)}</ul>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {SERVICES.filter((s) => s.id === tab).map((s) => <ServiceView key={s.id} svc={s} />)}

        {tab === "connections" && (
          <>
            <div className="app-top"><h1>Connections</h1></div>
            <p style={{ color: "var(--ink-soft)", marginTop: 2 }}>Add your own third-party credentials. Everything is <strong>encrypted (AES-256-GCM)</strong> into your workspace vault — never stored in plaintext.</p>
            {!authed && <div className="panel" style={{ marginTop: 12, background: "#fef9ec", borderColor: "#f6e2b3" }}><span style={{ color: "#8a6d1f", fontSize: 14 }}>Log in to save credentials to your workspace.</span></div>}
            {CONNECTIONS.map((grp) => (
              <div key={grp.group} style={{ marginTop: 22 }}>
                <div className="side-sep" style={{ padding: "0 0 10px" }}>{grp.group}</div>
                <div className="conn-grid">
                  {grp.cards.map((c) => {
                    const on = configured.includes(c.check)
                    return (
                      <div className={`conn${on ? " is-on" : ""}${flash === c.id ? " flash" : ""}`} id={`conn-${c.id}`} key={c.id}>
                        <div className="conn-head">
                          <span className="conn-ico" style={{ background: c.color }}>{c.ico}</span>
                          <h4>{c.title}</h4>
                          <span className={`conn-status ${on ? "on" : "off"}`}>
                            <span className="dot" />
                            {on ? "Connected" : "Not connected"}
                          </span>
                        </div>
                        <p className="d">{c.desc}</p>
                        {c.kind !== "oauth" && (c.textarea ? (
                          <textarea placeholder={c.field} value={connVal[c.id] ?? ""} onChange={(e) => setConnVal((v) => ({ ...v, [c.id]: e.target.value }))} />
                        ) : (
                          <input placeholder={c.field} value={connVal[c.id] ?? ""} onChange={(e) => setConnVal((v) => ({ ...v, [c.id]: e.target.value }))} />
                        ))}
                        <button className={`btn btn-sm ${on ? "btn-ghost" : "btn-primary"}`} style={{ width: "100%" }} disabled={!authed} onClick={() => saveConn(c)}>
                          {c.kind === "oauth" ? (on ? "Reconnect" : "Connect") : on ? "Update" : "Save"}
                        </button>
                        {connMsg[c.id] && <p className={connMsg[c.id].ok ? "msg-ok" : "msg-no"}>{connMsg[c.id].text}</p>}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </>
        )}

        {tab === "developer" && (
          <>
            <div className="app-top"><h1>Developer</h1></div>
            <p style={{ color: "var(--ink-soft)", marginTop: 2 }}>API keys authenticate <em>programmatic</em> access to your workspace&apos;s data API (separate from the third-party credentials in Connections). The dashboard itself uses your login session — no key needed.</p>
            {!authed ? (
              <div className="panel" style={{ marginTop: 14 }}><span style={{ color: "var(--ink-soft)", fontSize: 14 }}>Log in to manage API keys.</span></div>
            ) : (
              <div className="panel" style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0 }}>API keys</h3>
                  <button className="btn btn-primary btn-sm" onClick={createKey}>Generate key</button>
                </div>
                {newKey && (
                  <div className="keybox" style={{ marginTop: 12 }}>
                    <code className="mono">{newKey}</code>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(newKey).catch(() => {})}>Copy</button>
                  </div>
                )}
                {newKey && <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Copy this now — it is shown only once.</p>}
                <table className="keylist">
                  <thead><tr><th>Prefix</th><th>Capabilities</th><th>Created</th><th></th></tr></thead>
                  <tbody>
                    {keys.length === 0 ? <tr><td colSpan={4} style={{ color: "var(--muted)" }}>No API keys yet.</td></tr> : keys.map((k) => (
                      <tr key={k.keyId}>
                        <td className="mono">{k.prefix}…</td>
                        <td>{k.capabilities.join(", ")}</td>
                        <td>{k.createdAt.slice(0, 10)}</td>
                        <td>{k.revokedAt ? <span style={{ color: "var(--muted)" }}>revoked</span> : <button className="linklike" onClick={() => revokeKey(k.keyId)}>revoke</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        </div>
      </main>
    </div>
  )
}
