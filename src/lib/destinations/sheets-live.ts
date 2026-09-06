// LIVE WIRING for the Sheets destination — builds a SheetsAppendFn over @googleapis/sheets using the
// GA4 service account (scope spreadsheets). The target spreadsheet must be shared with the service
// account email. This is the only module that imports the Sheets SDK; it is dynamic-imported by the
// registry so tests never load it.
import { sheets, auth as sheetsAuth } from "@googleapis/sheets"
import { resolveGa4ServiceAccount } from "../ga4"
import { DestinationNotConfigured } from "./types"
import type { SheetsAppendFn } from "./sheets"

export function buildSheetsAppender(): SheetsAppendFn {
  const keyFilename = process.env.GA4_SERVICE_ACCOUNT_PATH
  const sa = resolveGa4ServiceAccount()
  if (!keyFilename && sa.status === "absent") throw new DestinationNotConfigured("sheets (no service account)")
  if (sa.status === "error") throw new Error(`sheets service account unparseable: ${sa.error}`)
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"]
  const creds = sa.status === "present" ? (sa.value as { client_email?: string; private_key?: string }) : undefined
  const googleAuth = keyFilename
    ? new sheetsAuth.GoogleAuth({ keyFile: keyFilename, scopes })
    : new sheetsAuth.GoogleAuth({ credentials: { client_email: creds?.client_email, private_key: creds?.private_key }, scopes })
  const client = sheets({ version: "v4", auth: googleAuth as never })

  return async ({ spreadsheetId, range, values }) => {
    const res = await client.spreadsheets.values.append({ spreadsheetId, range, valueInputOption: "RAW", requestBody: { values } })
    return { updatedRows: res.data.updates?.updatedRows ?? undefined }
  }
}
