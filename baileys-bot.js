/**
 * baileys-bot.js
 * WhatsApp bridge — receives messages (text + voice), reacts, writes to CSV,
 * sends outbound messages and reminders as voice notes.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
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

dotenv.config()
ffmpegLib.setFfmpegPath(ffmpegInstaller.path)

const __dirname      = path.dirname(fileURLToPath(import.meta.url))
const CSV_PATH       = path.join(__dirname, 'todos.csv')
const STATE_PATH     = path.join(__dirname, 'state.json')
const INBOX_PATH     = path.join(__dirname, 'inbox.json')
const OUTBOX_PATH    = path.join(__dirname, 'outbox.json')
const MSGKEYS_PATH   = path.join(__dirname, 'message_keys.json')
const SCHEDULED_PATH = path.join(__dirname, 'scheduled.json')
const AUTH_DIR       = path.join(__dirname, 'auth_info')

const MY_PHONE = process.env.MY_PHONE
if (!MY_PHONE) { console.error('MY_PHONE not set in .env'); process.exit(1) }
const MY_JID = `${MY_PHONE}@s.whatsapp.net`

const GROQ_API_KEY = process.env.GROQ_API_KEY
if (!GROQ_API_KEY) { console.error('GROQ_API_KEY not set in .env'); process.exit(1) }
const EDGE_VOICE = process.env.EDGE_VOICE || 'en-GB-SoniaNeural'
const VOICE_MIN_LENGTH = 30 // below this, always send text regardless of voice flag

const git = simpleGit(__dirname)
let sock = null

// Track bot's own 👍 acks so we don't confuse them with user reactions
const botAcks = new Map() // msg_id → timestamp ms

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
    columns: ['id','timestamp','raw_message','category','priority','new','reminder_at','completed','completed_at','archived']
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

// ── Voice — synthesis (Edge Neural TTS) ──────────────────────

async function synthesizeSpeech(text) {
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

function storeLastBotMessage(text, todoId = null) {
  const s = readState()
  s.last_bot_message = { text, todo_id: todoId, sent_at: new Date().toISOString() }
  writeState(s)
}

// Detect "Done", "did it", "ok", "sorted", etc.
const COMPLETION_RE = /^(done|did it|yep|yeah|yea|ok|okay|got it|finished|sorted|complete[d]?|✅|👍)[\s!.]*$/i

// ── Typing indicator ──────────────────────────────────────────

function showTyping(jid) {
  sock?.sendPresenceUpdate('composing', jid).catch(() => {})
}
function clearTyping(jid) {
  sock?.sendPresenceUpdate('paused', jid).catch(() => {})
}

// ── Processor ─────────────────────────────────────────────────

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

  return [
    `Current time: ${timeStr} (ISO: ${now.toISOString()}).`,
    contextLine,
    'Read CLAUDE.md for your brief. Read profile.md for preferences. Read todos.csv and inbox.json.',
    'Act as Deep\'s personal secretary.',
    'For every new=true item: clean the text to a clear imperative, categorise, set priority, set new=false.',
    'Use the exact current time above to resolve relative times ("in 30 mins", "in an hour" → correct ISO timestamp).',
    'If inbox contains a reply like "done", "sorted", "did it" and context shows a recent todo, mark that todo complete in todos.csv.',
    'IMPORTANT: Never write entries with empty or null text to outbox.json — skip silently instead.',
    'For silently processed items: outbox.json [{type:"react",emoji:"🫡",todo_id:"<id>"}].',
    'For questions/messages: outbox.json [{to:"' + MY_PHONE + '@s.whatsapp.net",text:"<short spoken-friendly message>",pending_question_item_id:"<id or null>"}].',
    'Scheduled reminders: scheduled.json [{text:"<spoken-friendly reminder>",send_at:"<ISO>",todo_id:"<id>"}] — ALWAYS include todo_id.',
    'After processing, update todos.csv and profile.md.',
    'Then run: git -C "' + __dirname.replace(/\\/g, '\\\\') + '" add todos.csv profile.md outbox.json scheduled.json inbox.json && git -C "' + __dirname.replace(/\\/g, '\\\\') + '" commit -m "secretary" && git -C "' + __dirname.replace(/\\/g, '\\\\') + '" push'
  ].filter(Boolean).join(' ')
}

function runProcessor() {
  let claudeExe
  try { claudeExe = findClaudeExe() }
  catch (e) { console.error('[processor]', e.message); return }

  const proc = spawn(claudeExe, ['--print', '--dangerously-skip-permissions', buildProcessorPrompt()], {
    cwd: __dirname, detached: true, stdio: 'ignore', env: process.env
  })
  proc.unref()
  console.log('[bot] Processor invoked')
}

async function gitSync(msg = 'update') {
  try {
    await git.add('todos.csv')
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

  // Immediate 👍 ack — track so we don't confuse it with a user reaction
  botAcks.set(msg.key.id, Date.now())
  sock.sendMessage(jid, { react: { text: '👍', key: msg.key } }).catch(() => {})

  // Show typing while we process
  showTyping(jid)

  // UPDATES command (from frontend edit system)
  if (text.startsWith('UPDATES\n') || text.startsWith('UPDATES\r\n')) {
    appendInbox({ type: 'updates', text, timestamp: new Date().toISOString() })
    runProcessor()
    return
  }

  // Reply to a pending question
  if (state.pending_question_item_id) {
    appendInbox({ type: 'reply', text, item_id: state.pending_question_item_id, timestamp: new Date().toISOString() })
    state.pending_question_item_id = null
    writeState(state)
    runProcessor()
    return
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
  }

  // New to-do item
  const rows  = readCSV()
  const newId = String(nextId(rows))
  rows.push({
    id: newId, timestamp: new Date().toISOString(), raw_message: text,
    category: '', priority: '', new: 'true', reminder_at: '',
    completed: 'false', completed_at: '', archived: 'false'
  })
  writeCSV(rows)

  // Store message key for reactions and future ✅ acks
  try {
    const keys = JSON.parse(fs.readFileSync(MSGKEYS_PATH, 'utf8'))
    keys[newId] = msg.key
    fs.writeFileSync(MSGKEYS_PATH, JSON.stringify(keys, null, 2))
  } catch {
    fs.writeFileSync(MSGKEYS_PATH, JSON.stringify({ [newId]: msg.key }, null, 2))
  }

  console.log(`[bot] Stored #${newId}: "${text}"`)
  gitSync(`add: ${text.slice(0, 40)}`).catch(() => {})
  runProcessor()
}

// ── Outbox polling ────────────────────────────────────────────

let outboxRunning = false

async function processOutbox() {
  if (!sock || outboxRunning) return
  const messages = readOutbox()
  if (!messages.length) return
  outboxRunning = true
  fs.writeFileSync(OUTBOX_PATH, '[]')

  for (const msg of messages) {
    try {
      if (msg.type === 'react') {
        let keys = {}
        try { keys = JSON.parse(fs.readFileSync(MSGKEYS_PATH, 'utf8')) } catch {}
        const msgKey = keys[msg.todo_id]
        if (msgKey) {
          await sock.sendMessage(msgKey.remoteJid, { react: { text: msg.emoji || '🫡', key: msgKey } })
          console.log(`[bot] Reacted ${msg.emoji || '🫡'} to #${msg.todo_id}`)
        }
      } else {
        if (!msg.text?.trim()) { console.log('[outbox] Skipping blank message'); continue }
        const jid = msg.to || MY_JID
        await smartSend(jid, msg.text)
        clearTyping(jid)
        if (msg.pending_question_item_id) {
          const s = readState(); s.pending_question_item_id = msg.pending_question_item_id; writeState(s)
        }
      }
    } catch (e) { console.error('[outbox]', e.message) }
  }
  outboxRunning = false
}

// ── Scheduled messages ────────────────────────────────────────

async function checkScheduled() {
  if (!sock) return
  let entries = []
  try { entries = JSON.parse(fs.readFileSync(SCHEDULED_PATH, 'utf8')) } catch { return }
  if (!entries.length) return

  const now = new Date()
  const remaining = []
  let changed = false

  for (const entry of entries) {
    const sendAt = new Date(entry.send_at)
    if (sendAt <= now && sendAt > new Date(now - 5 * 60 * 1000)) {
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
  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  sock = makeWASocket({
    version, auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Stream', 'Chrome', '1.0.0'],
    getMessage: async () => ({ conversation: '' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { console.log('\n[bot] Scan QR:\n'); qrcode.generate(qr, { small: true }) }
    if (connection === 'open') console.log('[bot] Connected ✓')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('[bot] Logged out — delete auth_info/ and restart')
      } else {
        console.log('[bot] Disconnected, reconnecting...')
        setTimeout(startBot, 3000)
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
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (msg.key.remoteJid?.endsWith('@g.us')) continue
      if (seenMsgIds.has(msg.key.id)) continue
      markSeen(msg.key.id)

      // Voice note
      if (msg.message?.audioMessage?.ptt) {
        console.log('[voice] Received voice note, transcribing...')
        botAcks.set(msg.key.id, Date.now())
        sock.sendMessage(msg.key.remoteJid, { react: { text: '👍', key: msg.key } }).catch(() => {})
        showTyping(msg.key.remoteJid)
        const s = readState(); s.last_was_voice = true; writeState(s)
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage
          })
          const transcription = await transcribeAudio(buf)
          if (!transcription) { console.log('[voice] Empty transcription'); continue }
          console.log(`[voice] Transcribed: "${transcription}"`)
          handleMessage(msg, transcription).catch(e => console.error('[handler]', e.message))
        } catch (e) {
          console.error('[voice] Transcription error:', e.message)
          clearTyping(msg.key.remoteJid)
        }
        continue
      }

      // Text message
      const text = extractText(msg)
      if (!text.trim()) continue
      handleMessage(msg, text.trim()).catch(e => console.error('[handler]', e.message))
    }
  })

  // ── 👍 reaction = mark task done ──
  sock.ev.on('messages.reaction', async (updates) => {
    for (const update of updates) {
      if (update.reaction?.text !== '👍') continue
      const reactedKey = update.key
      if (!reactedKey?.id) continue

      // Skip the bot's own ack reactions (sent within last 5s)
      const ackTime = botAcks.get(reactedKey.id)
      if (ackTime && Date.now() - ackTime < 5000) continue

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

  console.log('[bot] Stream Bot starting...')
  console.log('[bot] claude.exe:', findClaudeExe())
}

// Safety-net polling (file watcher is primary, this catches edge cases)
setInterval(() => processOutbox().catch(console.error), 5000)
setInterval(() => checkScheduled().catch(console.error), 30000)

startBot().catch(console.error)
