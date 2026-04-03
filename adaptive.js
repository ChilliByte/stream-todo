/**
 * adaptive.js — Learning and self-improvement
 *
 * Tracks intervention outcomes, captures explicit feedback,
 * and feeds patterns back into Tier 2's reasoning.
 *
 * Three mechanisms:
 * 1. Intervention logging — every Tier 2 message is logged with outcome tracking
 * 2. Outcome resolution — did Deep respond? ignore? snooze?
 * 3. Feedback capture — "good shout", "stop doing X" etc. → profile notes
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __dirname        = path.dirname(fileURLToPath(import.meta.url))
const WORLD_STATE_PATH = path.join(__dirname, 'world_state.json')
const PROFILE_PATH     = path.join(__dirname, 'profile.md')

// ── Helpers ───────────────────────────────────────────────────

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

function getWS()    { return readJSON(WORLD_STATE_PATH, {}) }
function saveWS(ws) { ws.updated_at = new Date().toISOString(); writeJSON(WORLD_STATE_PATH, ws) }

// ── Intervention logging ──────────────────────────────────────

export function logIntervention(message, type = 'proactive') {
  const ws  = getWS()
  const log = ws.intervention_log || []

  const entry = {
    id:         crypto.randomUUID(),
    timestamp:  new Date().toISOString(),
    type,
    preview:    message.slice(0, 100),
    outcome:    null,
    outcome_at: null
  }

  log.push(entry)
  ws.intervention_log = log.slice(-50) // keep last 50
  saveWS(ws)
  return entry.id
}

// ── Outcome resolution ────────────────────────────────────────

// Called by Tier 1 when Deep sends any message — marks recent intervention as responded
export function markLastInterventionResponded() {
  const ws  = getWS()
  const log = ws.intervention_log || []

  const RESPONSE_WINDOW_MS = 45 * 60 * 1000 // 45 min
  const now = Date.now()

  // Find the most recent unresolved intervention within the window
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    const age = now - new Date(entry.timestamp).getTime()
    if (age > RESPONSE_WINDOW_MS) break  // too old, stop scanning
    if (entry.outcome !== null) continue  // already resolved, skip
    // Found the most recent unresolved within window
    entry.outcome    = 'responded'
    entry.outcome_at = new Date().toISOString()
    break
  }

  ws.intervention_log = log
  saveWS(ws)
}

// Called by Tier 2 heartbeat — marks old unresolved interventions as ignored
export function resolveStaleInterventions() {
  const ws  = getWS()
  const log = ws.intervention_log || []
  const IGNORE_THRESHOLD_MS = 2 * 60 * 60 * 1000 // 2 hours
  const now = Date.now()
  let changed = false

  for (const entry of log) {
    if (entry.outcome !== null) continue
    if (now - new Date(entry.timestamp).getTime() > IGNORE_THRESHOLD_MS) {
      entry.outcome    = 'ignored'
      entry.outcome_at = new Date().toISOString()
      changed = true
    }
  }

  if (changed) { ws.intervention_log = log; saveWS(ws) }
}

// ── Outcome summary for Tier 2 prompt ────────────────────────

export function getOutcomeSummary() {
  const ws  = getWS()
  const log = (ws.intervention_log || []).filter(e => e.outcome !== null)

  if (!log.length) return 'No intervention history yet.'

  const total      = log.length
  const responded  = log.filter(e => e.outcome === 'responded').length
  const ignored    = log.filter(e => e.outcome === 'ignored').length
  const rate       = Math.round((responded / total) * 100)

  // Recent ignored ones — useful for Tier 2 to know what's not working
  const recentIgnored = log
    .filter(e => e.outcome === 'ignored')
    .slice(-5)
    .map(e => `  [${new Date(e.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}] ${e.preview}`)

  return [
    `Response rate: ${responded}/${total} (${rate}%)`,
    recentIgnored.length
      ? `Recently ignored:\n${recentIgnored.join('\n')}`
      : 'No recent ignored messages.'
  ].join('\n')
}

// ── Explicit feedback capture ─────────────────────────────────

const POSITIVE_RE = /\b(good shout|nice one|that('?s| was) (useful|helpful|good)|well done|cheers for that|appreciate it|spot on|exactly right|perfect timing)\b/i
const NEGATIVE_RE = /\b(stop (doing|sending|that)|don'?t (remind|send|do)|enough (of )?that|too many|annoying|leave it|drop it|not (now|useful|helpful))\b/i

export function detectFeedback(text) {
  const positive = POSITIVE_RE.test(text)
  const negative = NEGATIVE_RE.test(text)
  if (!positive && !negative) return null
  return { positive, negative, text }
}

export function recordFeedback(feedback, contextMessage = null) {
  if (!feedback) return
  const profile = fs.existsSync(PROFILE_PATH) ? fs.readFileSync(PROFILE_PATH, 'utf8') : ''
  const date    = new Date().toLocaleDateString('en-GB')
  const signal  = feedback.positive ? '✓ positive' : '✗ negative'
  const context = contextMessage ? ` (re: "${contextMessage.slice(0, 60)}")` : ''
  const note    = `- [${date}] ${signal}${context} — "${feedback.text.slice(0, 80)}" (1x observed)`

  // Append to ## Adaptive Notes section, or create it
  if (profile.includes('## Adaptive Notes')) {
    const updated = profile.replace(
      '## Adaptive Notes',
      `## Adaptive Notes\n${note}`
    )
    fs.writeFileSync(PROFILE_PATH, updated)
  } else {
    fs.writeFileSync(PROFILE_PATH, profile.trimEnd() + `\n\n## Adaptive Notes\n${note}\n`)
  }

  console.log(`[adaptive] Feedback recorded: ${signal}${context}`)
}

// ── Weekly reflection prompt fragment ────────────────────────
// Included in Tier 2's prompt so it can reason about patterns

export function getAdaptiveContext() {
  const ws  = getWS()
  const log = ws.intervention_log || []

  if (log.length < 3) return ''

  const outcomeSummary = getOutcomeSummary()

  // Time-of-day breakdown — when does Deep respond vs ignore?
  const byHour = {}
  for (const e of log.filter(l => l.outcome)) {
    const h = new Date(e.timestamp).getHours()
    if (!byHour[h]) byHour[h] = { responded: 0, ignored: 0 }
    byHour[h][e.outcome === 'responded' ? 'responded' : 'ignored']++
  }

  const goodHours = Object.entries(byHour)
    .filter(([, v]) => v.responded > v.ignored)
    .map(([h]) => `${h}:00`)
    .join(', ')

  const badHours = Object.entries(byHour)
    .filter(([, v]) => v.ignored > v.responded)
    .map(([h]) => `${h}:00`)
    .join(', ')

  return [
    '## Intervention outcome history',
    outcomeSummary,
    goodHours ? `Hours where Deep tends to respond: ${goodHours}` : '',
    badHours  ? `Hours where messages tend to be ignored: ${badHours}` : '',
  ].filter(Boolean).join('\n')
}
