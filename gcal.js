/**
 * gcal.js — Google Calendar integration
 *
 * Handles OAuth2 token storage and calendar event creation.
 * The bot calls createEvent() when it sees { type: "calendar" } in the outbox.
 *
 * SETUP (one-time):
 *   node gcal.js setup
 * This opens a browser auth URL. Paste the code back to store the token.
 *
 * Token is stored in gcal_token.json (gitignored).
 * Client credentials should be in .env:
 *   GCAL_CLIENT_ID=...
 *   GCAL_CLIENT_SECRET=...
 *   GCAL_REDIRECT_URI=urn:ietf:wg:oauth:2.0:oob
 */

import { google } from 'googleapis'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

const __dirname    = path.dirname(fileURLToPath(import.meta.url))
const TOKEN_PATH   = path.join(__dirname, 'gcal_token.json')
const CALENDAR_ID  = process.env.GCAL_CALENDAR_ID || 'soheliadeep@gmail.com'
const SCOPES       = ['https://www.googleapis.com/auth/calendar.events']

// ── OAuth2 client ─────────────────────────────────────────────

function getOAuthClient() {
  const clientId     = process.env.GCAL_CLIENT_ID
  const clientSecret = process.env.GCAL_CLIENT_SECRET
  const redirectUri  = process.env.GCAL_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob'

  if (!clientId || !clientSecret) {
    throw new Error('GCAL_CLIENT_ID and GCAL_CLIENT_SECRET must be set in .env')
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) }
  catch { return null }
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))
  console.log('[gcal] Token saved to gcal_token.json')
}

export function getAuthenticatedClient() {
  const token = loadToken()
  if (!token) throw new Error('No Google Calendar token found. Run: node gcal.js setup')

  const auth = getOAuthClient()
  auth.setCredentials(token)

  // Auto-refresh token on expiry
  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      const existing = loadToken() || {}
      saveToken({ ...existing, ...tokens })
    }
  })

  return auth
}

// ── Calendar operations ───────────────────────────────────────

export async function createEvent({ title, start, end, description = '', reminders = true, colorId }) {
  const auth     = getAuthenticatedClient()
  const calendar = google.calendar({ version: 'v3', auth })

  const event = {
    summary: title,
    description,
    start: { dateTime: start, timeZone: 'Europe/London' },
    end:   { dateTime: end,   timeZone: 'Europe/London' },
    reminders: reminders
      ? { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] }
      : { useDefault: false, overrides: [] }
  }

  if (colorId) event.colorId = String(colorId)

  const response = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: event
  })

  console.log(`[gcal] Created event: "${title}" at ${start}`)
  return response.data
}

export async function deleteEvent(eventId) {
  const auth     = getAuthenticatedClient()
  const calendar = google.calendar({ version: 'v3', auth })
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId })
  console.log(`[gcal] Deleted event: ${eventId}`)
}

// ── One-time setup (run via: node gcal.js setup) ──────────────

async function runSetup() {
  const auth    = getOAuthClient()
  const authUrl = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES })

  console.log('\n[gcal] Open this URL in your browser and sign in:\n')
  console.log(authUrl)
  console.log('\nThen paste the authorisation code below:\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const code = await new Promise(resolve => rl.question('Code: ', ans => { rl.close(); resolve(ans.trim()) }))

  const { tokens } = await auth.getToken(code)
  saveToken(tokens)
  console.log('\n[gcal] ✓ Authentication complete. You can now use Google Calendar.\n')
}

// Allow running directly for setup
if (process.argv[2] === 'setup') {
  import('dotenv').then(m => m.default.config()).then(runSetup).catch(console.error)
}
