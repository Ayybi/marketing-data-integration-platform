/** @type {import('next').NextConfig} */
const nextConfig = {
  // The connector core uses the Node runtime (mongodb driver, node:crypto) — never Edge.
  serverExternalPackages: ["mongodb", "stripe", "@google-analytics/data", "@google-analytics/admin", "@googleapis/searchconsole", "@googleapis/sheets", "@google-cloud/bigquery", "google-ads-api"],
}

export default nextConfig
