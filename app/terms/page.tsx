import Link from "next/link"

export const metadata = { title: "Terms of Service — Marketing Data Hub" }

export default function Terms() {
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
        <h1 style={{ letterSpacing: "-0.02em" }}>Terms of Service</h1>
        <p style={{ color: "var(--muted)" }}>Last updated: January 2026</p>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7 }}>
          These Terms govern your use of Marketing Data Hub. This is placeholder copy — replace it with your reviewed legal
          text before launch.
        </p>
        <h2 style={{ marginTop: 28 }}>Using the service</h2>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7 }}>
          You are responsible for the credentials and data you connect and for complying with the terms of each third-party
          provider (Google, Meta, CallRail, SEMrush, Stripe). You retain ownership of your data.
        </p>
        <h2 style={{ marginTop: 28 }}>Availability</h2>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7 }}>
          The service is provided on an &quot;as is&quot; basis. We work to keep syncs reliable, with partial-failure guards that
          preserve your stored data, but we do not guarantee uninterrupted availability.
        </p>
        <h2 style={{ marginTop: 28 }}>Contact</h2>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7 }}>
          Questions? Email <a href="mailto:legal@example.com" style={{ color: "var(--brand)", fontWeight: 600 }}>legal@example.com</a>.
        </p>
      </main>
      <footer className="footer">
        <div className="container">
          <div className="footer-bottom" style={{ paddingTop: 0 }}>
            <span>© 2026 Marketing Data Hub. All rights reserved.</span>
            <Link href="/privacy">Privacy Policy</Link>
          </div>
        </div>
      </footer>
    </>
  )
}
