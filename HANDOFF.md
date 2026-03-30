# Stream — Handoff & Reliability Overhaul Brief

This document is for a new Claude Code session. Read it fully before touching any code.

---

## What This Is

Stream is Deep's personal secretary. It runs on his home Windows PC as a WhatsApp bot (Baileys) + Claude Code CLI processor + GitHub Pages frontend. The soul of it: externalise Deep's working memory so his life is managed proactively, not reactively. It should feel like there's a thoughtful person running quietly in the background — not a task tracker he has to maintain.

Deep's life context is in `profile.md`. His operating instructions for the Claude processor are in `CLAUDE.md`. Read both before doing anything.

---

## Current Architecture

```
WhatsApp (Deep's phone)
    ↕ Baileys (unofficial WA Web multi-device)
baileys-bot.js          ← main process, runs via PM2
    → writes to todos.csv, inbox.json, message_keys.json
    → spawns claude.exe (processor) on each message
    → watches outbox.json for Claude's responses
    → sends WhatsApp replies / reactions
claude.exe              ← Claude Code CLI, spawned as subprocess
    ← reads CLAUDE.md, profile.md, todos.csv, inbox.json
    → writes outbox.json, scheduled.json, todos.csv, profile.md, briefs/
    → runs git add/commit/push
GitHub (stream-todo repo)
    → serves todos.csv, briefs/ via raw.githubusercontent.com
index.html              ← GitHub Pages frontend, polls CSV every 2 min
localhost:3001          ← quick-add form (built into baileys-bot.js)
```

### Key Files
| File | Purpose |
|---|---|
| `baileys-bot.js` | Everything: WA bridge, processor invocation, outbox handling, TTS, local server |
| `CLAUDE.md` | Instructions for the Claude processor subprocess |
| `profile.md` | Deep's preferences, schedule, verified observations |
| `todos.csv` | Live task list. Columns: `id, timestamp, raw_message, category, priority, new, reminder_at, completed, completed_at, archived, brief_file` |
| `outbox.json` | Claude writes responses here; bot watches + sends |
| `scheduled.json` | Claude writes future reminders; bot fires them on schedule |
| `inbox.json` | Bot writes replies/snooze requests for Claude to read |
| `message_keys.json` | Maps `todo_id → WhatsApp msg.key` for reactions |
| `state.json` | Bot runtime state: seen IDs, last bot message, pending question |
| `briefs/{id}.json` | Research briefs written by Claude |
| `processor_prompt.txt` | Written before each Claude invocation (avoids shell quoting issues) |
| `processor.log` | Claude subprocess stdout/stderr |
| `.env` | `MY_PHONE`, `CLAUDE_CODE_OAUTH_TOKEN`, `GROQ_API_KEY`, `EDGE_VOICE` |

---

## What's Working

- WhatsApp message receive + send
- Blue tick (read receipt) on arrival
- ⏳ hourglass react if Claude takes >5s, 🫡 when done silently, clears hourglass for text replies
- 👍 for pings ("hey", "test"), ❤️ for thanks
- Voice note receive → Groq Whisper STT → process as text
- TTS reply via msedge-tts (en-GB-SoniaNeural) for long messages or voice-initiated
- Completion detection: "done/sorted/yep" within 2h of a reminder → marks todo complete
- Snooze: reply "snooze" or "snooze 2h" → Claude picks context-aware new time
- Nightly cleanup at 11pm: archives confirmed-done items, asks about stale ones
- Research briefs: Claude writes `briefs/{id}.json`, frontend shows 📋 badge + inline card
- Frontend: GitHub Pages, light/dark mode, dynamic categories, edit mode, brief cards
- localhost:3001: quick-add form
- PM2: auto-restart, boot persistence
- `_processorRunning` flag: prevents stacking multiple Claude processes

---

## Known Problems — Fix These First

### 1. Claude processor is too slow
**Root cause:** On every single message, Claude reads the full `todos.csv` (70+ rows), runs all proactive pattern checks, and potentially does web research. "Get milk" takes the same time as "find a podiatrist near Balham".

**What to do:**
- Write a slim `processor_context.json` in the bot before each invocation: only `new_items` (new=true rows) + recent completions + category counts
- Tell Claude to read `processor_context.json` first and only open `todos.csv` if it needs to edit a specific row by ID
- Proactive pattern checks should NOT run on every message — only run them when there are no new items, or at most once per hour (track `_lastProactiveCheck` timestamp in state)
- Research items (briefs) should be flagged separately and processed in a follow-up pass, not blocking the initial reply

### 2. Claude treats everything too literally
**Problem:** Instructions in messages become agenda items. "Can you find a paint pen" becomes a todo called "Find paint pen". "Remind me to send the amendments" becomes a task that Claude adds AND sends back a confirmation AND schedules a reminder AND writes it in the agenda. Each input creates too much noise.

**What to do:**
- Simple logging should be silent (🫡 react only) unless there's something worth saying
- Claude should not echo back what it just logged — Deep already knows
- Only speak up if: there's a question to ask, a brief is ready, a reminder was set (confirm time), or a proactive flag is genuinely warranted
- "Instructions" that are conversational context ("FYI I spoke to Maarten") should be logged but not generate a response at all

### 3. The conversation is too opaque
**Problem:** Deep sends a message, gets a hourglass, waits 2 minutes, nothing. He has no idea if it worked. When Claude does reply, it's often silent (🫡) which is fine, but for anything that took effort (research, scheduling, questions) he wants brief reassurance.

**What to do:**
- For silent items: 🫡 is enough — no change needed
- For scheduled reminders: confirm with time ("⏰ Reminder set for 5:20pm")
- For research briefs: confirm inline if short, link if long
- For questions: ask cleanly, one question max
- If Claude is taking >30s (rare, heavy research): optionally send "On it…" before the result
- Never send blank messages. The blank message bug was fixed but keep the guard.

### 4. Processor spawn is fragile on Windows
**Current approach:** `spawn(claudeExe, [...], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })` with a `_processorRunning` lock.

**What to do:**
- Keep `windowsHide: true` — prevents the cmd window popping up
- Keep the `_processorRunning` flag — prevents stacking
- Keep piping stdout/stderr to `processor.log` — essential for debugging
- The prompt is written to `processor_prompt.txt` and Claude is told to read it — this avoids shell quoting issues with long prompts
- On close, always call `processOutbox()` — in case the file watcher missed the write

### 5. Code is getting messy
`baileys-bot.js` is ~700 lines and growing. Consider splitting:
- `bot-core.js` — Baileys connection, message handling, reactions
- `processor.js` — Claude invocation, outbox watching, scheduled messages
- `local-server.js` — localhost:3001
- `audio.js` — TTS + STT pipeline
- `db.js` — CSV read/write, state, inbox/outbox helpers

Not essential right now — but don't add more to the monolith without refactoring first.

---

## Unfinished Features (from original 9-point list)

### Google Calendar integration — BLOCKED
The `gcal_*` MCP tools are only available in an interactive Claude Code session, not in spawned subprocesses. Claude correctly identified this and noted it in `profile.md`.

**Fix:** Install `googleapis` npm package. Implement OAuth2 once (token stored in `.env`). Bot handles `{type:"calendar", title, start, end, reminders}` outbox entries directly — Claude never touches the API.

When Claude processes a calendar-worthy item, it writes:
```json
{ "type": "calendar", "title": "Dentist", "start": "2026-04-04T09:00:00", "end": "2026-04-04T10:00:00", "todo_id": "63" }
```
Bot creates the event and confirms back.

### SQLite migration — PARKED
CSV works but has race conditions (concurrent reads/writes). Not urgent yet. When it becomes a problem, migrate `todos.csv` → SQLite with a write queue.

---

## Architecture Philosophy — Don't Lose This

Stream is not a task tracker. It's an external brain. The goal is:

1. **Zero friction input** — Deep sends a voice note or types naturally, nothing is rejected or clarified unnecessarily
2. **Silent processing by default** — most things should just happen without bothering him
3. **Speak up only when useful** — a question, a brief, a reminder confirmation, a proactive nudge
4. **Proactive, not reactive** — the system should notice things and act on them before he has to think about them
5. **Warm personality** — not a bot, not a calendar app. Feels like a person.

The WhatsApp interface is the primary channel. The frontend is a read-only dashboard plus edit fallback. localhost:3001 is for desk use.

---

## Running the Stack

```bash
pm2 status              # check it's running
pm2 restart stream      # restart after code changes
pm2 logs stream         # live logs
cat processor.log       # see what Claude actually did last run
```

**After code changes:** always `pm2 restart stream`.
**After CLAUDE.md changes:** no restart needed — Claude reads it fresh each run.
**If Claude is stuck:** check `processor.log`. Usually a usage limit or a bad prompt.

---

## What to Do in This Session

In rough priority order:

1. **Reliability overhaul** — fix the 5 known problems above, in order
2. **Reduce Claude chattiness** — silent by default, confirm only what matters
3. **Google Calendar** — implement via `googleapis` npm, not MCP
4. **Code cleanup** — split `baileys-bot.js` into modules if time allows
5. **Test end-to-end** — "get milk", "dentist Friday 10am", "find a podiatrist near Balham" — all three should work correctly and at appropriate speed

Do not add new features until the reliability issues are fixed.
