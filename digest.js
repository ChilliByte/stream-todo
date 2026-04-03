/**
 * digest.js — Daily morning digest
 *
 * Runs at 7:30am London time via cron.
 * Pre-generates a structured snapshot of the day so Tier 1 can
 * reference "what's on today" without scanning the full CSV each time.
 *
 * Also sends Deep a warm morning message if there's anything worth flagging.
 * Stored in daily_digest.json — read by Tier 1 on every message.
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'csv-parse/sync'
import { refreshWorldData } from './world_data.js'
import { getTokenInfo } from './claude_token.js'

const __dirname        = path.dirname(fileURLToPath(import.meta.url))
const DIGEST_PATH      = path.join(__dirname, 'daily_digest.json')
const WORLD_STATE_PATH = path.join(__dirname, 'world_state.json')
const SCHEDULED_PATH   = path.join(__dirname, 'scheduled.json')
const PROFILE_PATH     = path.join(__dirname, 'profile.md')

async function getClient(forceRefresh = false) {
  const { token, isOAuth } = await getTokenInfo(forceRefresh)
  return isOAuth ? new Anthropic({ authToken: token }) : new Anthropic({ apiKey: token })
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
function readCSV() {
  try {
    const text = fs.readFileSync(path.join(__dirname, 'todos.csv'), 'utf8')
    return parse(text, { columns: true, skip_empty_lines: true })
  } catch { return [] }
}

function londonNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }))
}

export async function generateDailyDigest(sendFn) {
  console.log('[digest] Generating daily digest...')

  // Refresh world data first
  await refreshWorldData().catch(e => console.error('[digest] World data refresh failed:', e.message))

  const ws        = readJSON(WORLD_STATE_PATH, {})
  const rows      = readCSV()
  const scheduled = readJSON(SCHEDULED_PATH, [])
  const lon       = londonNow()
  const dayName   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][lon.getDay()]
  const dateStr   = lon.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

  const active   = rows.filter(r => r.archived !== 'true' && r.completed !== 'true')
  const highPri  = active.filter(r => r.priority === 'high')
  const today    = lon.toLocaleDateString('en-GB')

  const todayReminders = scheduled
    .filter(e => {
      if (!e.send_at) return false
      return new Date(e.send_at).toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) === today
    })
    .sort((a, b) => new Date(a.send_at) - new Date(b.send_at))
    .map(e => {
      const t = new Date(e.send_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
      return { time: t, text: e.text, todo_id: e.todo_id }
    })

  // Special day flags
  const isFriday   = lon.getDay() === 5
  const isThursday = lon.getDay() === 4
  const isSunday   = lon.getDay() === 0
  const isMonday   = lon.getDay() === 1

  // News headlines (for Jatin prep on Thursdays)
  const wireHeadlines = (ws.news?.feeds?.['The Wire'] || []).map(i => i.title)
  const ukHeadlines   = [
    ...(ws.news?.feeds?.['BBC UK'] || []),
    ...(ws.news?.feeds?.['Morning Star'] || []),
    ...(ws.news?.feeds?.['Tribune'] || [])
  ].map(i => i.title).slice(0, 3)

  const prompt = `You are Stream. Generate a morning digest for Deep.

Date: ${dateStr}
Weather: ${ws.weather?.summary || 'unknown'}${ws.weather?.drive_home_rain_note ? ` — ${ws.weather.drive_home_rain_note}` : ''}
${ws.weather?.good_for_walk ? 'Good day for a walk if free.' : ''}

Today's scheduled reminders:
${todayReminders.length ? todayReminders.map(r => `${r.time}: ${r.text}`).join('\n') : 'None scheduled'}

High priority items:
${highPri.length ? highPri.map(r => `#${r.id} ${r.raw_message}`).join('\n') : 'None'}

Active items total: ${active.length}

Special flags:
${isFriday   ? '- FRIDAY: Jatin call at 1pm. Prep needed.' : ''}
${isThursday ? `- THURSDAY: Reading day for Jatin call tomorrow.\n${wireHeadlines.length ? 'The Wire headlines: ' + wireHeadlines.slice(0,2).join(' | ') : ''}` : ''}
${isSunday   ? '- SUNDAY: Branch agenda needs writing for Monday 7pm.' : ''}
${isMonday   ? '- MONDAY: Branch meeting tonight at 7pm.' : ''}

UK news worth knowing: ${ukHeadlines.join(' | ') || 'none'}

Generate two things and return as JSON only:

1. "digest" — a structured object (stored, read by Tier 1 throughout the day):
{
  "date": "${today}",
  "day": "${dayName}",
  "weather_summary": "...",
  "todays_reminders": [...],
  "high_priority": [...],
  "flags": [...],
  "india_rci_headlines": [...],
  "active_count": ${active.length}
}

2. "morning_message" — a short, warm, human message to send Deep (2–3 sentences max).
Reference the weather if interesting, flag the most important thing, and set the tone for the day.
If it's completely unremarkable and nothing needs flagging, set morning_message to null.

Return ONLY valid JSON: { "digest": {...}, "morning_message": "..." }`

  let result
  try {
    let client = await getClient()
    let response
    try {
      response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    } catch (e) {
      if (e.status === 401) {
        client = await getClient(true)
        response = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      } else throw e
    }
    const raw     = response.content[0]?.text?.trim() || ''
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim()
    result = JSON.parse(cleaned)
  } catch (e) {
    console.error('[digest] Generation failed:', e.message)
    // Write a minimal digest so Tier 1 still has something
    result = {
      digest: {
        date: today, day: dayName,
        weather_summary: ws.weather?.summary || '',
        todays_reminders: todayReminders,
        high_priority: highPri.map(r => ({ id: r.id, text: r.raw_message })),
        flags: [], india_rci_headlines: [], active_count: active.length
      },
      morning_message: null
    }
  }

  // Save digest
  result.digest.generated_at = new Date().toISOString()
  fs.writeFileSync(DIGEST_PATH, JSON.stringify(result.digest, null, 2))
  console.log('[digest] Saved to daily_digest.json')

  // Send morning message if there is one
  if (result.morning_message?.trim() && sendFn) {
    await sendFn(result.morning_message)
    console.log('[digest] Morning message sent:', result.morning_message.slice(0, 80))
  }

  return result
}
