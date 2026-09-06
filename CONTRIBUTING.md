# Contributing to Marketing Data Hub

Thanks for your interest in improving Marketing Data Hub! This project is a self-hostable, unified
marketing-data API, and contributions of every size are welcome — a typo fix, a new connector, a bug
report, or a docs improvement.

Please read this guide before opening a pull request.

---

## Code of Conduct

Be kind, be constructive, assume good faith. Harassment or disrespect toward other contributors is not
tolerated. Report concerns to the maintainers via a private issue or email.

---

## Getting set up

You'll need **Node.js 20.19+** and **MongoDB** (a local `mongod` on `127.0.0.1:27017` is enough for
tests, which run without any external network access).

```bash
git clone <your-fork-url> marketing-data-hub
cd marketing-data-hub
npm install
cp .env.example .env.local          # fill in MONGODB_URI + INTEGRATION_VAULT_KEY
npm run db:init                     # create collections + indexes
npm run dev                         # http://localhost:3000
```

See the [README](./README.md#-quick-start) for the full quick-start and configuration table.

---

## Development workflow

1. **Fork** the repo and create a branch off `main`:
   ```bash
   git checkout -b feat/ahrefs-seo-adapter
   ```
   Use a descriptive prefix: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, or `chore/`.

2. **Make your change.** Match the surrounding code — naming, comment density, and idioms. This project
   is TypeScript in `strict` mode; there are no `any` escape hatches in the core.

3. **Keep the build green before you push:**
   ```bash
   npm run typecheck    # tsc --noEmit (strict)
   npm test             # vitest — the full suite must pass
   npm run build        # production build must succeed
   ```
   CI runs all three on every pull request (see `.github/workflows/ci.yml`). A PR won't be merged until
   they're green.

4. **Open a pull request** against `main` with a clear title and description of *what* changed and
   *why*. Link any related issue. If it's a UI change, attach a screenshot or GIF.

---

## The non-negotiables

These are the invariants that make this project trustworthy. A PR that breaks one will be asked to
change before review can continue.

### 1. Three-state reads — never a fake zero

Every metric read returns one of three states, never conflating them:

- `present` → real data (`200 {data}`)
- `absent` → authoritatively nothing (`404 {error:"not_connected"}`)
- `error` → we couldn't find out (`502 {error}`)

A failed API call must **never** be reported as a `0`. A capability a vendor lacks returns
`unsupported_capability:<name>`, not a fabricated value. This is the whole point of the product — guard
it fiercely.

### 2. Tenant isolation

Every database query is scoped through `repos(orgId)`. There is no code path that reads across
workspaces. Never introduce a query that isn't `orgId`-scoped.

### 3. Secrets stay server-side

Credentials are AES-256-GCM encrypted in the vault and decrypted server-side only. API keys and session
tokens are stored as irreversible SHA-256 hashes. **Never** return a secret to the client, log it, or
commit it. Real secrets live only in `.env.local` (gitignored) — `.env` and `.env.example` contain
placeholders only.

### 4. Ports & adapters

New vendors go behind the existing ports — don't special-case them in routes or callers. See below.

---

## Adding a connector / vendor

The ports make most vendor additions a **single-file** change. To add a new SEO vendor, for example:

1. Create `src/lib/seo/<vendor>-provider.ts` implementing the `SeoProvider` port. Map the vendor's
   fields into the normalized types (`SeoDomainOverview` / `SeoBacklinks` / `SeoKeyword`) and its
   metering into `quota()`.
2. Add a `case` for it in `src/lib/seo/index.ts`.
3. Declare its `capabilities` honestly — a vendor without backlinks returns
   `unsupported_capability:backlinks`, never a fake zero.
4. Add tests using a fake fetcher (no live network — see existing `test/seo-provider.test.ts`).

Routes, callers, and existing tests should **not** need to change. The same pattern applies to
call-tracking (`CallTrackingProvider`), paid-ads platforms (`PaidAdsProvider`), destinations, and the
LLM layer. See [`WIRING.md`](./WIRING.md) for the full extension guide.

---

## Testing

- Tests live in `test/` and run on **Vitest**. The deterministic core (normalization, retry discipline,
  three-state reads, quota metering) is covered with **injectable fakes** — tests need no external
  credentials and make no network calls.
- Add tests for any new logic. Bug fixes should include a regression test that fails before the fix.
- Run the full suite (`npm test`) before pushing — don't rely only on the tests near your change.

---

## Commit & PR conventions

- Write commits in the imperative mood: "Add Ahrefs SEO adapter", not "Added" or "Adds".
- Keep PRs focused — one logical change per PR is much easier to review than a grab-bag.
- Update the README / `WIRING.md` if you change behavior, add a route, or add a config variable.

---

## Reporting bugs & requesting features

Open an issue with:

- **Bugs:** what you did, what you expected, what happened, and the exact error. Include the source
  connector and whether it was a live or demo read. **Never paste real credentials or tokens.**
- **Features:** the problem you're trying to solve, not just the solution you have in mind.

Thanks for contributing! ⭐
