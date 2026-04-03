/**
 * baileys-bot.js
 * WhatsApp bridge — receives messages (text + voice), reacts, writes to CSV,
 * sends outbound messages and reminders as voice notes.
 */

import http from 'http'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import simpleGit from 'simple-git'
import qrcode from 'qrcode-terminal'
import { spawn, execSync } from 'child_process'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffmpegLib from 'fluent-ffmpeg'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import cron from 'node-cron'
import { runTier1 } from './tier1.js'
import { runTier2 } from './tier2.js'
import { generateDailyDigest } from './digest.js'
import { createEvent as gcalCreateEvent } from './gcal.js'

dotenv.config()
ffmpegLib.setFfmpegPath(ffmpegInstaller.path)

const __dirname      = path.dirname(fileURLToPath(import.meta.url))
const CSV_PATH       = path.join(__dirname, 'todos.csv')
const STATE_PATH     = path.join(__dirname, 'state.json')
const INBOX_PATH     = path.join(__dirname, 'inbox.json')
const OUTBOX_PATH    = path.join(__dirname, 'outbox.json')
const MSGKEYS_PATH   = path.join(__dirname, 'message_keys.json')
const SCHEDULED_PATH = path.join(__dirname, 'scheduled.json')
const AUTH_DIR        = path.join(__dirname, 'auth_info')
const BRIEFS_DIR      = path.join(__dirname, 'briefs')
const WORLD_STATE_PATH = path.join(__dirname, 'world_state.json')
const DIGEST_PATH      = path.join(__dirname, 'daily_digest.json')

const MY_PHONE = process.env.MY_PHONE
if (!MY_PHONE) { console.error('MY_PHONE not set in .env'); process.exit(1) }
const MY_JID = `${MY_PHONE}@s.whatsapp.net`

// All JIDs allowed to interact with the bot (bot number + personal number)
const WHITELISTED_JIDS = new Set([
  // Standard @s.whatsapp.net JID
  `${MY_PHONE}@s.whatsapp.net`,
  ...(process.env.MY_PERSONAL_PHONE ? [`${process.env.MY_PERSONAL_PHONE}@s.whatsapp.net`] : []),
  // WhatsApp @lid (Linked ID) format — newer devices send messages via @lid instead of @s.whatsapp.net
  // MY_LID is auto-detected from auth_info/creds.json on first run, or set manually in .env
  ...(process.env.MY_LID ? [`${process.env.MY_LID}@lid`] : []),
])
console.log('[bot] Whitelisted JIDs:', [...WHITELISTED_JIDS].join(', '))

// Local server auth token — set LOCAL_TOKEN in .env to enable, otherwise open
const LOCAL_TOKEN = process.env.LOCAL_TOKEN || null

const GROQ_API_KEY = process.env.GROQ_API_KEY
if (!GROQ_API_KEY) { console.error('GROQ_API_KEY not set in .env'); process.exit(1) }
const EDGE_VOICE = process.env.EDGE_VOICE || 'en-GB-SoniaNeural'
const VOICE_MIN_LENGTH = 30 // below this, always send text regardless of voice flag

const git = simpleGit(__dirname)
let sock = null
let _wsConnected = false  // true only when WhatsApp connection is 'open'
let _reconnecting = false // guard against multiple concurrent startBot calls
let _socketGen = 0        // incremented each startBot; stale event handlers self-ignore

// Ping / thanks patterns — handled immediately without Claude
const PING_RE   = /^(hey|hello|hi|test|are you (there|on|alive|up)|ping|you there|u there)[\s?!.]*$/i
const THANKS_RE = /^(thanks?|thank you|cheers|ta|ty|appreciate it|nice one|legend)[\s!.]*$/i

// Pending hourglass reactions: msgKeyId → { msgKey, jid, timer, isSet }
const pendingHourglass = new Map()

// ── Find claude.exe (scan for latest installed version) ───────

let _claudeExePath = null
function findClaudeExe() {
  if (_claudeExePath) return _claudeExePath
  const baseDir = path.join(process.env.APPDATA || '', 'Claude', 'claude-code')
  if (fs.existsSync(baseDir)) {
    const versions = fs.readdirSync(baseDir)
      .filter(d => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions) {
      const p = path.join(baseDir, v, 'claude.exe')
      if (fs.existsSync(p)) { _claudeExePath = p; return p }
    }
  }
  try {
    const found = execSync('where claude.exe', { encoding: 'utf8' }).trim().split('\n')[0].trim()
    if (found && fs.existsSync(found)) { _claudeExePath = found; return found }
  } catch {}
  throw new Error('claude.exe not found — is Claude Code installed?')
}

// ── File helpers ──────────────────────────────────────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }
  catch { return {} }
}
function writeState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)) }

function readCSV() {
  const text = fs.readFileSync(CSV_PATH, 'utf8')
  return parse(text, { columns: true, skip_empty_lines: true })
}
function writeCSV(rows) {
  const out = stringify(rows, {
    header: true, quoted_string: true,
    columns: ['id','timestamp','raw_message','category','priority','new','reminder_at','completed','completed_at','archived','brief_file']
  })
  fs.writeFileSync(CSV_PATH, out)
}
function nextId(rows) {
  if (!rows.length) return 1
  return Math.max(...rows.map(r => parseInt(r.id) || 0)) + 1
}

function readInbox()  { try { return JSON.parse(fs.readFileSync(INBOX_PATH, 'utf8')) } catch { return [] } }
function appendInbox(entry) { const i = readInbox(); i.push(entry); fs.writeFileSync(INBOX_PATH, JSON.stringify(i, null, 2)) }
function readOutbox() { try { return JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) } catch { return [] } }

// ── Voice — transcription ─────────────────────────────────────

async function transcribeAudio(audioBuffer) {
  const blob = new Blob([audioBuffer], { type: 'audio/ogg; codecs=opus' })
  const form = new FormData()
  form.append('file', blob, 'audio.ogg')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('language', 'en')
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: form
  })
  if (!res.ok) throw new Error(`Groq STT ${res.status}: ${await res.text()}`)
  return ((await res.json()).text || '').trim()
}

// ── Voice — synthesis ─────────────────────────────────────────
// Uses Groq Orpheus TTS when available; falls back to Edge Neural TTS.
// To enable Groq TTS: accept terms at console.groq.com/playground?model=canopylabs/orpheus-v1-english
// then set GROQ_TTS=1 in .env

const GROQ_TTS_ENABLED = process.env.GROQ_TTS === '1'
const GROQ_TTS_VOICE   = process.env.GROQ_VOICE || 'tara'

async function synthesizeSpeech(text) {
  if (GROQ_TTS_ENABLED) {
    const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'canopylabs/orpheus-v1-english',
        input: text,
        voice: GROQ_TTS_VOICE,
        response_format: 'mp3'
      })
    })
    if (!res.ok) throw new Error(`Groq TTS ${res.status}: ${await res.text()}`)
    return Buffer.from(await res.arrayBuffer())
  }

  // Fallback: Edge Neural TTS
  const tts = new MsEdgeTTS()
  await tts.setMetadata(EDGE_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
  const { audioStream } = tts.toStream(text)
  const chunks = []
  return new Promise((resolve, reject) => {
    audioStream.on('data',  c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    audioStream.on('end',   () => resolve(Buffer.concat(chunks)))
    audioStream.on('error', reject)
  })
}

function mp3ToOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const tmpIn  = path.join(os.tmpdir(), `stream_in_${Date.now()}.mp3`)
    const tmpOut = path.join(os.tmpdir(), `stream_out_${Date.now()}.ogg`)
    fs.writeFileSync(tmpIn, mp3Buffer)
    ffmpegLib(tmpIn)
      .audioCodec('libopus').audioBitrate('32k').format('ogg').save(tmpOut)
      .on('end', () => {
        const r = fs.readFileSync(tmpOut)
        try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut) } catch {}
        resolve(r)
      })
      .on('error', err => {
        try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut) } catch {}
        reject(err)
      })
  })
}

async function sendVoice(jid, text) {
  const mp3  = await synthesizeSpeech(text)
  const opus = await mp3ToOpus(mp3)
  await sock.sendMessage(jid, { audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true })
  console.log(`[voice] Sent: "${text.slice(0, 60)}"`)
}

// ── Smart send: voice only when meaningful ────────────────────

async function smartSend(jid, text, forceTts = false) {
  if (!text?.trim()) return // never send blank
  const state    = readState()
  const useVoice = (forceTts || state.last_was_voice) && text.length >= VOICE_MIN_LENGTH

  // Store for "Done" context detection
  storeLastBotMessage(text)

  if (useVoice) {
    try {
      await sendVoice(jid, text)
      if (state.last_was_voice) { state.last_was_voice = false; writeState(state) }
      return
    } catch (e) {
      console.error('[voice] TTS failed, falling back to text:', e.message)
    }
  }
  await sock.sendMessage(jid, { text })
  console.log(`[bot] Sent text: "${text.slice(0, 60)}"`)
}

// ── Context — track last bot message for "Done" detection ─────

const HISTORY_LIMIT = 15

function appendHistory(role, text) {
  if (!text?.trim()) return
  const s = readState()
  const history = s.conversation_history || []
  history.push({ role, text: text.trim(), ts: new Date().toISOString() })
  s.conversation_history = history.slice(-HISTORY_LIMIT)
  writeState(s)
}

function storeLastBotMessage(text, todoId = null) {
  const s = readState()
  s.last_bot_message = { text, todo_id: todoId, sent_at: new Date().toISOString() }
  writeState(s)
  if (text?.trim()) appendHistory('assistant', text)
}

// Detect "Done", "did it", "ok", "sorted", etc.
const COMPLETION_RE = /^(done|did it|yep|yeah|yea|ok|okay|got it|finished|sorted|complete[d]?|✅|👍)[\s!.]*$/i

// Detect snooze requests — "snooze", "snooze 2h", "snooze until 3pm", etc.
const SNOOZE_RE = /^snooze(\s+(.+?))?[\s!.]*$/i

// ── Typing indicator (refreshes every 20s — WhatsApp expires after ~30s) ──

let _typingInterval = null
let _typingJid = null

function showTyping(jid) {
  _typingJid = jid
  sock?.sendPresenceUpdate('composing', jid).catch(() => {})
  clearInterval(_typingInterval)
  _typingInterval = setInterval(() => {
    sock?.sendPresenceUpdate('composing', jid).catch(() => {})
  }, 20000)
}
function clearTyping(jid) {
  clearInterval(_typingInterval)
  _typingInterval = null
  _typingJid = null
  sock?.sendPresenceUpdate('paused', jid || MY_JID).catch(() => {})
}

// ── Hourglass reaction (fires 5s after runProcessor, only if still pending) ──

function scheduleHourglass(msg, jid) {
  const msgKey = msg.key
  const timer = setTimeout(() => {
    const entry = pendingHourglass.get(msgKey.id)
    if (entry) {
      entry.isSet = true
      sock?.sendMessage(jid, { react: { text: '⏳', key: msgKey } }).catch(() => {})
      console.log('[bot] ⏳ hourglass set (Claude still processing)')
    }
  }, 5000)
  pendingHourglass.set(msgKey.id, { msgKey, jid, timer, isSet: false })
}

// ── Bot-level instant commands (no Claude needed) ─────────────

const CMD_LIST    = /^(list|my list|what'?s? on my list|show( my)? (list|tasks|todos))[\s?!.]*$/i
const CMD_TODAY   = /^(today|reminders?( today)?|what'?s? (on )?today)[\s?!.]*$/i
const CMD_DONE_N  = /^(done|complete[d]?)\s+#?(\d+)[\s!.]*$/i
const CMD_DELETE_N = /^(delete|remove|cancel)\s+#?(\d+)[\s!.]*$/i
const CMD_SNOOZE_N = /^snooze\s+#(\d+)(\s+(.+?))?[\s!.]*$/i

function formatTodoList() {
  const rows = readCSV()
  const active = rows.filter(r => r.archived !== 'true' && r.completed !== 'true')
  if (!active.length) return "Your list is clear 🎉"

  const byCategory = {}
  for (const r of active) {
    const cat = r.category || 'misc'
    byCategory[cat] = byCategory[cat] || []
    byCategory[cat].push(r)
  }

  const lines = []
  for (const [cat, items] of Object.entries(byCategory)) {
    lines.push(`*${cat.toUpperCase()}*`)
    for (const r of items) {
      const flag = r.priority === 'high' ? ' ⚠️' : ''
      lines.push(`  #${r.id} ${r.raw_message}${flag}`)
    }
  }
  return lines.join('\n')
}

function formatTodayReminders() {
  let entries = []
  try { entries = JSON.parse(fs.readFileSync(SCHEDULED_PATH, 'utf8')) } catch {}

  const now = new Date()
  const todayStr = now.toLocaleDateString('en-GB', { timeZone: 'Europe/London' })

  const todayEntries = entries.filter(e => {
    if (!e.send_at) return false
    const d = new Date(e.send_at)
    return d.toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) === todayStr && d > now
  })

  if (!todayEntries.length) return "Nothing else scheduled for today."

  todayEntries.sort((a, b) => new Date(a.send_at) - new Date(b.send_at))
  const lines = ["Upcoming today:"]
  for (const e of todayEntries) {
    const t = new Date(e.send_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
    lines.push(`  ${t} — ${e.text}`)
  }
  return lines.join('\n')
}

// Returns true if the message was handled as a command (no Claude needed)
async function handleCommand(jid, msg, text) {
  // list
  if (CMD_LIST.test(text)) {
    await sock.sendMessage(jid, { text: formatTodoList() })
    return true
  }

  // today's reminders
  if (CMD_TODAY.test(text)) {
    await sock.sendMessage(jid, { text: formatTodayReminders() })
    return true
  }

  // done #N
  const doneMatch = text.match(CMD_DONE_N)
  if (doneMatch) {
    const id = doneMatch[2]
    const rows = readCSV()
    const row  = rows.find(r => r.id === id)
    if (!row) {
      await sock.sendMessage(jid, { text: `No task #${id} found.` })
      return true
    }
    if (row.completed === 'true') {
      await sock.sendMessage(jid, { text: `#${id} was already done.` })
      return true
    }
    row.completed = 'true'
    row.completed_at = new Date().toISOString()
    writeCSV(rows)
    gitSync(`complete: ${row.raw_message.slice(0, 40)}`).catch(() => {})
    sock.sendMessage(jid, { react: { text: '✅', key: msg.key } }).catch(() => {})
    console.log(`[bot] done #${id} via command: "${row.raw_message}"`)
    return true
  }

  // delete #N
  const deleteMatch = text.match(CMD_DELETE_N)
  if (deleteMatch) {
    const id = deleteMatch[2]
    const rows = readCSV()
    const row  = rows.find(r => r.id === id)
    if (!row) {
      await sock.sendMessage(jid, { text: `No task #${id} found.` })
      return true
    }
    row.archived = 'true'
    writeCSV(rows)
    gitSync(`remove: ${row.raw_message.slice(0, 40)}`).catch(() => {})
    sock.sendMessage(jid, { react: { text: '🗑️', key: msg.key } }).catch(() => {})
    console.log(`[bot] deleted #${id} via command: "${row.raw_message}"`)
    return true
  }

  // snooze #N [duration]
  const snoozeNMatch = text.match(CMD_SNOOZE_N)
  if (snoozeNMatch) {
    const id = snoozeNMatch[1]
    const durationHint = snoozeNMatch[3]?.trim() || null
    const rows = readCSV()
    const row  = rows.find(r => r.id === id)
    if (!row) {
      await sock.sendMessage(jid, { text: `No task #${id} found.` })
      return true
    }
    appendInbox({ type: 'snooze', todo_id: id, duration_hint: durationHint, timestamp: new Date().toISOString() })
    showTyping(jid)
    scheduleHourglass(msg, jid)
    runTier1Processor(null, null, jid).catch(e => console.error('[tier1]', e.message))
    return true
  }

  return false
}

// ── Processor ─────────────────────────────────────────────────

// Write a slim context file so Claude doesn't need to scan the full CSV
function writeProcessorContext() {
  const rows = readCSV()
  const newItems  = rows.filter(r => r.new === 'true')
  const active    = rows.filter(r => r.archived !== 'true' && r.completed !== 'true')
  const recentDone = rows
    .filter(r => r.completed === 'true' && r.completed_at &&
      (Date.now() - new Date(r.completed_at).getTime()) < 48 * 3600 * 1000)
    .slice(-5)

  const byCategory = {}
  active.forEach(r => {
    const c = r.category || 'misc'
    byCategory[c] = (byCategory[c] || 0) + 1
  })

  const ctx = {
    new_items: newItems,
    recently_completed: recentDone,
    active_count: active.length,
    by_category: byCategory,
    generated_at: new Date().toISOString()
  }
  fs.writeFileSync(path.join(__dirname, 'processor_context.json'), JSON.stringify(ctx, null, 2))
  return newItems.length
}

// Track last proactive check to avoid running it every message
let _lastProactiveCheck = 0
const PROACTIVE_INTERVAL_MS = 60 * 60 * 1000 // at most once per hour

function buildProcessorPrompt() {
  const now = new Date()
  const timeStr = now.toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit'
  })
  const state = readState()
  const lastBotMsg = state.last_bot_message

  const contextLine = lastBotMsg
    ? `Last message you sent Deep: "${lastBotMsg.text.slice(0, 100)}" (at ${lastBotMsg.sent_at}${lastBotMsg.todo_id ? `, todo #${lastBotMsg.todo_id}` : ''})`
    : ''

  const newCount = writeProcessorContext()

  // Only run proactive pattern checks if no urgent new items, and at most once/hour
  const doProactive = newCount === 0 || (Date.now() - _lastProactiveCheck > PROACTIVE_INTERVAL_MS)
  if (doProactive) _lastProactiveCheck = Date.now()

  const proactiveLine = doProactive
    ? 'Also scan todos.csv for proactive patterns (per CLAUDE.md) and flag anything genuinely worth mentioning.'
    : '' // skip proactive scan to keep this run fast

  const gitCmd = 'git -C "' + __dirname.replace(/\\/g, '\\\\') + '" add todos.csv profile.md outbox.json scheduled.json inbox.json briefs/ && git -C "' + __dirname.replace(/\\/g, '\\\\') + '" commit -m "secretary" && git -C "' + __dirname.replace(/\\/g, '\\\\') + '" push'

  return [
    `Current time: ${timeStr} (ISO: ${now.toISOString()}).`,
    contextLine,
    'Read CLAUDE.md for your brief. Read profile.md for preferences.',
    'Your work queue is in processor_context.json — read that first. It contains only the items that need processing (new_items) plus recent context. Do NOT read the full todos.csv unless you need to edit a specific row by ID.',
    'Read inbox.json for any replies or snooze requests.',
    'Act as Deep\'s personal secretary.',
    'For every item in new_items: clean the text, categorise, set priority, set new=false in todos.csv.',
    'For research items ("find X", "look up X"): write a brief to briefs/{id}.json, set brief_file in todos.csv, and send results via outbox.',
    'Use the current time to resolve relative times ("in 30 mins" → correct ISO timestamp).',
    'If inbox contains "done"/"sorted" and context shows a recent todo, mark it complete in todos.csv.',
    'IMPORTANT: Never write empty or null text to outbox.json.',
    'For silently processed items: outbox.json [{type:"react",emoji:"🫡",todo_id:"<id>"}].',
    'For messages to Deep: outbox.json [{to:"' + MY_PHONE + '@s.whatsapp.net",text:"<short spoken-friendly message>",pending_question_item_id:"<id or null>"}].',
    'Scheduled reminders: scheduled.json [{text:"<spoken-friendly reminder>",send_at:"<ISO>",todo_id:"<id>"}] — always include todo_id.',
    proactiveLine,
    'After processing, write todos.csv and profile.md.',
    'Then run: ' + gitCmd
  ].filter(Boolean).join(' ')
}

// ── Tier 1: reactive processor (direct haiku API call) ────────

let _tier1Running = false
let _tier1Queued  = false  // a message arrived while tier1 was busy — re-run after

async function runTier1Processor(newItemId, msg, jid) {
  if (_tier1Running) {
    // Mark that we need another pass — item is already written to CSV with new=true
    _tier1Queued = true
    console.log('[tier1] Already running — will re-run after current pass')
    return
  }
  _tier1Running = true
  _tier1Queued  = false

  try {
    // Gather the new item(s) and inbox — snapshot IDs so we only mark *these* as processed
    const rows     = readCSV()
    const newItems = rows.filter(r => r.new === 'true')
    const processedIds = new Set(newItems.map(r => r.id))
    const inbox    = readInbox()

    // Log user messages into conversation history
    for (const item of newItems) {
      if (item.raw_message) appendHistory('user', item.raw_message)
    }

    console.log(`[tier1] Processing ${newItems.length} item(s) via haiku API`)

    const result = await runTier1(newItems, inbox)

    // Apply todos_update
    {
      const latest = readCSV()
      let changed = false
      if (result.todos_update?.length) {
        for (const upd of result.todos_update) {
          const row = latest.find(r => r.id === String(upd.id))
          if (!row) continue
          if (upd.category)    { row.category    = upd.category;    changed = true }
          if (upd.priority)    { row.priority    = upd.priority;    changed = true }
          if (upd.reminder_at !== undefined) { row.reminder_at = upd.reminder_at || ''; changed = true }
          row.new = 'false'
          changed = true
        }
      }
      // Only mark items that were in THIS batch as processed (not ones that arrived mid-run)
      for (const row of latest) {
        if (row.new === 'true' && processedIds.has(row.id)) { row.new = 'false'; changed = true }
      }
      if (changed) writeCSV(latest)
    }

    // Clear inbox now that it's been processed
    fs.writeFileSync(INBOX_PATH, '[]')

    // Merge Tier 1 schedules into scheduled.json
    if (result.schedule?.length) {
      const existing = readJSON(SCHEDULED_PATH, [])
      const merged = [...existing, ...result.schedule]
      fs.writeFileSync(SCHEDULED_PATH, JSON.stringify(merged, null, 2))
      console.log(`[tier1] Scheduled ${result.schedule.length} reminder(s)`)
    }

    // Send reply or react
    if (result.react_only) {
      // Send 🫡 react to the triggering message
      if (newItemId && msg) {
        let keys = {}
        try { keys = JSON.parse(fs.readFileSync(MSGKEYS_PATH, 'utf8')) } catch {}
        const msgKey = keys[newItemId]
        if (msgKey) {
          // Clear hourglass
          const hEntry = pendingHourglass.get(msgKey.id)
          if (hEntry) { clearTimeout(hEntry.timer); pendingHourglass.delete(msgKey.id) }
          await sock?.sendMessage(msgKey.remoteJid, { react: { text: '🫡', key: msgKey } })
        }
      }
    } else if (result.reply?.trim()) {
      // Clear hourglasses before sending
      for (const [id, hEntry] of pendingHourglass.entries()) {
        clearTimeout(hEntry.timer)
        if (hEntry.isSet) {
          sock?.sendMessage(hEntry.jid, { react: { text: '', key: hEntry.msgKey } }).catch(() => {})
        }
        pendingHourglass.delete(id)
      }
      await smartSend(jid || MY_JID, result.reply)
      clearTyping(jid || MY_JID)
      storeLastBotMessage(result.reply, newItemId)
    }

    // Append profile_note directly to profile.md
    if (result.profile_note?.trim()) {
      try {
        const profilePath = path.join(__dirname, 'profile.md')
        const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : ''
        const date = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
        const note = `\n- ${result.profile_note.trim()} (${date})`
        fs.appendFileSync(profilePath, note)
        console.log(`[tier1] profile_note appended: ${result.profile_note.slice(0, 60)}`)
      } catch (e) {
        console.error('[tier1] Failed to write profile_note:', e.message)
      }
    }

    // Flag research item for Tier 3 (claude.exe)
    if (result.needs_research && result.research_item_id) {
      console.log(`[tier1] Flagging #${result.research_item_id} for research (Tier 3)`)
      runProcessor()
    }

    // Flag cleanup for Tier 3 (claude.exe)
    if (result.needs_cleanup) {
      console.log('[tier1] Cleanup requested — queuing Tier 3')
      runProcessor('CLEANUP TASK: Deep asked you to tidy the todo list. Remove any blank items, duplicate items, or items that are clearly noise (e.g. messages that were accidentally logged as todos). Do NOT remove real tasks. Confirm what you removed in outbox.json.')
    }

    // Git sync
    gitSync(`tier1: processed ${newItems.length} item(s)`).catch(() => {})

    console.log(`[tier1] Done — react_only:${result.react_only}, reply:${!!result.reply}, research:${result.needs_research}, cleanup:${result.needs_cleanup}`)
  } catch (e) {
    console.error('[tier1] Error:', e.message)
    // If token is dead, trigger background refresh via claude.exe
    if (String(e.message).includes('401')) refreshTokenViaClaude().catch(() => {})
    // Fallback to legacy processor on failure
    runProcessor()
  } finally {
    _tier1Running = false
    // If a message arrived while we were running, process it now
    if (_tier1Queued) {
      _tier1Queued = false
      const leftover = readCSV().filter(r => r.new === 'true')
      if (leftover.length > 0) {
        console.log(`[tier1] ${leftover.length} item(s) arrived during run — processing now`)
        runTier1Processor(null, null, MY_JID).catch(e => console.error('[tier1]', e.message))
      }
    }
  }
}

function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  catch { return fallback }
}

// ── Legacy Tier 3 processor (claude.exe — research & proactive) ──

let _processorRunning = false

function runProcessor(extraPrompt = '') {
  if (_processorRunning) { console.log('[bot] Processor already running, skipping'); return }
  let claudeExe
  try { claudeExe = findClaudeExe() }
  catch (e) { console.error('[processor]', e.message); return }

  _processorRunning = true

  // Write prompt to file — avoids quote mangling when shell parses the command line
  const promptFile = path.join(__dirname, 'processor_prompt.txt')
  const prompt = extraPrompt ? buildProcessorPrompt() + '\n\n' + extraPrompt : buildProcessorPrompt()
  fs.writeFileSync(promptFile, prompt, 'utf8')

  const logPath = path.join(__dirname, 'processor.log')

  // Pass a simple, quote-free instruction pointing to the prompt file
  const safeArg = 'Read the file processor_prompt.txt in the current directory and follow the instructions in it exactly.'
  const proc = spawn(claudeExe, ['--print', '--dangerously-skip-permissions', safeArg], {
    cwd: __dirname, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: process.env
  })

  const log = fs.createWriteStream(logPath, { flags: 'a' })
  proc.stdout?.pipe(log)
  proc.stderr?.pipe(log)

  proc.on('error', e => { _processorRunning = false; console.error('[processor] spawn error:', e.message) })
  proc.on('close', code => {
    _processorRunning = false
    log.end()
    console.log(`[bot] Processor exited (code ${code})`)
    processOutbox().catch(console.error)
  })

  console.log('[bot] Processor invoked (pid ' + proc.pid + ')')
}

// ── Nightly cleanup ───────────────────────────────────────────

function buildCleanupPrompt() {
  const now = new Date()
  const timeStr = now.toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit'
  })
  return [
    `Current time: ${timeStr} (ISO: ${now.toISOString()}).`,
    'This is a nightly maintenance run. Read todos.csv and profile.md.',
    'RULES — be conservative. When in doubt, do nothing and ask.',
    '1. SAFE TO AUTO-ARCHIVE (certain): completed=true AND completed_at older than 7 days. Set archived=true silently.',
    '2. UNCERTAIN — ASK, do not archive: any incomplete todo (completed=false) older than 30 days with no reminder_at set. Do not touch these. Instead, collect them and send ONE WhatsApp message listing them and asking which (if any) can be dropped. Keep the message short — just the raw_message text of each item, numbered.',
    '3. PROFILE CLEANUP: only remove profile.md entries marked (1x observed) that are older than 90 days. Never remove (2x observed), (verified), or undated entries. When unsure, leave it.',
    '4. Write updated todos.csv and profile.md only for the changes you are certain about.',
    'For the uncertain items message: outbox.json [{to:"' + MY_PHONE + '@s.whatsapp.net",text:"<message>"}].',
    'Then run: git -C "' + __dirname.replace(/\\/g, '\\\\') + '" add todos.csv profile.md outbox.json && git -C "' + __dirname.replace(/\\/g, '\\\\') + '" commit -m "nightly cleanup" && git -C "' + __dirname.replace(/\\/g, '\\\\') + '" push'
  ].join(' ')
}

function runCleanup() {
  if (_processorRunning) { console.log('[cleanup] Processor already running, skipping'); return }
  let claudeExe
  try { claudeExe = findClaudeExe() }
  catch (e) { console.error('[cleanup]', e.message); return }

  _processorRunning = true

  // Write prompt to file — avoids quote mangling on Windows
  const promptFile = path.join(__dirname, 'processor_prompt.txt')
  fs.writeFileSync(promptFile, buildCleanupPrompt(), 'utf8')

  const logPath = path.join(__dirname, 'processor.log')
  const safeArg = 'Read the file processor_prompt.txt in the current directory and follow the instructions in it exactly.'
  const proc = spawn(claudeExe, ['--print', '--dangerously-skip-permissions', safeArg], {
    cwd: __dirname, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: process.env
  })

  const log = fs.createWriteStream(logPath, { flags: 'a' })
  proc.stdout?.pipe(log)
  proc.stderr?.pipe(log)

  proc.on('error', e => { _processorRunning = false; console.error('[cleanup] spawn error:', e.message) })
  proc.on('close', code => {
    _processorRunning = false
    log.end()
    console.log(`[cleanup] Nightly maintenance run finished (code ${code})`)
    processOutbox().catch(console.error)
  })

  console.log('[cleanup] Nightly maintenance run started (pid ' + proc.pid + ')')
}

async function recoverMissedReminders() {
  let entries = []
  try { entries = JSON.parse(fs.readFileSync(SCHEDULED_PATH, 'utf8')) } catch { return }
  if (!entries.length) return

  const now = new Date()
  const remaining = []
  let recovered = 0

  for (const entry of entries) {
    if (!entry?.send_at || !entry?.text) continue  // skip malformed entries
    const sendAt = new Date(entry.send_at)
    if (isNaN(sendAt.getTime())) continue
    const ageMs = now - sendAt
    if (sendAt <= now && ageMs <= 30 * 60 * 1000) {
      try {
        await smartSend(MY_JID, `(Missed) ${entry.text}`)
        if (entry.todo_id) storeLastBotMessage(entry.text, entry.todo_id)
        recovered++
      } catch (e) {
        console.error('[recovery]', e.message)
        remaining.push(entry)
      }
    } else if (sendAt > now) {
      remaining.push(entry)
    }
    // older than 30 min: drop silently
  }

  if (recovered > 0 || remaining.length !== entries.length) {
    fs.writeFileSync(SCHEDULED_PATH, JSON.stringify(remaining, null, 2))
    if (recovered > 0) console.log(`[recovery] Sent ${recovered} missed reminder(s)`)
  }
}

async function checkCleanup() {
  const now = new Date()
  const londonHour = parseInt(now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }))
  if (londonHour !== 23) return // only at 11pm

  const s = readState()
  const today = now.toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
  if (s.last_cleanup_date === today) return // already ran today

  s.last_cleanup_date = today
  writeState(s)
  runCleanup()
}

async function gitSync(msg = 'update') {
  if (_processorRunning) return // processor will handle git commit
  try {
    await git.add(['todos.csv', 'profile.md'])
    const status = await git.status()
    if (status.staged.length > 0) { await git.commit(msg); await git.push() }
  } catch (e) { console.error('[git]', e.message) }
}

// ── Message handler ───────────────────────────────────────────

function extractText(msg) {
  return msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
}

async function handleMessage(msg, text) {
  const jid   = msg.key.remoteJid
  const state = readState()

  // Blue tick — bot has received the message
  sock.readMessages([msg.key]).catch(() => {})

  // Ping / "are you on?" → 👍, done
  if (PING_RE.test(text)) {
    sock.sendMessage(jid, { react: { text: '👍', key: msg.key } }).catch(() => {})
    console.log('[bot] Ping detected → 👍')
    return
  }

  // Thanks → ❤️, done
  if (THANKS_RE.test(text)) {
    sock.sendMessage(jid, { react: { text: '❤️', key: msg.key } }).catch(() => {})
    console.log('[bot] Thanks detected → ❤️')
    return
  }

  // Instant bot-level commands — handled without Claude
  if (await handleCommand(jid, msg, text)) return

  // Show typing while we work on it
  showTyping(jid)

  // UPDATES command (from frontend edit system) — route to legacy processor (full context needed)
  if (text.startsWith('UPDATES\n') || text.startsWith('UPDATES\r\n')) {
    appendInbox({ type: 'updates', text, timestamp: new Date().toISOString() })
    scheduleHourglass(msg, jid)
    runProcessor()
    return
  }

  // Reply to a pending question (expires after 24h to prevent future messages being misrouted)
  if (state.pending_question_item_id) {
    const questionAge = state.pending_question_asked_at
      ? Date.now() - new Date(state.pending_question_asked_at).getTime()
      : Infinity
    if (questionAge < 24 * 3600 * 1000) {
      const questionItemId = state.pending_question_item_id
      appendInbox({ type: 'reply', text, item_id: questionItemId, timestamp: new Date().toISOString() })
      state.pending_question_item_id = null
      state.pending_question_asked_at = null
      writeState(state)
      scheduleHourglass(msg, jid)
      // Replies to questions go through Tier 1 with inbox context
      runTier1Processor(questionItemId, msg, jid).catch(e => console.error('[tier1]', e.message))
      return
    }
    // Stale question — clear and fall through to normal handling
    console.log(`[bot] Pending question expired (>24h), treating as new item`)
    state.pending_question_item_id = null
    state.pending_question_asked_at = null
    writeState(state)
  }

  // Completion signal ("Done", "sorted", etc.) — check if we have context
  if (COMPLETION_RE.test(text.trim())) {
    const lbm = state.last_bot_message
    if (lbm?.todo_id && (Date.now() - new Date(lbm.sent_at).getTime()) < 2 * 3600 * 1000) {
      const rows = readCSV()
      const row  = rows.find(r => r.id === lbm.todo_id)
      if (row && row.completed !== 'true') {
        row.completed = 'true'
        row.completed_at = new Date().toISOString()
        writeCSV(rows)
        gitSync(`complete: ${row.raw_message.slice(0, 40)}`).catch(() => {})
        sock.sendMessage(jid, { react: { text: '✅', key: msg.key } }).catch(() => {})
        storeLastBotMessage('', null) // clear context
        clearTyping(jid)
        console.log(`[bot] "Done" → completed #${lbm.todo_id}: "${row.raw_message}"`)
        return
      }
    }
    // No fresh context — don't create a garbage todo, ask instead
    clearTyping(jid)
    await sock.sendMessage(jid, { text: "Which item's done? Say 'done #N' with the number." })
    return
  }

  // Snooze request — pass to Claude with todo context
  const snoozeMatch = text.match(SNOOZE_RE)
  if (snoozeMatch) {
    const lbm = state.last_bot_message
    if (lbm?.todo_id) {
      const durationHint = snoozeMatch[2]?.trim() || null
      appendInbox({
        type: 'snooze',
        todo_id: lbm.todo_id,
        duration_hint: durationHint,
        timestamp: new Date().toISOString()
      })
      scheduleHourglass(msg, jid)
      runTier1Processor(null, null, jid).catch(e => console.error('[tier1]', e.message))
      return
    }
    // No context — don't create a garbage todo, ask instead
    clearTyping(jid)
    await sock.sendMessage(jid, { text: "Snooze which item? Say 'snooze #N' or 'snooze #N 2h'." })
    return
  }

  // New to-do item
  const rows  = readCSV()
  const newId = String(nextId(rows))
  rows.push({
    id: newId, timestamp: new Date().toISOString(), raw_message: text,
    category: '', priority: '', new: 'true', reminder_at: '',
    completed: 'false', completed_at: '', archived: 'false', brief_file: ''
  })
  writeCSV(rows)

  // Store message key for reactions and future ✅ acks
  let keys = {}
  try { keys = JSON.parse(fs.readFileSync(MSGKEYS_PATH, 'utf8')) } catch {}
  keys[newId] = msg.key
  fs.writeFileSync(MSGKEYS_PATH, JSON.stringify(keys, null, 2))

  console.log(`[bot] Stored #${newId}: "${text}"`)
  scheduleHourglass(msg, jid)
  runTier1Processor(newId, msg, jid).catch(e => console.error('[tier1]', e.message))
}

// ── Outbox polling ────────────────────────────────────────────

let outboxRunning = false

async function processOutbox() {
  if (!sock || outboxRunning) return
  const messages = readOutbox()
  if (!messages.length) return
  outboxRunning = true
  // DON'T clear here — write back only what fails at the end

  const failed = []
  for (const msg of messages) {
    try {
      if (msg.type === 'calendar') {
        try {
          const endTime = msg.end || new Date(new Date(msg.start).getTime() + 60 * 60 * 1000).toISOString()
          const event   = await gcalCreateEvent({ title: msg.title, start: msg.start, end: endTime, description: msg.description || '' })
          const day     = new Date(msg.start).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' })
          const time    = new Date(msg.start).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
          await smartSend(MY_JID, `📅 Added to calendar — ${msg.title}, ${day} at ${time}`)
          console.log(`[gcal] Event created: ${msg.title}`)
        } catch (e) {
          console.error('[gcal] Failed to create event:', e.message)
          await smartSend(MY_JID, `Couldn't add to calendar — ${e.message.includes('token') ? 'run: node gcal.js setup' : e.message}`)
        }
      } else if (msg.type === 'react') {
        let keys = {}
        try { keys = JSON.parse(fs.readFileSync(MSGKEYS_PATH, 'utf8')) } catch {}
        const msgKey = keys[msg.todo_id]
        if (msgKey) {
          // Cancel pending hourglass for this message (🫡 will replace ⏳ if set)
          const hEntry = pendingHourglass.get(msgKey.id)
          if (hEntry) {
            clearTimeout(hEntry.timer)
            pendingHourglass.delete(msgKey.id)
          }
          await sock.sendMessage(msgKey.remoteJid, { react: { text: msg.emoji || '🫡', key: msgKey } })
          console.log(`[bot] Reacted ${msg.emoji || '🫡'} to #${msg.todo_id}`)
        }
      } else {
        if (!msg.text?.trim()) { console.log('[outbox] Skipping blank message'); continue }
        const jid = msg.to || MY_JID

        // Clear all pending hourglasses — text reply replaces them
        for (const [id, hEntry] of pendingHourglass.entries()) {
          clearTimeout(hEntry.timer)
          if (hEntry.isSet) {
            // Remove the ⏳ before we send the reply
            sock.sendMessage(hEntry.jid, { react: { text: '', key: hEntry.msgKey } }).catch(() => {})
          }
          pendingHourglass.delete(id)
        }

        await smartSend(jid, msg.text)
        clearTyping(jid)
        if (msg.pending_question_item_id) {
          const s = readState()
          s.pending_question_item_id = msg.pending_question_item_id
          s.pending_question_asked_at = new Date().toISOString()
          writeState(s)
        }
      }
    } catch (e) {
      console.error('[outbox]', e.message)
      failed.push(msg)
    }
  }
  // Write back only what failed (or empty if all succeeded)
  fs.writeFileSync(OUTBOX_PATH, JSON.stringify(failed, null, 2))
  outboxRunning = false
}

// ── Scheduled messages ────────────────────────────────────────

async function checkScheduled() {
  if (!sock || !_wsConnected) return
  let entries = []
  try { entries = JSON.parse(fs.readFileSync(SCHEDULED_PATH, 'utf8')) } catch { return }
  if (!entries.length) return

  const now = new Date()
  const remaining = []
  let changed = false

  for (const entry of entries) {
    if (!entry?.send_at || !entry?.text) continue  // skip malformed entries
    const sendAt = new Date(entry.send_at)
    if (isNaN(sendAt.getTime())) continue  // skip invalid dates
    if (sendAt <= now && sendAt > new Date(now - 15 * 60 * 1000)) {
      if (!sock || !_wsConnected) { remaining.push(entry); continue }  // re-guard (race condition)
      try {
        await smartSend(MY_JID, entry.text)
        if (entry.todo_id) storeLastBotMessage(entry.text, entry.todo_id)
        changed = true
      } catch (e) {
        console.error('[scheduled]', e.message)
        remaining.push(entry)
      }
    } else if (sendAt > now) {
      remaining.push(entry)
    }
  }
  if (changed || remaining.length !== entries.length) {
    fs.writeFileSync(SCHEDULED_PATH, JSON.stringify(remaining, null, 2))
  }
}

// ── WhatsApp connection ───────────────────────────────────────

async function startBot() {
  const myGen = ++_socketGen    // capture this call's generation
  _reconnecting = false
  _wsConnected = false

  // Tear down any existing socket — this fires a 'close' event on the OLD
  // socket's handler, but that handler checks myGen vs _socketGen and self-ignores.
  if (sock) {
    try { sock.end(undefined) } catch {}
    sock = null
    await new Promise(r => setTimeout(r, 500))  // let WA server see the close before reconnecting
  }

  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    version, auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Desktop'),
    getMessage: async () => ({ conversation: '' }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (_socketGen !== myGen) return  // stale socket — ignore all its events
    if (qr) { console.log('\n[bot] Scan QR:\n'); qrcode.generate(qr, { small: true }) }
    if (connection === 'open') {
      _wsConnected = true
      console.log('[bot] Connected ✓')
      // Delay recovery slightly so we know this isn't a transient connection
      setTimeout(() => {
        if (_wsConnected && _socketGen === myGen) recoverMissedReminders().catch(console.error)
      }, 3000)
    }
    if (connection === 'close') {
      _wsConnected = false
      const code = lastDisconnect?.error?.output?.statusCode
      const msg = lastDisconnect?.error?.message || ''
      console.log(`[bot] Disconnect — code: ${code}, reason: ${msg}`)
      if (code === DisconnectReason.loggedOut) {
        console.log('[bot] Logged out — delete auth_info/ and restart')
      } else if (code === DisconnectReason.connectionReplaced) {
        // Another session took over — wait longer before reconnecting
        if (!_reconnecting) {
          _reconnecting = true
          console.log('[bot] Session replaced by another client — reconnecting in 15s...')
          setTimeout(startBot, 15000)
        }
      } else if (!_reconnecting) {
        _reconnecting = true
        console.log('[bot] Disconnected, reconnecting in 5s...')
        setTimeout(startBot, 5000)
      } else {
        console.log('[bot] Reconnect already scheduled, skipping duplicate')
      }
    }
  })

  // ── Seen IDs (dedup across restarts) ──
  const st = readState()
  const seenMsgIds = new Set(st.seen_msg_ids || [])
  function markSeen(id) {
    seenMsgIds.add(id)
    const s = readState(); s.seen_msg_ids = [...seenMsgIds].slice(-500); writeState(s)
  }

  // ── Incoming messages ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = new message. 'append' = delivered while offline (reconnect).
    // Both are processed; seenMsgIds deduplicates.
    if (type !== 'notify' && type !== 'append') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (msg.key.remoteJid?.endsWith('@g.us')) continue
      if (msg.key.remoteJid?.endsWith('@broadcast')) continue  // status/broadcast updates
      if (!WHITELISTED_JIDS.has(msg.key.remoteJid)) {
        // Log non-whitelisted once per JID so we can identify new @lid JIDs for MY_LID env var
        console.log(`[bot] Ignored message from non-whitelisted JID: ${msg.key.remoteJid}`)
        continue
      }
      if (seenMsgIds.has(msg.key.id)) continue
      markSeen(msg.key.id)

      // Voice note
      if (msg.message?.audioMessage?.ptt) {
        console.log('[voice] Received voice note, transcribing...')
        // Blue tick — received
        sock.readMessages([msg.key]).catch(() => {})
        // Show typing during transcription
        showTyping(msg.key.remoteJid)
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage
          })
          const transcription = await transcribeAudio(buf)
          if (!transcription) { console.log('[voice] Empty transcription'); continue }
          console.log(`[voice] Transcribed: "${transcription}"`)
          // Only set last_was_voice after successful transcription
          const s = readState(); s.last_was_voice = true; writeState(s)
          // handleMessage will re-set typing + schedule hourglass
          handleMessage(msg, transcription).catch(e => console.error('[handler]', e.message))
        } catch (e) {
          console.error('[voice] Transcription error:', e.message)
          clearTyping(msg.key.remoteJid)
          // Don't set last_was_voice — transcription failed, reply in text
        }
        continue
      }

      // Text message
      const text = extractText(msg)
      if (!text.trim()) continue
      handleMessage(msg, text.trim()).catch(e => console.error('[handler]', e.message))
    }
  })

  // ── 👍 reaction on a bot reminder = mark task done ──
  sock.ev.on('messages.reaction', async (updates) => {
    for (const update of updates) {
      if (update.reaction?.text !== '👍') continue
      const reactedKey = update.key
      if (!reactedKey?.id) continue

      let keys = {}
      try { keys = JSON.parse(fs.readFileSync(MSGKEYS_PATH, 'utf8')) } catch {}
      const entry = Object.entries(keys).find(([, k]) => k.id === reactedKey.id)
      if (!entry) continue

      const [todoId] = entry
      const rows = readCSV()
      const row  = rows.find(r => r.id === todoId)
      if (!row || row.completed === 'true') continue

      row.completed = 'true'
      row.completed_at = new Date().toISOString()
      writeCSV(rows)
      gitSync(`complete: ${row.raw_message.slice(0, 40)}`).catch(() => {})
      console.log(`[bot] 👍 reaction → completed #${todoId}: "${row.raw_message}"`)
      sock.sendMessage(reactedKey.remoteJid || MY_JID, {
        react: { text: '✅', key: reactedKey }
      }).catch(() => {})
    }
  })

  // ── Watch outbox for instant response (file event, not just polling) ──
  if (!fs.existsSync(OUTBOX_PATH)) fs.writeFileSync(OUTBOX_PATH, '[]')
  let watchDebounce = null
  fs.watch(OUTBOX_PATH, () => {
    clearTimeout(watchDebounce)
    watchDebounce = setTimeout(() => processOutbox().catch(console.error), 300)
  })

  if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true })

  console.log('[bot] Stream Bot starting...')
  console.log('[bot] claude.exe:', findClaudeExe())
}

// ── Local web server (localhost:3001) ─────────────────────────

const LOCAL_PORT = 3001

const LOCAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Stream</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#f5f5f8;min-height:100vh;padding:24px}
  .wrap{max-width:680px;margin:0 auto}
  h1{font-size:18px;font-weight:700;color:#111;margin-bottom:2px}
  .sub{font-size:12px;color:#999;margin-bottom:20px}

  /* Add card */
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.07);
    padding:20px 24px;margin-bottom:20px}
  textarea{width:100%;border:1px solid #e0e0e9;border-radius:8px;padding:10px 12px;
    font-family:inherit;font-size:14px;resize:none;height:72px;outline:none;
    transition:border .15s;color:#111}
  textarea:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
  .add-btn{margin-top:10px;background:#2563eb;color:#fff;border:none;
    border-radius:8px;padding:9px 18px;font-size:14px;font-weight:500;cursor:pointer;
    transition:background .15s}
  .add-btn:hover{background:#1d4ed8}
  .add-btn:disabled{background:#93c5fd;cursor:default}
  .toast{display:none;margin-top:10px;padding:8px 12px;border-radius:8px;font-size:13px}
  .toast.ok{background:#dcfce7;color:#166534;display:block}
  .toast.err{background:#fee2e2;color:#991b1b;display:block}

  /* Filters */
  .filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
  .filters select,.filters input{border:1px solid #e0e0e9;border-radius:6px;padding:5px 9px;
    font-size:13px;background:#fff;outline:none;color:#333}
  .filters input{flex:1;min-width:120px}
  .count{font-size:12px;color:#999;margin-left:auto}

  /* Todo list */
  .todo-list{display:flex;flex-direction:column;gap:8px}
  .todo{background:#fff;border-radius:10px;padding:12px 16px;
    box-shadow:0 1px 4px rgba(0,0,0,.06);display:flex;gap:12px;align-items:flex-start;
    border-left:3px solid transparent;transition:opacity .2s}
  .todo.pri-high{border-left-color:#ef4444}
  .todo.pri-normal{border-left-color:#3b82f6}
  .todo.pri-low{border-left-color:#d1d5db}
  .todo.completed{opacity:.45}
  .todo-check{width:18px;height:18px;accent-color:#2563eb;margin-top:2px;flex-shrink:0;cursor:pointer}
  .todo-body{flex:1;min-width:0}
  .todo-msg{font-size:14px;color:#111;line-height:1.4;word-break:break-word}
  .todo-meta{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center}
  .badge{font-size:11px;padding:2px 7px;border-radius:4px;font-weight:500}
  .badge-cat{background:#eff6ff;color:#1d4ed8}
  .badge-pri-high{background:#fef2f2;color:#b91c1c}
  .badge-pri-normal{background:#f0f9ff;color:#0369a1}
  .badge-pri-low{background:#f9fafb;color:#6b7280}
  .badge-reminder{background:#fefce8;color:#854d0e}
  .badge-id{background:#f3f4f6;color:#9ca3af;font-size:10px}
  .todo-actions{display:flex;gap:6px;flex-shrink:0}
  .btn-icon{background:none;border:1px solid #e5e7eb;border-radius:6px;
    padding:4px 8px;font-size:12px;cursor:pointer;color:#6b7280;
    transition:all .15s;white-space:nowrap}
  .btn-icon:hover{background:#f3f4f6;color:#111}
  .btn-icon.danger:hover{background:#fee2e2;border-color:#fca5a5;color:#dc2626}

  /* Edit modal */
  .modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);
    z-index:100;align-items:center;justify-content:center}
  .modal-bg.open{display:flex}
  .modal{background:#fff;border-radius:14px;padding:24px 28px;width:100%;max-width:460px;
    box-shadow:0 8px 40px rgba(0,0,0,.18)}
  .modal h2{font-size:15px;font-weight:600;margin-bottom:16px}
  .field{margin-bottom:14px}
  .field label{display:block;font-size:12px;color:#666;margin-bottom:4px;font-weight:500}
  .field input,.field select,.field textarea{width:100%;border:1px solid #e0e0e9;border-radius:7px;
    padding:8px 11px;font-size:13px;font-family:inherit;outline:none;color:#111}
  .field input:focus,.field select:focus,.field textarea:focus{border-color:#2563eb}
  .field textarea{resize:vertical;min-height:60px}
  .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .btn-save{background:#2563eb;color:#fff;border:none;border-radius:7px;
    padding:8px 18px;font-size:13px;font-weight:500;cursor:pointer}
  .btn-save:hover{background:#1d4ed8}
  .btn-cancel{background:#f3f4f6;color:#374151;border:none;border-radius:7px;
    padding:8px 14px;font-size:13px;cursor:pointer}
  .btn-cancel:hover{background:#e5e7eb}

  .loading{text-align:center;color:#999;padding:32px;font-size:14px}
  .empty{text-align:center;color:#bbb;padding:32px;font-size:14px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Stream</h1>
  <div class="sub">Deep's task list</div>

  <!-- Add form -->
  <div class="card">
    <textarea id="addText" placeholder="Get milk on the way home&#10;Meeting with Arjun Thursday 3pm&#10;Find a good book on Indian independence"></textarea>
    <button class="add-btn" id="addBtn" onclick="addItem()">Add</button>
    <div class="toast" id="addToast"></div>
  </div>

  <!-- Filters -->
  <div class="filters">
    <input id="search" placeholder="Search…" oninput="renderList()" />
    <select id="catFilter" onchange="renderList()">
      <option value="">All categories</option>
      <option>errands</option><option>books</option>
      <option>india-rci</option><option>creative</option><option>misc</option>
    </select>
    <select id="priFilter" onchange="renderList()">
      <option value="">All priorities</option>
      <option>high</option><option>normal</option><option>low</option>
    </select>
    <select id="showFilter" onchange="renderList()">
      <option value="active">Active</option>
      <option value="all">All incl. done</option>
      <option value="completed">Completed</option>
    </select>
    <span class="count" id="count"></span>
  </div>

  <!-- List -->
  <div class="todo-list" id="list"><div class="loading">Loading…</div></div>
</div>

<!-- Edit modal -->
<div class="modal-bg" id="modalBg" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <h2>Edit task</h2>
    <div class="field"><label>Task</label>
      <textarea id="eMsg" rows="2"></textarea></div>
    <div class="field"><label>Category</label>
      <select id="eCat">
        <option>errands</option><option>books</option>
        <option>india-rci</option><option>creative</option><option>misc</option>
      </select></div>
    <div class="field"><label>Priority</label>
      <select id="ePri">
        <option>high</option><option>normal</option><option>low</option>
      </select></div>
    <div class="field"><label>Reminder (leave blank to clear)</label>
      <input type="datetime-local" id="eReminder"/></div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-save" onclick="saveEdit()">Save</button>
    </div>
  </div>
</div>

<script>
  let todos = []
  let editId = null
  const addText = document.getElementById('addText')

  addText.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addItem()
  })

  async function load() {
    try {
      const r = await fetch('/api/todos')
      if (!r.ok) throw new Error(r.status)
      todos = await r.json()
      renderList()
    } catch(e) {
      document.getElementById('list').innerHTML = '<div class="empty">Failed to load — ' + e.message + '</div>'
    }
  }

  function renderList() {
    const search  = document.getElementById('search').value.toLowerCase()
    const cat     = document.getElementById('catFilter').value
    const pri     = document.getElementById('priFilter').value
    const show    = document.getElementById('showFilter').value

    let filtered = todos.filter(t => {
      if (show === 'active'    && (t.completed === 'true' || t.archived === 'true')) return false
      if (show === 'completed' && t.completed !== 'true') return false
      if (cat && t.category !== cat) return false
      if (pri && t.priority !== pri) return false
      if (search && !t.raw_message?.toLowerCase().includes(search)) return false
      return true
    })

    // Sort: high first, then by id desc
    filtered.sort((a, b) => {
      const pOrd = {high:0,normal:1,low:2}
      const pd = (pOrd[a.priority]||1) - (pOrd[b.priority]||1)
      return pd !== 0 ? pd : Number(b.id) - Number(a.id)
    })

    document.getElementById('count').textContent = filtered.length + ' item' + (filtered.length !== 1 ? 's' : '')

    if (!filtered.length) {
      document.getElementById('list').innerHTML = '<div class="empty">Nothing here</div>'
      return
    }

    document.getElementById('list').innerHTML = filtered.map(t => {
      const done = t.completed === 'true'
      const pri  = t.priority || 'normal'
      let reminder = ''
      if (t.reminder_at) {
        try {
          const d = new Date(t.reminder_at)
          reminder = '<span class="badge badge-reminder">⏰ ' + d.toLocaleString('en-GB',{timeZone:'Europe/London',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) + '</span>'
        } catch {}
      }
      return \`<div class="todo pri-\${pri} \${done?'completed':''}" id="row-\${t.id}">
        <input type="checkbox" class="todo-check" \${done?'checked':''} onchange="toggleDone('\${t.id}',this.checked)" title="Mark done"/>
        <div class="todo-body">
          <div class="todo-msg">\${esc(t.raw_message || '')}</div>
          <div class="todo-meta">
            <span class="badge badge-id">#\${t.id}</span>
            \${t.category ? '<span class="badge badge-cat">'+esc(t.category)+'</span>' : ''}
            \${t.priority ? '<span class="badge badge-pri-'+pri+'">'+pri+'</span>' : ''}
            \${reminder}
          </div>
        </div>
        <div class="todo-actions">
          <button class="btn-icon" onclick="openEdit('\${t.id}')" title="Edit">Edit</button>
          <button class="btn-icon danger" onclick="archiveItem('\${t.id}')" title="Archive">Archive</button>
        </div>
      </div>\`
    }).join('')
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  async function addItem() {
    const text = addText.value.trim()
    if (!text) return
    const btn = document.getElementById('addBtn')
    const toast = document.getElementById('addToast')
    btn.disabled = true; btn.textContent = 'Adding…'
    toast.className = 'toast'
    try {
      const r = await fetch('/add', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})})
      if (!r.ok) throw new Error(await r.text())
      toast.textContent = '✓ Added — processing…'; toast.className = 'toast ok'
      addText.value = ''
      setTimeout(load, 1500) // reload after processor has a moment
    } catch(e) {
      toast.textContent = 'Error: ' + e.message; toast.className = 'toast err'
    }
    btn.disabled = false; btn.textContent = 'Add'
  }

  async function toggleDone(id, checked) {
    await applyUpdate({ id, completed: checked ? 'true' : 'false', completed_at: checked ? new Date().toISOString() : '' })
  }

  async function archiveItem(id) {
    if (!confirm('Archive this item?')) return
    await applyUpdate({ id, archived: 'true' })
  }

  function openEdit(id) {
    const t = todos.find(x => x.id === id)
    if (!t) return
    editId = id
    document.getElementById('eMsg').value = t.raw_message || ''
    document.getElementById('eCat').value = t.category || 'misc'
    document.getElementById('ePri').value = t.priority || 'normal'
    if (t.reminder_at) {
      try {
        const d = new Date(t.reminder_at)
        // datetime-local expects YYYY-MM-DDTHH:MM in local time
        const pad = n => String(n).padStart(2,'0')
        document.getElementById('eReminder').value =
          d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
          'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      } catch { document.getElementById('eReminder').value = '' }
    } else {
      document.getElementById('eReminder').value = ''
    }
    document.getElementById('modalBg').classList.add('open')
    document.getElementById('eMsg').focus()
  }

  function closeModal() {
    document.getElementById('modalBg').classList.remove('open')
    editId = null
  }

  async function saveEdit() {
    if (!editId) return
    const reminderRaw = document.getElementById('eReminder').value
    const reminder_at = reminderRaw ? new Date(reminderRaw).toISOString() : ''
    await applyUpdate({
      id: editId,
      raw_message: document.getElementById('eMsg').value.trim(),
      category:    document.getElementById('eCat').value,
      priority:    document.getElementById('ePri').value,
      reminder_at
    })
    closeModal()
  }

  async function applyUpdate(update) {
    try {
      const r = await fetch('/api/updates', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ updates: [update] })
      })
      if (!r.ok) throw new Error(await r.text())
      await load()
    } catch(e) {
      alert('Save failed: ' + e.message)
    }
  }

  // Poll every 30s to catch bot-side changes
  load()
  setInterval(load, 30000)
</script>
</body>
</html>`

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Stream — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#f5f5f8;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);
    padding:28px 32px;width:100%;max-width:360px}
  h1{font-size:16px;font-weight:600;color:#111;margin-bottom:16px}
  input{width:100%;border:1px solid #e0e0e9;border-radius:8px;padding:10px 14px;
    font-size:14px;outline:none;margin-bottom:12px}
  input:focus{border-color:#2563eb}
  button{width:100%;background:#2563eb;color:#fff;border:none;border-radius:8px;
    padding:11px;font-size:14px;font-weight:500;cursor:pointer}
  button:hover{background:#1d4ed8}
  .err{color:#991b1b;font-size:13px;margin-top:8px;display:none}
</style></head>
<body><div class="card">
  <h1>Stream</h1>
  <input type="password" id="t" placeholder="Access token" autofocus/>
  <button onclick="login()">Enter</button>
  <div class="err" id="e">Wrong token</div>
</div>
<script>
  document.getElementById('t').addEventListener('keydown', e => { if(e.key==='Enter') login() })
  async function login() {
    const token = document.getElementById('t').value
    const r = await fetch('/auth', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})})
    if (r.ok) { location.href='/' } else { document.getElementById('e').style.display='block' }
  }
</script></body></html>`

function parseCookies(req) {
  const raw = req.headers.cookie || ''
  return Object.fromEntries(
    raw.split(';').map(c => {
      const eq = c.trim().indexOf('=')
      if (eq === -1) return [decodeURIComponent(c.trim()), '']
      return [decodeURIComponent(c.trim().slice(0, eq)), decodeURIComponent(c.trim().slice(eq + 1))]
    })
  )
}

function isAuthed(req) {
  if (!LOCAL_TOKEN) return true // no token set = open access
  const cookies = parseCookies(req)
  return cookies['stream_token'] === LOCAL_TOKEN
}

function startLocalServer() {
  const server = http.createServer((req, res) => {
    // Only accept localhost
    const host = req.headers.host || ''
    if (host !== `localhost:${LOCAL_PORT}` && host !== `127.0.0.1:${LOCAL_PORT}`) {
      res.writeHead(403).end('Forbidden')
      return
    }

    // Auth endpoint
    if (req.method === 'POST' && req.url === '/auth') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        try {
          const { token } = JSON.parse(body)
          if (LOCAL_TOKEN && token === LOCAL_TOKEN) {
            res.writeHead(200, {
              'Set-Cookie': `stream_token=${LOCAL_TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
              'Content-Type': 'application/json'
            })
            res.end(JSON.stringify({ ok: true }))
          } else {
            res.writeHead(401).end('Unauthorized')
          }
        } catch { res.writeHead(400).end('Bad request') }
      })
      return
    }

    // Auth gate — redirect to login if not authed
    if (!isAuthed(req)) {
      if (req.url === '/' || req.url === '') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(LOGIN_HTML)
      } else {
        res.writeHead(401).end('Unauthorized')
      }
      return
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(LOCAL_HTML)
      return
    }

    if (req.method === 'POST' && req.url === '/add') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body)
          if (!text?.trim()) { res.writeHead(400).end('No text'); return }

          // Write to CSV and trigger processor — same path as WhatsApp messages
          const rows  = readCSV()
          const newId = String(nextId(rows))
          rows.push({
            id: newId, timestamp: new Date().toISOString(), raw_message: text.trim(),
            category: '', priority: '', new: 'true', reminder_at: '',
            completed: 'false', completed_at: '', archived: 'false', brief_file: ''
          })
          writeCSV(rows)
          gitSync(`add: ${text.trim().slice(0, 40)}`).catch(() => {})
          runTier1Processor(newId, null, MY_JID).catch(e => console.error('[local]', e.message))
          console.log(`[local] Added #${newId}: "${text.trim()}"`)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, id: newId }))
        } catch (e) {
          res.writeHead(500).end(e.message)
        }
      })
      return
    }

    // GET /api/todos — return active todos as JSON
    if (req.method === 'GET' && req.url === '/api/todos') {
      try {
        const rows = readCSV()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rows))
      } catch (e) {
        res.writeHead(500).end(e.message)
      }
      return
    }

    // POST /api/updates — apply edits from the web UI
    if (req.method === 'POST' && req.url === '/api/updates') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        try {
          const { updates } = JSON.parse(body)
          if (!Array.isArray(updates) || !updates.length) {
            res.writeHead(400).end('updates must be a non-empty array')
            return
          }

          const rows = readCSV()
          let changed = 0

          for (const upd of updates) {
            const idx = rows.findIndex(r => r.id === String(upd.id))
            if (idx === -1) continue
            const allowed = ['raw_message','category','priority','reminder_at','reminder_sent','completed','completed_at','archived']
            for (const key of allowed) {
              if (upd[key] !== undefined) rows[idx][key] = upd[key]
            }
            // Auto-set completed_at when marking done
            if (upd.completed === 'true' && !rows[idx].completed_at) {
              rows[idx].completed_at = new Date().toISOString()
            }
            changed++
          }

          if (changed > 0) {
            writeCSV(rows)
            gitSync('updates from web').catch(() => {})
            console.log(`[local] Applied ${changed} update(s) from web UI`)
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, changed }))
        } catch (e) {
          res.writeHead(500).end(e.message)
        }
      })
      return
    }

    res.writeHead(404).end('Not found')
  })

  server.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`[local] Server running at http://localhost:${LOCAL_PORT}`)
  })
  server.on('error', e => console.error('[local]', e.message))
}

// Safety-net polling (file watcher is primary, this catches edge cases)
setInterval(() => processOutbox().catch(console.error), 5000)
setInterval(() => checkScheduled().catch(console.error), 30000)
setInterval(() => checkCleanup().catch(console.error), 60000) // nightly at 11pm

// ── Token keepalive ───────────────────────────────────────────
// Runs claude.exe with a trivial prompt every 6 hours so it refreshes
// the OAuth token to .credentials.json before it goes stale.
// Uses the existing Claude.ai subscription — no API credits needed.

let _tokenKeepaliveRunning = false

async function refreshTokenViaClaude() {
  if (_tokenKeepaliveRunning) return
  // Don't fight the processor for the session
  if (_processorRunning) { console.log('[token] Keepalive deferred — processor running'); return }
  _tokenKeepaliveRunning = true
  let claudeExe
  try { claudeExe = findClaudeExe() }
  catch (e) { console.error('[token] Keepalive skipped — claude.exe not found'); _tokenKeepaliveRunning = false; return }

  console.log('[token] Running keepalive to refresh OAuth token...')
  return new Promise(resolve => {
    const proc = spawn(claudeExe, ['--print', 'ok'], {
      cwd: __dirname, windowsHide: true,
      stdio: 'ignore', env: process.env
    })
    const timeout = setTimeout(() => { try { proc.kill() } catch {} }, 60000)
    proc.on('close', code => {
      clearTimeout(timeout)
      _tokenKeepaliveRunning = false
      console.log(`[token] Keepalive done (exit ${code}) — OAuth token refreshed`)
      resolve()
    })
    proc.on('error', e => {
      clearTimeout(timeout)
      _tokenKeepaliveRunning = false
      console.error('[token] Keepalive failed:', e.message)
      resolve()
    })
  })
}

// Proactive refresh every 6 hours — keeps token alive overnight without user intervention
cron.schedule('0 */6 * * *', () => {
  refreshTokenViaClaude().catch(e => console.error('[token] Keepalive cron error:', e.message))
})

// ── Tier 2: proactive heartbeat — every 20 minutes ────────────
cron.schedule('*/20 * * * *', () => {
  runTier2(async (text) => {
    if (!sock) return
    await smartSend(MY_JID, text)
    storeLastBotMessage(text, null)
  }).catch(e => console.error('[tier2]', e.message))
})

// ── Daily digest — 7:30am London time ────────────────────────
cron.schedule('30 7 * * *', () => {
  generateDailyDigest(async (text) => {
    if (!sock) return
    await smartSend(MY_JID, text)
    storeLastBotMessage(text, null)
  }).catch(e => console.error('[digest]', e.message))
}, { timezone: 'Europe/London' })

// Graceful shutdown — close WhatsApp socket before exiting so WA de-registers
// the session immediately, preventing code 440 "conflict" on the next start.
async function shutdown(signal) {
  console.log(`[bot] ${signal} received — shutting down gracefully...`)
  _reconnecting = true  // prevent reconnect attempts during shutdown
  _wsConnected = false
  if (sock) {
    try { sock.end(undefined) } catch {}
    sock = null
  }
  // Give the close signal 500ms to reach WA servers
  await new Promise(r => setTimeout(r, 500))
  console.log('[bot] Exiting.')
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// Prevent unknown async errors from crashing the process
process.on('unhandledRejection', (reason, promise) => {
  console.error('[bot] Unhandled rejection (not crashing):', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  // Log but don't exit — PM2 would restart anyway, but staying alive is better
  console.error('[bot] Uncaught exception (not crashing):', err.message)
})

startLocalServer()
startBot().catch(console.error)

// Refresh token immediately on startup if it's expired or expiring within 2 hours
;(async () => {
  const fs2 = fs
  const os2 = os
  try {
    const credsPath = path.join(os2.homedir(), '.claude', '.credentials.json')
    const creds = JSON.parse(fs2.readFileSync(credsPath, 'utf8'))
    const expiresAt = creds?.claudeAiOauth?.expiresAt || 0
    const hoursLeft = (expiresAt - Date.now()) / 3600000
    if (hoursLeft < 2) {
      console.log(`[token] Token expires in ${hoursLeft.toFixed(1)}h — running startup keepalive`)
      await refreshTokenViaClaude()
    } else {
      console.log(`[token] Token OK — expires in ${hoursLeft.toFixed(1)}h`)
    }
  } catch (e) {
    console.error('[token] Startup check failed:', e.message)
  }
})()
