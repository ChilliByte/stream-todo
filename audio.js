/**
 * audio.js
 * Voice pipeline — transcription, synthesis, and smart send.
 * sock is passed as a parameter; no global socket dependency.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffmpegLib from 'fluent-ffmpeg'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { readState, writeState } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

ffmpegLib.setFfmpegPath(ffmpegInstaller.path)

const GROQ_API_KEY     = process.env.GROQ_API_KEY
const GROQ_TTS_ENABLED = process.env.GROQ_TTS === '1'
const GROQ_TTS_VOICE   = process.env.GROQ_VOICE || 'tara'
const EDGE_VOICE       = process.env.EDGE_VOICE || 'en-GB-SoniaNeural'
export const VOICE_MIN_LENGTH = 30 // below this, always send text regardless of voice flag

// ── Context — track last bot message for "Done" detection ─────

const HISTORY_LIMIT = 15

export function appendHistory(role, text) {
  if (!text?.trim()) return
  const s = readState()
  const history = s.conversation_history || []
  history.push({ role, text: text.trim(), ts: new Date().toISOString() })
  s.conversation_history = history.slice(-HISTORY_LIMIT)
  writeState(s)
}

export function storeLastBotMessage(text, todoId = null) {
  const s = readState()
  s.last_bot_message = { text, todo_id: todoId, sent_at: new Date().toISOString() }
  writeState(s)
  if (text?.trim()) appendHistory('assistant', text)
}

// ── Transcription ─────────────────────────────────────────────

export async function transcribeAudio(audioBuffer) {
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

// ── Synthesis ─────────────────────────────────────────────────

export async function synthesizeSpeech(text) {
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

export function mp3ToOpus(mp3Buffer) {
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

export async function sendVoice(jid, text, sockRef) {
  const mp3  = await synthesizeSpeech(text)
  const opus = await mp3ToOpus(mp3)
  await sockRef.sendMessage(jid, { audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true })
  console.log(`[voice] Sent: "${text.slice(0, 60)}"`)
}

export async function smartSend(jid, text, sockRef, forceTts = false) {
  if (!text?.trim()) return // never send blank
  const state    = readState()
  const useVoice = (forceTts || state.last_was_voice) && text.length >= VOICE_MIN_LENGTH

  // Store for "Done" context detection
  storeLastBotMessage(text)

  if (useVoice) {
    try {
      await sendVoice(jid, text, sockRef)
      if (state.last_was_voice) { state.last_was_voice = false; writeState(state) }
      return
    } catch (e) {
      console.error('[voice] TTS failed, falling back to text:', e.message)
    }
  }
  await sockRef.sendMessage(jid, { text })
  console.log(`[bot] Sent text: "${text.slice(0, 60)}"`)
}
