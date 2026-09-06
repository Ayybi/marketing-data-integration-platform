"use client"
import { useEffect, useState } from "react"
import Link from "next/link"

// Auth-aware marketing nav: shows Dashboard/Log out when a session exists, else Log in/Get started.
export default function SiteNav() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.json())
      .then((j: { authenticated?: boolean }) => alive && setAuthed(Boolean(j.authenticated)))
      .catch(() => alive && setAuthed(false))
    return () => {
      alive = false
    }
  }, [])

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {})
    setAuthed(false)
    window.location.href = "/"
  }

  return (
    <header className="nav">
      <div className="container nav-inner">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden />
          Marketing Data Hub
        </Link>
        <nav className="nav-links">
          <a href="/#features">Features</a>
          <a href="/#how">How it works</a>
          <Link href="/dashboard">Live demo</Link>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {authed ? (
            <>
              <Link className="nav-login" href="/dashboard">Dashboard</Link>
              <button className="btn btn-ghost btn-sm" onClick={logout}>Log out</button>
            </>
          ) : (
            <>
              <Link className="nav-login" href="/login">Log in</Link>
              <Link className="btn btn-primary btn-sm" href="/#get-started">Get started</Link>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
