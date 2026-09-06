"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error === "invalid email or password" ? "Invalid email or password." : (data.error ?? `Login failed (HTTP ${res.status}).`))
        return
      }
      // Session cookie is set; go to the dashboard.
      router.push("/dashboard")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <header className="nav">
        <div className="container nav-inner">
          <Link className="brand" href="/">
            <span className="brand-mark" aria-hidden />
            Marketing Data Hub
          </Link>
          <Link className="btn btn-ghost btn-sm" href="/#get-started">Create account</Link>
        </div>
      </header>

      <main className="container" style={{ maxWidth: 460, padding: "64px 24px" }}>
        <form className="card signup-card" style={{ margin: 0, maxWidth: "none" }} onSubmit={submit}>
          <h3>Log in</h3>
          <label className="field">
            <span>Work email</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" />
          </label>
          {error && <p className="form-err">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: "100%" }}>
            {submitting ? "Signing in…" : "Log in"}
          </button>
          <p className="fineprint">
            New here? <Link href="/#get-started" style={{ color: "var(--brand)", fontWeight: 600 }}>Create a workspace</Link>
          </p>
        </form>
      </main>
    </>
  )
}
