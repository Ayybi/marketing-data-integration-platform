import "./globals.css"

export const metadata = {
  title: "Marketing Data Hub — one API for all your marketing data",
  description:
    "Unify CallRail, GA4, Google Business, Search Console, Google Ads/LSA, Meta, SEMrush and Stripe into one normalized, tenant-scoped API with a cross-source rollup and Sheets/BigQuery/webhook export.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
