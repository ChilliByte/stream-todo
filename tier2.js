/**
 * tier2.js — Proactive heartbeat
 *
 * Runs every 20 minutes during waking hours (7:30am–10pm London time).
 * Maintains the world model. Decides whether to intervene.
 * Never triggered by incoming messages — runs on its own clock.
 *
 * Uses haiku API (same as Tier 1) — no claude.exe needed for pattern detection.
 * Research briefs (needing web search) still go to claude.exe (Tier 3).
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'csv-parse/sync'
import { refreshWorldData } from './world_data.js'
import { logIntervention, resolveStaleInterventions, getAdaptiveContext } from './adaptive.js'
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

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function readCSV() {
  try {
    const text = fs.readFileSync(path.join(__dirname, 'todos.csv'), 'utf8')
    return parse(text, { columns: true, skip_empty_lines: true })
  } catch { return [] }
}

function londonNow() {
  const now = new Date()
  const londonTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }))
  return londonTime
}

function inferPeriod(now) {
  const hour = now.getHours()
  const day  = now.getDay()
  if (hour < 7 || hour >= 22) return 'night'
  if (day === 0 || day === 6)  return 'weekend'
  if (hour >= 7  && hour < 9)  return 'morning_commute'
  if (hour >= 9  && hour < 17) return 'work_hours'
  if (hour >= 17 && hour < 18) return 'drive_home'
  return 'evening'
}

// ── Guard: should the heartbeat run right now? ────────────────

function shouldRun() {
  const now  = londonNow()
  const hour = now.getHours()

  // Only during waking hours
  if (hour < 7 || hour >= 22) return false

  // Monday 7–9pm: branch meeting — don't interrupt
  if (now.getDay() === 1 && hour >= 19 && hour < 21) return false

  return true
}

// ── Synthesise todo patterns ──────────────────────────────────

function analyseTodos() {
  const rows = readCSV()
  const now  = new Date()

  const active     = rows.filter(r => r.archived !== 'true' && r.completed !== 'true')
  const highPri    = active.filter(r => r.priority === 'high')
  const staleDays  = 14
  const stale      = active.filter(r => {
    if (!r.timestamp) return false
    return (now - new Date(r.timestamp)) > staleDays * 86400 * 1000
  })

  // Detect repeated additions (same raw_message ~3 times)
  const msgCounts = {}
  for (const r of rows) {
    const key = r.raw_message?.toLowerCase().slice(0, 40)
    if (key) msgCounts[key] = (msgCounts[key] || 0) + 1
  }
  const repeated = Object.entries(msgCounts)
    .filter(([, n]) => n >= 3)
    .map(([msg]) => msg)

  // India/RCI last activity
  const indiaItems = rows.filter(r => r.category === 'india-rci')
  const lastIndiaDate = indiaItems.length
    ? new Date(Math.max(...indiaItems.map(r => new Date(r.timestamp || 0).getTime())))
    : null
  const indiasilentDays = lastIndiaDate
    ? Math.floor((now - lastIndiaDate) / 86400 / 1000)
    : 999

  // Creative drought
  const creativeItems = rows.filter(r => r.category === 'creative')
  const lastCreativeDate = creativeItems.length
    ? new Date(Math.max(...creativeItems.map(r => new Date(r.timestamp || 0).getTime())))
    : null
  const creativeSilentDays = lastCreativeDate
    ? Math.floor((now - lastCreativeDate) / 86400 / 1000)
    : 999

  return {
    active_count: active.length,
    high_priority: highPri.map(r => ({ id: r.id, msg: r.raw_message, age_days: Math.floor((now - new Date(r.timestamp)) / 86400 / 1000) })),
    stale: stale.map(r => ({ id: r.id, msg: r.raw_message, age_days: Math.floor((now - new Date(r.timestamp)) / 86400 / 1000) })),
    repeated_items: repeated,
    india_silent_days: indiasilentDays,
    creative_silent_days: creativeSilentDays
  }
}

// ── Build prompt for proactive engine ─────────────────────────

function buildProactivePrompt(ws, patterns, lon) {
  const dayName   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][lon.getDay()]
  const period    = inferPeriod(lon)
  const overrides = ws.overrides || {}
  const weather   = ws.weather
  const traffic   = ws.traffic
  const news      = ws.news

  const timeStr = lon.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit'
  })

  // Format news headlines
  const newsLines = []
  if (news?.feeds) {
    for (const [src, items] of Object.entries(news.feeds)) {
      newsLines.push(`${src}: ${items.map(i => i.title).join(' | ')}`)
    }
  }

  // Format weather/traffic context
  const envContext = [
    weather ? `Weather: ${weather.summary}${weather.drive_home_rain_note ? ` — ${weather.drive_home_rain_note}` : ''}${weather.good_for_walk ? ' — good day for a walk' : ''}` : null,
    traffic?.severe_disruptions ? `Traffic: ${traffic.summary}` : null,
  ].filter(Boolean).join('\n')

  // Format fitness context
  const fitness = ws.fitness
  const fitnessLines = []
  if (fitness) {
    fitnessLines.push(`Steps today: ${fitness.steps_today}`)
    if (fitness.steps_last_hour) fitnessLines.push(`Steps last hour: ${fitness.steps_last_hour}`)
    if (fitness.active_minutes)  fitnessLines.push(`Active minutes: ${fitness.active_minutes}`)
    if (fitness.sedentary_minutes > 0) fitnessLines.push(`Sedentary today: ${Math.round(fitness.sedentary_minutes)} min`)
    fitnessLines.push(`Exercised today: ${fitness.has_exercised_today ? 'yes' : 'no'}`)
    if (fitness.last_active_at) fitnessLines.push(`Last active: ${new Date(fitness.last_active_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })}`)
  }

  const adaptiveContext = getAdaptiveContext()

  return `You are Stream, Deep's proactive secretary. This is a background check — Deep has NOT just sent a message.

Current time: ${timeStr}
Day: ${dayName} | Period: ${period}

Active overrides (Deep's current preferences):
${JSON.stringify(overrides, null, 2)}

Environment:
${envContext || 'No environment data'}

Fitness & activity (from Google Fit):
${fitnessLines.length ? fitnessLines.join('\n') : 'unavailable — Google Fit not set up or no data yet'}

News headlines (use for Jatin call prep nudges or morning briefing — don't repeat if recently sent):
${newsLines.length ? newsLines.join('\n') : 'unavailable'}

Todo patterns:
${JSON.stringify(patterns, null, 2)}

Last active (Deep last messaged): ${ws.last_active || 'unknown'}
Interventions sent today: ${ws.interventions_today || 0}
Last intervention: ${ws.last_intervention || 'none today'}

${adaptiveContext}

Schedule anchors to check:
- Thursday after 14:00: Jatin call tomorrow — nudge reading if india_silent_days > 0. Include 1-2 relevant news headlines from The Wire if available.
- Sunday before 10:00: Branch agenda started?
- Friday morning: Jatin call prep reminder
- Drive home window (17:00–18:00): Cluster errand reminders. Mention rain or traffic if relevant.
- Weekend, good weather, no commitments: Suggest a walk specifically (e.g. "Clapham Common is 20 min away")
- Monday 19:00–21:00: Branch meeting — do NOT send anything

Fitness nudge rules (use fitness data above):
- steps_today < 3000 AND it's after 16:00 AND weather.good_for_walk → suggest a short walk on the way home or after work
- sedentary_minutes > 120 AND it's a workday AND work_hours period → gentle stretch/move nudge (once per day max)
- has_exercised_today = false AND it's weekend AND weather.good_for_walk → walk nudge, name a nearby place (Clapham Common, Tooting Bec, Brockwell Park)
- steps_last_hour < 50 AND sedentary_minutes > 60 → "You've barely moved in the last hour" nudge (only during evenings — never at work)
- If fitness data is unavailable, skip all fitness nudges silently

Intervention rules:
1. Max 2 interventions per day
2. Deep active in last 15 min = good window to surface something
3. Work hours interruptions: check overrides.work_interruptions (currently true = ok to send)
4. Never repeat a concern flagged in last 3 hours
5. Gentle, specific, one thing at a time
6. If response rate is low in current hour (from adaptive context), hold back unless high priority
7. Weather/traffic should feel natural, not like a news report — weave it into an actionable nudge

Decide: should you send a message right now?

Reply ONLY with valid JSON:
{
  "should_intervene": false,
  "message": null,
  "updated_concerns": [],
  "reasoning": "brief internal note on why/why not"
}`
}

// ── Main heartbeat ────────────────────────────────────────────

export async function runTier2(sendFn) {
  if (!shouldRun()) {
    console.log('[tier2] Outside active hours — skipping')
    return null
  }

  const wsPath   = path.join(__dirname, 'world_state.json')
  const lon      = londonNow()
  const patterns = analyseTodos()

  // Resolve any stale unresolved interventions before reading world state
  resolveStaleInterventions()

  // Refresh world data every 30 min (not every heartbeat to avoid hammering APIs)
  let ws = readJSON(wsPath, {})

  // ── Auto-expiry: clear inferred pause state when defer_nudges_until has passed ──
  const deferUntil = ws.overrides?.defer_nudges_until
  if (deferUntil && new Date(deferUntil) <= new Date()) {
    console.log('[tier2] defer_nudges_until has passed — clearing pause overrides')
    const PAUSE_KEYS = ['defer_nudges_until', 'conversation_mode', 'engagement_mode',
                        'response_threshold', 'priority_shift', 'no_sequential_instructions',
                        'no_sleep_reminders', 'sleep_disruption_escalating', 'nocturnal_messaging_pattern']
    if (ws.overrides) {
      for (const k of PAUSE_KEYS) delete ws.overrides[k]
    }
    fs.writeFileSync(wsPath, JSON.stringify(ws, null, 2))
  }

  const lastRefresh = ws.world_data_updated_at ? new Date(ws.world_data_updated_at) : null
  const refreshAgeMs = lastRefresh ? Date.now() - lastRefresh.getTime() : Infinity
  if (refreshAgeMs > 30 * 60 * 1000) {
    await refreshWorldData().catch(e => console.error('[tier2] World data refresh failed:', e.message))
    ws = readJSON(wsPath, {})  // pick up fresh weather/traffic/fitness/news
  }

  // Don't exceed 2 interventions/day
  const today = lon.toLocaleDateString('en-GB')
  if (ws.interventions_today_date !== today) {
    ws.interventions_today = 0
    ws.interventions_today_date = today
  }
  if ((ws.interventions_today || 0) >= 2) {
    console.log('[tier2] Hit daily intervention limit — skipping')
    return null
  }

  // Don't intervene if last intervention was < 90 min ago
  if (ws.last_intervention) {
    const minsAgo = (Date.now() - new Date(ws.last_intervention).getTime()) / 60000
    if (minsAgo < 90) {
      console.log(`[tier2] Last intervention ${Math.round(minsAgo)}m ago — skipping`)
      return null
    }
  }

  const prompt = buildProactivePrompt(ws, patterns, lon)

  let result
  try {
    let client = await getClient()
    let response
    try {
      response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }]
      })
    } catch (e) {
      if (e.status === 401) {
        client = await getClient(true)
        response = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }]
        })
      } else throw e
    }
    const raw     = response.content[0]?.text?.trim() || ''
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim()
    result = JSON.parse(cleaned)
  } catch (e) {
    console.error('[tier2] Failed:', e.message)
    return null
  }

  console.log(`[tier2] Decision: ${result.should_intervene ? 'INTERVENE' : 'skip'} — ${result.reasoning}`)

  // Update world state
  ws.current_period      = inferPeriod(lon)
  ws.active_concerns     = result.updated_concerns || ws.active_concerns || []
  ws.updated_at          = new Date().toISOString()

  if (result.should_intervene && result.message?.trim()) {
    await sendFn(result.message)
    logIntervention(result.message, 'proactive')
    ws.interventions_today = (ws.interventions_today || 0) + 1
    ws.last_intervention   = new Date().toISOString()
    console.log('[tier2] Sent intervention:', result.message.slice(0, 80))
  }

  writeJSON(wsPath, ws)
  return result
}
