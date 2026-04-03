/**
 * tier1.js — Reactive processor
 *
 * Handles every incoming message via a direct Anthropic API call (haiku).
 * Fast (3–6s), cheap, no subprocess overhead.
 * Returns structured JSON; the bot does all file writes.
 *
 * Does NOT: web search, read full todos.csv, write profile.md, run git.
 * Those belong to Tier 2 (proactive) or Tier 3 (research/cleanup).
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'csv-parse/sync'
import { markLastInterventionResponded, detectFeedback, recordFeedback } from './adaptive.js'
import { getTokenInfo } from './claude_token.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function getClient(forceRefresh = false) {
  const { token, isOAuth } = await getTokenInfo(forceRefresh)
  return isOAuth ? new Anthropic({ authToken: token }) : new Anthropic({ apiKey: token })
}

// ── Helpers ───────────────────────────────────────────────────

function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  catch { return fallback }
}

function readCSV() {
  try {
    const text = fs.readFileSync(path.join(__dirname, 'todos.csv'), 'utf8')
    return parse(text, { columns: true, skip_empty_lines: true })
  } catch { return [] }
}

function inferPeriod(now) {
  const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }))
  const hour = londonTime.getHours()
  const day  = londonTime.getDay() // 0=Sun, 1=Mon

  if (hour < 7 || hour >= 22) return 'night'
  if (day === 0 || day === 6)  return 'weekend'
  if (hour >= 7  && hour < 9)  return 'morning_commute'
  if (hour >= 9  && hour < 17) return 'work_hours'
  if (hour >= 17 && hour < 18) return 'drive_home'
  return 'evening'
}

function inferLocation(period, overrides, gps) {
  if (overrides?.location_override) return overrides.location_override
  // GPS-based inference if fresh (< 15 min old)
  if (gps?.lat && gps?.updated_at) {
    const ageMins = (Date.now() - new Date(gps.updated_at).getTime()) / 60000
    if (ageMins < 15) {
      const homeLat  = parseFloat(process.env.HOME_LAT || '0')
      const homeLng  = parseFloat(process.env.HOME_LNG || '0')
      const workLat  = parseFloat(process.env.WORK_LAT || '0')
      const workLng  = parseFloat(process.env.WORK_LNG || '0')
      const distHome = Math.hypot(gps.lat - homeLat, gps.lng - homeLng)
      const distWork = Math.hypot(gps.lat - workLat, gps.lng - workLng)
      if (distHome < 0.005) return 'home'       // ~400m radius
      if (distWork < 0.005) return 'Wellred Books'
      return 'in transit'
    }
  }
  if (period === 'work_hours') return 'Wellred Books'
  if (period === 'morning_commute') return 'commuting'
  if (period === 'drive_home') return 'driving home'
  return 'home'
}

// ── Build slim context for haiku ──────────────────────────────

function buildContext(newItems, inbox) {
  const now        = new Date()
  const worldState = readJSON(path.join(__dirname, 'world_state.json'), {})
  const state      = readJSON(path.join(__dirname, 'state.json'), {})
  const digest     = readJSON(path.join(__dirname, 'daily_digest.json'), null)
  const scheduled  = readJSON(path.join(__dirname, 'scheduled.json'), [])

  const period   = inferPeriod(now)
  const location = inferLocation(period, worldState.overrides, worldState.gps)

  const timeStr = now.toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit'
  })

  // Today's upcoming reminders
  const todayStr = now.toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
  const todayReminders = scheduled
    .filter(e => {
      const d = new Date(e.send_at)
      return d > now && d.toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) === todayStr
    })
    .sort((a, b) => new Date(a.send_at) - new Date(b.send_at))
    .slice(0, 5)
    .map(e => {
      const t = new Date(e.send_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
      return `${t}: ${e.text}`
    })

  // Active high-priority items
  const rows = readCSV()
  const highPri = rows
    .filter(r => r.priority === 'high' && r.completed !== 'true' && r.archived !== 'true')
    .slice(0, 3)
    .map(r => `#${r.id} ${r.raw_message}`)

  // Active concerns from world state
  const concerns = (worldState.active_concerns || []).slice(0, 3)

  // Conversation thread (last 15 messages) for context / anti-nag
  const history = state.conversation_history || []
  const conversationThread = history.length
    ? history.map(h => {
        const label = h.role === 'assistant' ? 'Stream' : 'Deep'
        const ts = h.ts ? new Date(h.ts).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : ''
        return `[${ts}] ${label}: ${h.text.slice(0, 120)}`
      }).join('\n')
    : ''

  // Fallback: last bot message for "done" context when no history
  const lbm = state.last_bot_message
  const lastBotCtx = !history.length && lbm?.text
    ? `Last message you sent Deep: "${lbm.text.slice(0, 80)}" (todo #${lbm.todo_id || 'none'}, sent ${lbm.sent_at})`
    : ''

  // Active overrides
  const overrides = worldState.overrides || {}
  const overrideSummary = [
    overrides.work_interruptions !== false ? 'Work interruptions: ok' : 'Work interruptions: defer to evenings',
    overrides.mood   ? `Mood signal: ${overrides.mood}`   : null,
    overrides.focus  ? `Focus area: ${overrides.focus}`   : null,
    ...(overrides.raw || []).slice(-3)
  ].filter(Boolean).join('\n')

  // Digest summary (pre-generated at 7:30am, stale after midnight)
  const digestSummary = digest && digest.date === now.toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
    ? [
        digest.flags?.length    ? `Flags: ${digest.flags.join(', ')}` : null,
        digest.india_rci_headlines?.length ? `India/RCI reading: ${digest.india_rci_headlines.slice(0,2).join(' | ')}` : null,
      ].filter(Boolean).join('\n')
    : null

  // Commute summary — only include if relevant and fresh
  const commute = worldState.commute
  const commuteSummary = commute?.summary && commute.relevant_window ? commute.summary : null

  return {
    timeStr,
    now: now.toISOString(),
    period,
    location,
    todayReminders,
    highPri,
    concerns,
    conversationThread,
    lastBotCtx,
    overrideSummary,
    digestSummary,
    commuteSummary,
    newItems,
    inbox
  }
}

// ── System prompt ─────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are Stream, Deep's personal secretary. You know him well.

Deep's profile (key facts):
- Works at Wellred Books (designer/typesetter) weekdays 9:30–5:30
- Secretary of his RCI branch (Monday 7pm meetings)
- Weekly call with Jatin (India/RCI) every Friday 1pm — prep on Thursday
- Branch agenda written every Sunday for Monday meeting
- Shops at Aldi mainly. Drive home (~5:30pm) = good window for errands
- Wants walks and exercise but needs specific nudges, not vague ones

Categories: errands | books | india-rci | creative | misc
Priority: high | normal | low

Your job on each message:
1. Classify and schedule any new items (set reminder_at if appropriate)
2. Detect preference/override signals and capture them
3. Reply warmly and briefly — like a person, not a bot
4. Reference today's context when useful (what else is on, what time it is)
5. If an item needs research ("find X", "best X"), flag it

TONE: Dry, warm, direct. One or two sentences max. Never bullet-point a reply unless asked.
Respond like a person who knows Deep's day, not like a receipt printer. Short is good; but never be so terse you leave him guessing whether something was actually done.

SILENCE: react_only = true is ONLY for genuinely silent operations — pure FYI notes or conversational context where no action was taken. Never use react_only for anything where an action was taken that Deep should know about (reminders set, items logged, research queued, etc).

REMINDERS: Confirm the time when set. If todayReminders already has other entries for the same day, reference them briefly — e.g. "Set for 5:10 — you've already got milk on the list, I'll mention both on the way home."
Whenever reminder_at is set on any item in todos_update, you MUST populate schedule with a corresponding entry and set a reply. Never use react_only: true when a reminder is being scheduled.

RESEARCH: When needs_research is true, always set reply to a brief acknowledgement like "On it — I'll look into that and come back to you." Never go react_only on a research item.

ANTI-NAG: Check the conversation thread before replying. If you've already said something about a topic in the last few messages, do NOT repeat it. If Deep has already acknowledged something, do not bring it up again.

CONVERSATIONAL ITEMS: Not every message is a todo. Apply these rules strictly:
- Greetings, test messages, acknowledgements ("thanks", "got it", "ok"), and confirmations ("did that work", "testing", "hello") are NOT todos. Set the item to completed=true, archived=true in todos_update. Use react_only=true if no further reply is needed, otherwise reply briefly.
- If a message is ambiguous — you're not sure if it's a command to log something or just conversation — ask: "Want me to log that?" Don't assume it's a todo.
- Simple factual questions (weather, time, "what's on today") should be answered directly from context if possible. If research is needed (e.g. live weather), flag needs_research=true and set the todo to completed=true so it doesn't sit open. Never leave a question as an active todo.
- The test is: would Deep expect to see this item in his active list tomorrow? If no, mark it done+archived now.

HONESTY: You can write todos, schedule reminders, patch world state, and send a reply.
You CANNOT write profile.md directly or clean up the todo list — those need the background processor (Tier 3).
If Deep asks you to log something to profile.md: set profile_note and confirm truthfully ("Queued for profile").
If Deep asks you to clean up / tidy the todo list: set needs_cleanup=true and say "On it — queued for cleanup".
NEVER say "Done" or "Logged" for something you haven't actually done. Say what you queued instead.

Reply format — return ONLY valid JSON, no markdown, no extra text:
When updating existing items (including new items you are classifying), always include "timestamp" set to the current ISO time so the frontend shows when Stream last touched the item.
{
  "todos_update": [{"id": "<existing id or null for new>", "category": "...", "priority": "...", "reminder_at": "<ISO or null>", "timestamp": "<current ISO time>"}],
  "schedule": [{"text": "Reminder text spoken-friendly", "send_at": "ISO timestamp", "todo_id": "N"}],
  "reply": "<text to send Deep, or null if react_only>",
  "react_only": false,
  "needs_research": false,
  "research_item_id": null,
  "profile_note": null,
  "needs_cleanup": false,
  "world_state_patch": {
    "overrides": {},
    "active_concerns": []
  }
}`
}

// ── Main processor ────────────────────────────────────────────

export async function runTier1(newItems, inbox) {
  // Mark any recent Tier 2 intervention as responded-to (Deep is active)
  markLastInterventionResponded()

  // Detect explicit feedback in incoming messages (inbox only — not todo raw_message text)
  const incomingTexts = inbox.map(i => i.text || '').join(' ')

  const feedback = detectFeedback(incomingTexts)
  if (feedback) {
    // Get last bot message as context for what the feedback is about
    const state   = readJSON(path.join(__dirname, 'state.json'), {})
    const context = state.last_bot_message?.text || null
    recordFeedback(feedback, context)
  }

  const ctx = buildContext(newItems, inbox)

  const userMessage = `Current time: ${ctx.timeStr} (ISO: ${ctx.now})
Period: ${ctx.period} | Location: ${ctx.location}

Recent conversation thread (newest at bottom — use this to avoid repeating yourself):
${ctx.conversationThread || ctx.lastBotCtx || 'No recent messages'}

Active overrides:
${ctx.overrideSummary || 'none'}

Today's digest:
${ctx.digestSummary || 'not generated yet — will appear after 7:30am'}
${ctx.commuteSummary ? `\nCommute: ${ctx.commuteSummary}` : ''}
Active concerns:
${ctx.concerns.length ? ctx.concerns.join('\n') : 'none'}

High-priority items:
${ctx.highPri.length ? ctx.highPri.join('\n') : 'none'}

Today's upcoming reminders:
${ctx.todayReminders.length ? ctx.todayReminders.join('\n') : 'none scheduled'}

New items to process:
${JSON.stringify(ctx.newItems, null, 2)}

Inbox (replies/snooze requests):
${JSON.stringify(ctx.inbox, null, 2)}

Process the new items and inbox. Return JSON only.`

  let response
  try {
    const client = await getClient()
    response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: userMessage }]
    })
  } catch (e) {
    if (e.status === 401) {
      // Token expired — refresh and retry once
      const client = await getClient(true)
      response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: userMessage }]
      })
    } else throw e
  }

  const raw = response.content[0]?.text?.trim() || ''

  // Strip markdown fences if present
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim()

  let result
  try {
    result = JSON.parse(cleaned)
  } catch (e) {
    console.error('[tier1] JSON parse failed:', e.message, '\nRaw:', raw.slice(0, 200))
    // Fallback: silent react
    return { todos_update: [], reply: null, react_only: true, needs_research: false, world_state_patch: null }
  }

  // Update world state: apply patch (if any) + last_active in a single read/write
  updateWorldState(result.world_state_patch || null)

  return result
}

// ── World state helpers ───────────────────────────────────────

function updateWorldState(patch) {
  const wsPath = path.join(__dirname, 'world_state.json')
  const ws = readJSON(wsPath, {})
  const now = new Date()

  // Apply patch overrides/active_concerns if provided
  if (patch) {
    if (patch.overrides) {
      ws.overrides = { ...(ws.overrides || {}), ...patch.overrides }
      // Record raw override text for context
      if (patch.overrides._raw) {
        ws.overrides.raw = [...(ws.overrides.raw || []), patch.overrides._raw].slice(-10)
        delete ws.overrides._raw
      }
    }
    if (patch.active_concerns) {
      ws.active_concerns = patch.active_concerns
    }
  }

  // Always update last_active / period / location
  ws.last_active = now.toISOString()
  ws.current_period = inferPeriod(now)
  ws.inferred_location = inferLocation(ws.current_period, ws.overrides)
  ws.updated_at = now.toISOString()

  fs.writeFileSync(wsPath, JSON.stringify(ws, null, 2))
}
