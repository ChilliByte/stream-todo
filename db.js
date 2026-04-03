/**
 * db.js
 * Flat-file helpers — no Baileys/socket dependency.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))

export const CSV_PATH    = path.join(__dirname, 'todos.csv')
export const STATE_PATH  = path.join(__dirname, 'state.json')
export const INBOX_PATH  = path.join(__dirname, 'inbox.json')
export const OUTBOX_PATH = path.join(__dirname, 'outbox.json')

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }
  catch { return {} }
}
export function writeState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)) }

export function readCSV() {
  const text = fs.readFileSync(CSV_PATH, 'utf8')
  return parse(text, { columns: true, skip_empty_lines: true })
}
export function writeCSV(rows) {
  const out = stringify(rows, {
    header: true, quoted_string: true,
    columns: ['id','timestamp','raw_message','category','priority','new','reminder_at','completed','completed_at','archived','brief_file']
  })
  fs.writeFileSync(CSV_PATH, out)
}
export function nextId(rows) {
  if (!rows.length) return 1
  return Math.max(...rows.map(r => parseInt(r.id) || 0)) + 1
}

export function readInbox()  { try { return JSON.parse(fs.readFileSync(INBOX_PATH, 'utf8')) } catch { return [] } }
export function appendInbox(entry) { const i = readInbox(); i.push(entry); fs.writeFileSync(INBOX_PATH, JSON.stringify(i, null, 2)) }
export function readOutbox() { try { return JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) } catch { return [] } }

export function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  catch { return fallback }
}
