import Link from "next/link"

export const metadata = { title: "Privacy Policy — Marketing Data Hub" }

export default function Privacy() {
  return (
    <>
      <header className="nav">
        <div className="container nav-inner">
          <Link className="brand" href="/">
            <span className="brand-mark" aria-hidden />
            Marketing Data Hub
          </Link>
          <Link className="btn btn-ghost btn-sm" href="/">Back to home</Link>
        </div>
      </header>
      <main className="container" style={{ maxWidth: 760, padding: "48px 24px 80px" }}>
        <h1 style={{ letterSpacing: "-0.02em" }}>Privacy Policy</h1>
        <p style={{ color: "var(--muted)" }}>Last updated: January 2026</p>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7 }}>
          This Privacy Policy explains how Marketing Data Hub (&quot;we&quot;) collects, uses, and protects information when
          you use our service. This is placeholder copy — replace it with your reviewed legal text before launch.
        </p>
        <h2 style={{ marginTop: 28 }}>Information we process</h2>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7 }}>
          We process your account details (email, workspace name) and the third-party marketing data you connect. Connected
          credentials are encrypted at rest with AES-256-GCM and are scoped to your workspace; we never expose them in plaintext.
        </p>
        <h2 style={{ marginTop: 28 }}>How we use data</h2>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7 }}>
          Connected data is used solely to provide the service to your workspace — syncing, normalizing, and exporting your
          own marketing metrics. We do not sell your data.
        </p>
        <h2 style={{ marginTop: 28 }}>Contact</h2>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7 }}>
          Questions? Email <a href="mailto:privacy@example.com" style={{ color: "var(--brand)", fontWeight: 600 }}>privacy@example.com</a>.
        </p>
      </main>
      <footer className="footer">
        <div className="container">
          <div className="footer-bottom" style={{ paddingTop: 0 }}>
            <span>© 2026 Marketing Data Hub. All rights reserved.</span>
            <Link href="/terms">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </>
  )
}
