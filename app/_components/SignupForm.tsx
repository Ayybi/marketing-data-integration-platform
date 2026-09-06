"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"

export default function SignupForm() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [orgName, setOrgName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, orgName }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? `Signup failed (HTTP ${res.status}).`)
        return
      }
      // Session cookie is set — go straight to the dashboard.
      router.push("/dashboard")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="card signup-card" onSubmit={submit}>
      <h3>Create your workspace</h3>
      <label className="field">
        <span>Work email</span>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
      </label>
      <label className="field">
        <span>Workspace name</span>
        <input required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Marketing" />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
      </label>
      {error && <p className="form-err">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: "100%" }}>
        {submitting ? "Creating…" : "Start free"}
      </button>
      <p className="fineprint">
        No credit card required · Already have an account?{" "}
        <Link href="/login" style={{ color: "var(--brand)", fontWeight: 600 }}>Log in</Link>
      </p>
    </form>
  )
}
