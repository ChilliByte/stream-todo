/**
 * baileys-bot.js
 * WhatsApp bridge — receives messages, reacts 👍, writes to CSV, sends outbound messages.
 *
 * Run: node baileys-bot.js
 * First run: scan the QR code printed in terminal with WhatsApp on your phone.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import simpleGit from 'simple-git'
import qrcode from 'qrcode-terminal'

dotenv.config()

const __dirname   = path.dirname(fileURLToPath(import.meta.url))
const CSV_PATH    = path.join(__dirname, 'todos.csv')
const STATE_PATH  = path.join(__dirname, 'state.json')
const INBOX_PATH  = path.join(__dirname, 'inbox.json')
const OUTBOX_PATH = path.join(__dirname, 'outbox.json')
const AUTH_DIR    = path.join(__dirname, 'auth_info')

const MY_PHONE = process.env.MY_PHONE
if (!MY_PHONE) { console.error('MY_PHONE not set in .env'); process.exit(1) }
const MY_JID = `${MY_PHONE}@s.whatsapp.net`

const git = simpleGit(__dirname)
let sock = null

// ── Helpers ──────────────────────────────────────────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }
  catch { return { sent_reminders: [], pending_question_item_id: null } }
}

function writeState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2))
}

function readCSV() {
  const text = fs.readFileSync(CSV_PATH, 'utf8')
  return parse(text, { columns: true, skip_empty_lines: true })
}

function writeCSV(rows) {
  const out = stringify(rows, {
    header: true,
    quoted_string: true,
    columns: [
      'id','timestamp','raw_message','category','priority',
      'new','reminder_at','completed','completed_at','archived'
    ]
  })
  fs.writeFileSync(CSV_PATH, out)
}

function nextId(rows) {
  if (!rows.length) return 1
  return Math.max(...rows.map(r => parseInt(r.id) || 0)) + 1
}

function readInbox() {
  try { return JSON.parse(fs.readFileSync(INBOX_PATH, 'utf8')) }
  catch { return [] }
}

function appendInbox(entry) {
  const inbox = readInbox()
  inbox.push(entry)
  fs.writeFileSync(INBOX_PATH, JSON.stringify(inbox, null, 2))
}

function readOutbox() {
  try { return JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) }
  catch { return [] }
}

async function gitSync(msg = 'update todos') {
  try {
    await git.add('todos.csv')
    const status = await git.status()
    if (status.staged.length > 0) {
      await git.commit(msg)
      await git.push()
    }
  } catch (e) {
    console.error('[git]', e.message)
  }
}

// ── Message handler ──────────────────────────────────────────

function extractText(msg) {
  return msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || ''
}

async function handleMessage(msg, text) {
  const state = readState()

  // React 👍 immediately
  try {
    await sock.sendMessage(MY_JID, {
      react: { text: '👍', key: msg.key }
    })
  } catch (e) {
    console.error('[react]', e.message)
  }

  // UPDATES command — pass to processor for interpretation
  if (text.startsWith('UPDATES\n') || text.startsWith('UPDATES\r\n')) {
    appendInbox({
      type: 'updates',
      text,
      timestamp: new Date().toISOString()
    })
    console.log('[bot] Queued UPDATES command for processor')
    return
  }

  // Reply to a pending question from Claude
  if (state.pending_question_item_id) {
    appendInbox({
      type: 'reply',
      text,
      item_id: state.pending_question_item_id,
      timestamp: new Date().toISOString()
    })
    state.pending_question_item_id = null
    writeState(state)
    console.log('[bot] Queued reply for processor')
    return
  }

  // New to-do item
  const rows = readCSV()
  rows.push({
    id: String(nextId(rows)),
    timestamp: new Date().toISOString(),
    raw_message: text,
    category: '',
    priority: '',
    new: 'true',
    reminder_at: '',
    completed: 'false',
    completed_at: '',
    archived: 'false'
  })
  writeCSV(rows)
  await gitSync(`add: ${text.slice(0, 40)}`)
  console.log(`[bot] Stored: "${text}"`)
}

// ── Outbox polling — send queued messages from processor ─────

async function processOutbox() {
  const messages = readOutbox()
  if (!messages.length) return

  // Clear immediately to avoid double-send
  fs.writeFileSync(OUTBOX_PATH, '[]')

  for (const msg of messages) {
    try {
      const jid = msg.to || MY_JID
      await sock.sendMessage(jid, { text: msg.text })
      console.log(`[bot] Sent: "${msg.text.slice(0, 60)}"`)

      // If message includes a pending_question_item_id, record it in state
      if (msg.pending_question_item_id) {
        const state = readState()
        state.pending_question_item_id = msg.pending_question_item_id
        writeState(state)
      }
    } catch (e) {
      console.error('[outbox]', e.message)
    }
  }
}

// ── Reminder polling — fire scheduled reminders ──────────────

async function checkReminders() {
  const rows = readCSV()
  const state = readState()
  const now = new Date()
  const sentIds = new Set(state.sent_reminders || [])
  let changed = false

  for (const row of rows) {
    if (!row.reminder_at) continue
    if (row.completed === 'true') continue
    if (row.archived === 'true') continue
    if (sentIds.has(row.id)) continue

    const remAt = new Date(row.reminder_at)
    // Fire if within the past 5 minutes (handles bot restarts)
    if (remAt <= now && remAt > new Date(now - 5 * 60 * 1000)) {
      await sock.sendMessage(MY_JID, { text: `⏰ ${row.raw_message}` })
      sentIds.add(row.id)
      changed = true
      console.log(`[reminder] Sent: "${row.raw_message}"`)
    }
  }

  if (changed) {
    state.sent_reminders = [...sentIds]
    writeState(state)
  }
}

// ── WhatsApp connection ──────────────────────────────────────

async function startBot() {
  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Stream Todo', 'Chrome', '1.0.0']
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n[bot] Scan this QR code with WhatsApp on your second number:\n')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') console.log('[bot] Connected to WhatsApp ✓')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('[bot] Logged out. Delete auth_info/ and restart to re-scan.')
      } else {
        console.log('[bot] Disconnected, reconnecting...')
        setTimeout(startBot, 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      // Ignore outbound messages the bot sends
      if (msg.key.fromMe) continue
      // Ignore group messages
      if (msg.key.remoteJid.endsWith('@g.us')) continue

      const text = extractText(msg)
      if (!text.trim()) continue

      await handleMessage(msg, text.trim())
    }
  })

  // Poll outbox every 30 seconds
  setInterval(processOutbox, 30 * 1000)

  // Poll reminders every 60 seconds
  setInterval(checkReminders, 60 * 1000)

  console.log('[bot] Stream Todo Bot starting...')
}

startBot().catch(console.error)
