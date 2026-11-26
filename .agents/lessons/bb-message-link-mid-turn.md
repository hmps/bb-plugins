# A bb message link reveals only the last agent message of a turn

date: 2026-11-26
status: verified
scope: plugins that open a thread at a message (`navigate.toThread(id, { messageSeq })`, `experimental_threadHref`, `@thread:…#msg=<seq>`)
keywords: messageSeq, msg=, message link, Message not found, Worked for, timeline, reveal
evidence: inbox 0.1.7 live check on Ethereal-Titan. `#msg=1938` (a mid-turn agent message of thr_eqbn8sfi7k, idle) showed the toast "Message not found", while `bb thread log --message 1938` found it. `#msg=807` (the turn's last message) scrolled to the row with no toast. bb folds a turn's work and its earlier messages under "Worked for".
action: Link to the agent's last message in the turn (the newest non-sub-agent `item/completed` with `item.type === "agentMessage"` before the next `turn/started`). Its link sequence is the seq of that `item/completed` event. See `pickMessageSeq` in plugins/inbox/server.ts.
verify: open `/threads/<id>#msg=<seq>` in a headless browser for a mid-turn message; the page shows "Message not found".
retire-when: bb expands the folded work to reveal a mid-turn message.
