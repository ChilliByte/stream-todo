/**
 * server.js
 * Localhost:3001 web server for the Stream task UI.
 * runTier1ProcessorFn and gitSyncFn are passed in to avoid circular imports.
 */

import http from 'http'
import { fileURLToPath } from 'url'
import path from 'path'
import { readCSV, writeCSV, nextId } from './db.js'

const __dirname   = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_PORT  = 3001
const LOCAL_TOKEN = process.env.LOCAL_TOKEN || null

export const LOCAL_HTML = `<!DOCTYPE html>
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

export const LOGIN_HTML = `<!DOCTYPE html>
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

export function parseCookies(req) {
  const raw = req.headers.cookie || ''
  return Object.fromEntries(
    raw.split(';').map(c => {
      const eq = c.trim().indexOf('=')
      if (eq === -1) return [decodeURIComponent(c.trim()), '']
      return [decodeURIComponent(c.trim().slice(0, eq)), decodeURIComponent(c.trim().slice(eq + 1))]
    })
  )
}

export function isAuthed(req) {
  if (!LOCAL_TOKEN) return true // no token set = open access
  const cookies = parseCookies(req)
  return cookies['stream_token'] === LOCAL_TOKEN
}

/**
 * @param {Function} runTier1ProcessorFn  - (newId, msg, jid) => Promise
 * @param {Function} gitSyncFn            - (msg) => Promise
 */
export function startLocalServer(runTier1ProcessorFn, gitSyncFn) {
  const MY_PHONE = process.env.MY_PHONE
  const MY_JID   = `${MY_PHONE}@s.whatsapp.net`

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
          gitSyncFn(`add: ${text.trim().slice(0, 40)}`).catch(() => {})
          runTier1ProcessorFn(newId, null, MY_JID).catch(e => console.error('[local]', e.message))
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
            gitSyncFn('updates from web').catch(() => {})
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
