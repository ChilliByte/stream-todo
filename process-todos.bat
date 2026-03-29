@echo off
cd /d "C:\Users\dsohelia\Documents\Claude\Projects\Stream"

claude --print "You are Deep's personal secretary. Work through the following tasks in order:

1. Read todos.csv - find all rows where new=true
2. Read inbox.json - find any replies or UPDATES commands
3. Read CLAUDE.md and profile.md for context and rules
4. For each new=true item in todos.csv: set category, priority, reminder_at, and new=false using the rules in CLAUDE.md
5. For each entry in inbox.json: apply the changes to todos.csv, then write [] back to inbox.json to clear it
6. Run proactive checks per CLAUDE.md (end of day nudges, pattern detection etc)
7. Write any outbound messages to outbox.json as a JSON array of objects with 'to' and 'text' fields. Use the MY_JID format: MY_PHONE@s.whatsapp.net where MY_PHONE comes from .env
8. If profile.md should be updated with new learned preferences, update it
9. Run: git add todos.csv profile.md && git commit -m 'processor update' && git push

Do not ask questions. Just do it."
