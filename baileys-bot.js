/**
 * baileys-bot.js
 * WhatsApp bridge — receives messages (text + voice), reacts, writes to CSV,
 * sends outbound messages and reminders as voice notes.
 */

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
import simpleGit from 'simple-git'
import qrcode from 'qrcode-terminal'
import { spawn, execSync } from 'child_process'
import cron from 'node-cron'
import { runTier1 } from './tier1.js'
import { runTier2 } from './tier2.js'
import { generateDailyDigest } from './digest.js'
import { createEvent as gcalCreateEvent } from './gcal.js'
import {
  CSV_PATH, STATE_PATH, INBOX_PATH, OUTBOX_PATH,
  readState, writeState,
  readCSV, writeCSV, nextId,
  readInbox, appendInbox, readOutbox, readJSON
} from './db.js'
import {
  transcribeAudio,
  sendVoice, smartSend,
  storeLastBotMessage, appendHistory
} from './audio.js'
import { startLocalServer, setCurrentQR, clearCurrentQR } from './server.js'

dotenv.config()

// Suppress hardcoded console spam from libsignal (Bad MAC, session errors on reconnect)
{
  const SUPPRESS = [/Session error:/, /Bad MAC/, /Failed to decrypt message/, /Closing open session/, /Closing session:/]
  const filter = (orig) => (...args) => {
    if (SUPPRESS.some(r => r.test(String(args[0] || '')))) return
    orig(...args)
  }
  console.error = filter(console.error.bind(console))
  console.warn  = filter(console.warn.bind(console))
  console.info  = filter(console.info.bind(console))
}

const __dirname      = path.dirname(fileURLToPath(import.meta.url))
const MSGKEYS_PATH   = path.join(__dirname, 'message_keys.json')
const SCHEDULED_PATH = path.join(__dirname, 'scheduled.json')
const AUTH_DIR        = path.join(__dirname, 'auth_info')
const BRIEFS_DIR      = path.join(__dirname, 'briefs')
const WORLD_STATE_PATH = path.join(__dirname, 'world_state.json')
const DIGEST_PATH      = path.join(__dirname, 'daily_digest.json')

const DEEP_PHONE = process.env.DEEP_PHONE
if (!DEEP_PHONE) { console.error('DEEP_PHONE not set in .env'); process.exit(1) }
const DEEP_JID = `${DEEP_PHONE}@s.whatsapp.net`

// JIDs allowed to send messages to the bot (Deep's number/s)
const WHITELISTED_JIDS = new Set([
  // Standard @s.whatsapp.net JID
  `${DEEP_PHONE}@s.whatsapp.net`,
  ...(process.env.MY_PERSONAL_PHONE ? [`${process.env.MY_PERSONAL_PHONE}@s.whatsapp.net`] : []),
  // WhatsApp @lid (Linked ID) format — newer devices send messages via @lid instead of @s.whatsapp.net
  // MY_LID is auto-detected from auth_info/creds.json on first run, or set manually in .env
  ...(process.env.MY_LID ? [`${process.env.MY_LID}@lid`] : []),
])
console.log('[bot] Whitelisted JIDs:', [...WHITELISTED_JIDS].join(', '))

// Local server auth token — set LOCAL_TOKEN in .env to enable, otherwise open
const LOCAL_TOKEN = process.env.LOCAL_TOKEN || null

if (!process.env.GROQ_API_KEY) { console.error('GROQ_API_KEY not set in .env'); process.exit(1) }

const git = simpleGit(__dirname)
let sock = null
let _wsConnected = false  // true only when WhatsApp connection is 'open'
let _reconnecting = false // guard against multiple concurrent startBot calls
let _socketGen = 0        // incremented each startBot; stale event handlers self-ignore
let _reconnectAttempts = 0 // for exponential backoff

// Small LRU cache so Baileys getMessage() can retry failed decryptions
const _msgCache = new Map()
function cacheMsg(key, msg) {
  _msgCache.set(key.id, msg)
  if (_msgCache.size > 200) _msgCache.delete(_msgCache.keys().next().value)
}

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

// ── Thin wrappers that bind the global sock ───────────────────
// audio.js exports sockRef-parameterised versions; these wrappers
// supply the global sock so the rest of baileys-bot.js is unchanged.

function _sendVoice(jid, text) { return sendVoice(jid, text, sock) }
function _smartSend(jid, text, forceTts = false) { return smartSend(jid, text, sock, forceTts) }

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
  sock?.sendPresenceUpdate('paused', jid || DEEP_JID).catch(() => {})
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
    'For messages to Deep: outbox.json [{to:"' + DEEP_PHONE + '@s.whatsapp.net",text:"<short spoken-friendly message>",pending_question_item_id:"<id or null>"}].',
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
          if (upd.timestamp)   { row.timestamp   = upd.timestamp;   changed = true }
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

    // Merge Tier 1 schedules into scheduled.json (dedup by todo_id to prevent double-reminders)
    if (result.schedule?.length) {
      const existing = readJSON(SCHEDULED_PATH, [])
      const existingIds = new Set(existing.map(e => e.todo_id).filter(Boolean))
      const newEntries = result.schedule.filter(e => !e.todo_id || !existingIds.has(e.todo_id))
      if (newEntries.length) {
        fs.writeFileSync(SCHEDULED_PATH, JSON.stringify([...existing, ...newEntries], null, 2))
        console.log(`[tier1] Scheduled ${newEntries.length} reminder(s)`)
      }
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
      await _smartSend(jid || DEEP_JID, result.reply)
      clearTyping(jid || DEEP_JID)
      storeLastBotMessage(result.reply, newItemId)
    }

    // Append profile_note under ## Adaptive Notes section in profile.md
    if (result.profile_note?.trim()) {
      try {
        const profilePath = path.join(__dirname, 'profile.md')
        const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : ''
        const date = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
        const note = `- ${result.profile_note.trim()} (${date})`
        let updated
        if (existing.includes('## Adaptive Notes')) {
          updated = existing.replace('## Adaptive Notes', `## Adaptive Notes\n${note}`)
        } else {
          updated = existing.trimEnd() + `\n\n## Adaptive Notes\n${note}\n`
        }
        fs.writeFileSync(profilePath, updated)
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
        runTier1Processor(null, null, DEEP_JID).catch(e => console.error('[tier1]', e.message))
      }
    }
  }
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
    // Pick up any new items that arrived while processor was busy (were skipped by runProcessor guard)
    const pending = readCSV().filter(r => r.new === 'true')
    if (pending.length > 0) {
      console.log(`[bot] ${pending.length} item(s) queued during processor run — processing now`)
      runTier1Processor(null, null, DEEP_JID).catch(e => console.error('[tier1]', e.message))
    }
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
    'For the uncertain items message: outbox.json [{to:"' + DEEP_PHONE + '@s.whatsapp.net",text:"<message>"}].',
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
        await _smartSend(DEEP_JID, `(Missed) ${entry.text}`)
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
  if (!sock || !_wsConnected || outboxRunning) return
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
          const event   = await gcalCreateEvent({ title: msg.title, start: msg.start, end: endTime, description: msg.description || '', colorId: msg.colorId })
          const day     = new Date(msg.start).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' })
          const time    = new Date(msg.start).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
          await _smartSend(DEEP_JID, `📅 Added to calendar — ${msg.title}, ${day} at ${time}`)
          console.log(`[gcal] Event created: ${msg.title}`)
        } catch (e) {
          console.error('[gcal] Failed to create event:', e.message)
          await _smartSend(DEEP_JID, `Couldn't add to calendar — ${e.message.includes('token') ? 'run: node gcal.js setup' : e.message}`)
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
        const jid = msg.to || DEEP_JID

        // Clear all pending hourglasses — text reply replaces them
        for (const [id, hEntry] of pendingHourglass.entries()) {
          clearTimeout(hEntry.timer)
          if (hEntry.isSet) {
            // Remove the ⏳ before we send the reply
            sock.sendMessage(hEntry.jid, { react: { text: '', key: hEntry.msgKey } }).catch(() => {})
          }
          pendingHourglass.delete(id)
        }

        await _smartSend(jid, msg.text)
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
        await _smartSend(DEEP_JID, entry.text)
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
    getMessage: async (key) => _msgCache.get(key.id) || { conversation: '' },
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 10_000,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (_socketGen !== myGen) return  // stale socket — ignore all its events
    if (qr) { console.log('\n[bot] Scan QR:\n'); qrcode.generate(qr, { small: true }); setCurrentQR(qr) }
    if (connection === 'open') {
      _wsConnected = true
      _reconnectAttempts = 0  // reset backoff on successful connect
      clearCurrentQR()        // QR no longer needed once connected
      console.log('[bot] Connected ✓')
      // Delay recovery slightly so we know this isn't a transient connection
      processOutbox().catch(console.error)
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
        // Phone took over — wait 45s for it to go idle before reconnecting
        if (!_reconnecting) {
          _reconnecting = true
          console.log('[bot] Session replaced by another client — reconnecting in 45s...')
          setTimeout(startBot, 45000)
        }
      } else if (!_reconnecting) {
        _reconnecting = true
        // Exponential backoff: 5s, 10s, 20s, 40s, 60s max
        _reconnectAttempts++
        const delay = Math.min(5000 * Math.pow(2, _reconnectAttempts - 1), 60000)
        console.log(`[bot] Disconnected (attempt ${_reconnectAttempts}), reconnecting in ${delay/1000}s...`)
        setTimeout(startBot, delay)
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
    // Trim in-memory Set to prevent unbounded growth in long sessions
    if (seenMsgIds.size > 600) {
      const arr = [...seenMsgIds]
      arr.slice(0, arr.length - 500).forEach(old => seenMsgIds.delete(old))
    }
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
      if (msg.message) cacheMsg(msg.key, msg.message)  // for getMessage() retry on Bad MAC

      // Live location / static location — update GPS in world_state
      const loc = msg.message?.liveLocationMessage || msg.message?.locationMessage
      if (loc?.degreesLatitude) {
        const ws = readJSON(WORLD_STATE_PATH, {})
        ws.gps = {
          lat: loc.degreesLatitude,
          lng: loc.degreesLongitude,
          accuracy_m: loc.accuracyInMeters || null,
          updated_at: new Date().toISOString(),
          is_live: !!msg.message?.liveLocationMessage
        }
        fs.writeFileSync(WORLD_STATE_PATH, JSON.stringify(ws, null, 2))
        console.log(`[location] GPS updated: ${loc.degreesLatitude.toFixed(4)}, ${loc.degreesLongitude.toFixed(4)}`)
        sock.readMessages([msg.key]).catch(() => {})
        continue  // don't process as a text command
      }

      // Voice note — ptt=true for recorded in-chat, ptt=false for forwarded voice notes
      if (msg.message?.audioMessage) {
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
      sock.sendMessage(reactedKey.remoteJid || DEEP_JID, {
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

// ── WhatsApp session keepalive ────────────────────────────────
// Sends a presence update every 4 minutes so WA servers treat the session
// as active and don't close it during idle periods.
// This is a WA-level heartbeat, separate from Baileys' TCP-level keepAliveIntervalMs.
setInterval(() => {
  if (sock && _wsConnected) {
    sock.sendPresenceUpdate('available', DEEP_JID).catch(() => {})
  }
}, 4 * 60 * 1000)

// ── Tier 2: proactive heartbeat — every 20 minutes ────────────
cron.schedule('*/20 * * * *', () => {
  runTier2(async (text) => {
    if (!sock) return
    await _smartSend(DEEP_JID, text)
    storeLastBotMessage(text, null)
  }).catch(e => console.error('[tier2]', e.message))
})

// ── Daily digest — 7:30am London time ────────────────────────
cron.schedule('30 7 * * *', () => {
  generateDailyDigest(async (text) => {
    if (!sock) return
    await _smartSend(DEEP_JID, text)
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

startLocalServer(runTier1Processor, gitSync)
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
