import Link from "next/link"
import SignupForm from "./_components/SignupForm"
import SiteNav from "./_components/SiteNav"

const SOURCES = ["CallRail", "GA4", "Google Business", "Search Console", "Google Ads / LSA", "Meta Ads", "SEMrush", "Stripe"]

const FEATURES = [
  { k: "∑", h: "One unified schema", p: "Nine sources normalized into one clean shape, plus a cross-source daily rollup: calls, leads, sessions, spend and revenue in a single row per site per day." },
  { k: "✓", h: "Reads you can trust", p: "Every read is present, absent, or error — a failure is never disguised as a zero. A flaky API call can't corrupt stored metrics or wipe your MRR." },
  { k: "⌂", h: "Multi-tenant & encrypted", p: "Per-workspace isolation with an AES-256-GCM credential vault. Every tenant's tokens and keys are encrypted and bound to their org." },
  { k: "⇄", h: "Swap any vendor", p: "SEO, call-tracking and ad platforms sit behind clean ports. Switch SEMrush→Ahrefs or CallRail→Twilio by adding an adapter — callers never change." },
  { k: "→", h: "Export anywhere", p: "Push the rollup to Google Sheets, BigQuery or a signed webhook. The Supermetrics-style wedge, built in." },
  { k: "⟳", h: "Always fresh", p: "Per-source crons keep everything in sync — 30-minute calls, hourly ad spend, daily analytics — with partial-failure guards that self-heal." },
]

const STEPS = [
  { h: "Connect", p: "OAuth into Google & Meta or paste API keys for CallRail, SEMrush and Stripe. Everything is encrypted into your workspace vault." },
  { h: "Map & sync", p: "Auto-discover accounts and match them to your sites by domain. Crons sweep every source and store normalized daily snapshots." },
  { h: "Read or export", p: "Pull per-source metrics or the unified rollup from one tenant-scoped API — or ship it straight to Sheets, BigQuery or a webhook." },
]

const TESTIMONIALS = [
  { q: "We killed three Supermetrics subscriptions and a pile of Zapier glue. One rollup endpoint feeds every client report now.", nm: "Priya Nair", rl: "Founder, NorthLoop Digital", av: "PN", grad: "linear-gradient(135deg,#5b5bd6,#8b5cf6)" },
  { q: "The reliability discipline sold us — a flaky API call never shows up as a fake zero, so our client dashboards stopped lying.", nm: "Marcus Bell", rl: "Head of Analytics, Rivet Media", av: "MB", grad: "linear-gradient(135deg,#0ea5e9,#6366f1)" },
  { q: "Onboarding a new home-services client is 15 minutes now: connect, auto-map by domain, done. Calls, spend and revenue in one view.", nm: "Elena Duarte", rl: "Ops Lead, BrightWork Agency", av: "ED", grad: "linear-gradient(135deg,#16a34a,#0ea5e9)" },
]

const MOCK_BARS = [40, 58, 46, 72, 60, 88, 70, 95, 66, 80, 74, 92]

const LOGOS = ["NorthLoop", "Rivet Media", "BrightWork", "Apex Digital", "Lumen", "Foundry"]

const STATS = [
  { n: "9", l: "Sources unified" },
  { n: "16", l: "Automated syncs" },
  { n: "3", l: "Export destinations" },
  { n: "AES-256", l: "Encrypted at rest" },
]

export default function Home() {
  return (
    <>
      <SiteNav />

      <section className="hero">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow">One API for nine marketing sources</span>
            <h1>
              All your marketing data, <span className="grad">unified and trustworthy</span>.
            </h1>
            <p className="lead">
              Connect CallRail, Google, Meta, SEMrush and Stripe once. Get normalized metrics, a cross-source rollup, and
              one-click export to Sheets, BigQuery or a webhook — multi-tenant and encrypted out of the box.
            </p>
            <div className="cta-row">
              <a className="btn btn-primary" href="#get-started">Get started free</a>
              <a className="btn btn-ghost" href="#features">See how it works</a>
            </div>
            <div className="trust">No headless browsers. No brittle scrapers. Just clean, tenant-scoped APIs.</div>
          </div>

          <div className="hero-mock" aria-hidden>
            <div className="mock">
              <div className="mock-bar">
                <span className="mock-dot" style={{ background: "#ff5f57" }} />
                <span className="mock-dot" style={{ background: "#febc2e" }} />
                <span className="mock-dot" style={{ background: "#28c840" }} />
                <span className="mock-url">app.marketingdatahub.com/dashboard</span>
              </div>
              <div className="mock-body">
                <div className="mock-row">
                  <span className="t">Cross-source rollup</span>
                  <span className="mock-badge">Live data</span>
                </div>
                <div className="mock-kpis">
                  <div className="mock-kpi"><div className="l">Calls</div><div className="v">1,284</div></div>
                  <div className="mock-kpi"><div className="l">Leads</div><div className="v">512</div></div>
                  <div className="mock-kpi"><div className="l">Ad spend</div><div className="v">$9.4k</div></div>
                </div>
                <div className="mock-chart">
                  {MOCK_BARS.map((h, i) => (
                    <span className="b" key={i} style={{ height: `${h}%` }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="logos">
        <div className="container">
          <div className="cap">Trusted by marketing teams at</div>
          <div className="logo-row">
            {LOGOS.map((l) => (
              <span className="logo-word" key={l}>
                <span className="m" aria-hidden />
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="container">
        <div className="stats-bar">
          {STATS.map((s) => (
            <div className="stat" key={s.l}>
              <div className="n">{s.n}</div>
              <div className="l">{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="sources">
        <div className="container">
          <div className="label">Connects to</div>
          <div className="pill-row">
            {SOURCES.map((s) => (
              <span className="pill" key={s}>{s}</span>
            ))}
          </div>
        </div>
      </div>

      <section className="block" id="features">
        <div className="container">
          <div className="section-head">
            <h2>Everything you need to own your marketing data</h2>
            <p>A marketing-focused alternative to Supermetrics and Fivetran — cheaper, opinionated toward campaign and lead data, and built to be resold.</p>
          </div>
          <div className="grid">
            {FEATURES.map((f) => (
              <div className="card" key={f.h}>
                <div className="ic">{f.k}</div>
                <h3>{f.h}</h3>
                <p>{f.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="block soft" id="testimonials">
        <div className="container">
          <div className="section-head">
            <h2>Loved by agencies and in-house teams</h2>
            <p>Marketers who stopped stitching spreadsheets and started shipping reports.</p>
          </div>
          <div className="tst-grid">
            {TESTIMONIALS.map((t) => (
              <div className="tst" key={t.nm}>
                <div className="stars">★★★★★</div>
                <p className="q">&ldquo;{t.q}&rdquo;</p>
                <div className="who">
                  <span className="av" style={{ background: t.grad }}>{t.av}</span>
                  <span>
                    <div className="nm">{t.nm}</div>
                    <div className="rl">{t.rl}</div>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="block" id="how">
        <div className="container">
          <div className="section-head">
            <h2>Live in three steps</h2>
            <p>Signup mints an API key and a workspace. From there it's connect, map, and read.</p>
          </div>
          <div className="steps">
            {STEPS.map((s, i) => (
              <div className="step" key={s.h}>
                <div className="n">{i + 1}</div>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="block soft" id="get-started">
        <div className="container">
          <div className="getstarted">
            <div className="gs-copy">
              <h2>Create your workspace in seconds</h2>
              <p>Sign up and get an API key instantly — no credit card. Connect your first source and pull normalized data the same day.</p>
              <ul className="gs-list">
                <li><span className="check">✓</span> Free to start · upgrade when you connect more sources</li>
                <li><span className="check">✓</span> Encrypted, tenant-scoped credentials from day one</li>
                <li><span className="check">✓</span> One API key unlocks metrics, the rollup, and exports</li>
              </ul>
            </div>
            <SignupForm />
          </div>
        </div>
      </section>

      <section className="block" id="cta">
        <div className="container">
          <div className="cta-band">
            <h2>Ready to unify your marketing data?</h2>
            <p>Create your workspace free and connect your first source in minutes. No credit card required.</p>
            <div className="cta-row" style={{ justifyContent: "center" }}>
              <a className="btn btn-light" href="#get-started">Get started free</a>
              <Link className="btn btn-ghost" href="/dashboard">View live demo</Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="container">
          <div className="footer-grid">
            <div className="footer-brand">
              <div className="brand">
                <span className="brand-mark" aria-hidden />
                Marketing Data Hub
              </div>
              <p>One API for CallRail, Google, Meta, SEMrush and Stripe — normalized, tenant-scoped, and ready to export. Built for agencies and in-house marketing teams.</p>
            </div>
            <div className="footer-col">
              <h4>Product</h4>
              <a href="/#features">Features</a>
              <a href="/#how">How it works</a>
              <Link href="/dashboard">Live demo</Link>
              <Link href="/#get-started">Get started</Link>
            </div>
            <div className="footer-col">
              <h4>Company</h4>
              <a href="mailto:hello@example.com">Contact</a>
              <Link href="/login">Log in</Link>
            </div>
            <div className="footer-col">
              <h4>Legal</h4>
              <Link href="/privacy">Privacy Policy</Link>
              <Link href="/terms">Terms of Service</Link>
            </div>
          </div>
          <div className="footer-bottom">
            <span>© 2026 Marketing Data Hub. All rights reserved.</span>
            <span>Made for marketers who want their data in one place.</span>
          </div>
        </div>
      </footer>
    </>
  )
}
