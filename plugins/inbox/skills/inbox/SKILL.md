---
name: inbox
description: The user's inbox in bb — the one place for everything that waits on the user. Use it to put an approval, a task for the user, or a decision that does not fit a card in front of the user (`inbox_ask` or `bb inbox ask`), and to list, check, or close inbox items (`bb inbox list|close|status|detections`).
---

# Inbox

The inbox plugin keeps one list of the items that wait on the user, from
every bb thread. The user works from the inbox (left rail, with a badge), not
from each thread. Items come from three sources:

- **card** — every pending decision card (`request_decisions`) is mirrored as
  one item. Answering the item answers the card in its thread; answering the
  card in the thread closes the item.
- **tool** — an agent called `inbox_ask`, or someone ran `bb inbox ask`.
- **detected** — with an OpenAI API key set, a model checks the final reply of
  each top-level thread and adds the asks it finds. Each detected item keeps
  the passage of the reply that it came from, shown as "From the thread".
  Without a key, detection is off.

Each new item sends one push notification. A repeated ask never does.

## Asking the user: `inbox_ask`

Every ask to the user goes through a decision card or `inbox_ask`.

- Use a decision card for choices between options.
- Use `inbox_ask` for approvals (`kind: "approve"`), things the user must do
  (`kind: "do"`), and decisions that do not fit a card (`kind: "decide"`).
- The user reads the item in the inbox, away from your thread. Write the
  `question` and `context` for someone who has not read the thread. Resolve
  every reference ("option 1", "the fix above", "it") to what it means.
- Put the context in `context` (Markdown): what is asked, what each option
  does, and what happens on yes.
- Give each option as its full text, such as "Rebuild the index with Redis",
  not "Option 1" or "the second one". Give a `recommendation` when you have
  one. `ref` is your own reference, such as an issue id.
- The call does not block. It returns the item id at once. Do not wait.
- The user can reply directly in the thread. With a key set, Inbox checks the reply and closes the item if it answers the question.
- Actions in Inbox send a message to your thread:
  - `[Inbox] Answer to inb_… (ref: X): <question>` and the answer,
  - `[Inbox] Done: <question>` (and a note) for a "do" item,
  - `[Inbox] The user dismissed inb_…: <question>. Continue with your best judgement.`
- Asking the same question again in the same thread (same text, case and
  trailing punctuation ignored) bumps the open item (`askCount`); it does not
  add a second item.

Parameters: `kind` (decide | approve | do), `question` (one line, ≤300
chars), `context` (≤20000), `options` (≤8, each ≤200), `recommendation`
(≤500), `ref` (≤120).

## CLI

All commands take `--json`. Errors exit non-zero; with `--json` the error is a
`{"ok": false, "error": {code, message, hint}}` envelope.

```bash
bb inbox list                       # open items (not snoozed), newest ask first
bb inbox list --all                 # open and snoozed
bb inbox list --thread thr_abc --json
bb inbox list --project proj_abc --limit 50

bb inbox ask --kind approve --question "Deploy v2 to prod?" \
  --recommendation "Yes, after the smoke test" --ref ENG-42
bb inbox ask --kind decide --question "Which queue?" --option SQS --option Redis \
  --context "$(cat notes.md)" --thread thr_abc

bb inbox close inb_AbCdEfGhIj --reason "done in another thread"
bb inbox status                     # detection on/off (+ reason, model) and counts
bb inbox detections --limit 50      # newest detection log rows, for threshold tuning
```

- `list`: default limit 200 (max 1000); the text output says when more exist.
- `ask`: the thread defaults to the current thread; outside a thread, pass
  `--thread <id>`. `--json` prints `{ "repeated": bool, "item": <list item> }`.
- `close`: closes without a message to the thread. `--json` prints
  `{ "id", "status": "closed", "closeReason": "closed" }`.

## JSON contract (`bb inbox list --json`)

An array of objects with exactly these keys. Fields are only ever added,
never renamed or removed.

```json
[
  {
    "id": "inb_AbCdEfGhIj",
    "threadId": "thr_abc",
    "projectId": "proj_abc",
    "kind": "approve",
    "question": "Deploy v2 to prod?",
    "recommendation": "Yes, after the smoke test",
    "source": "tool",
    "status": "open",
    "ref": "ENG-42",
    "createdAt": "2026-11-25T08:00:00.000Z",
    "lastAskedAt": "2026-11-25T09:30:00.000Z",
    "askCount": 2
  }
]
```

`kind`: decide | approve | do. `source`: card | tool | detected. `status`:
open | snoozed. Dates are ISO 8601.

## Settings

`bb plugin config inbox set <key> <value>`:

- `openaiApiKey` (secret) — turns detection on. No key: detection is off and
  no model is called.
- `detectionModel` (default `gpt-6-luna`).
- `askThreshold` (0.6) — pass 2 runs only at or above this ask score.
- `resolveThreshold` (0.8) — an open item closes as resolved at or above this.
- `answerThreshold` (0.8) — a direct user reply closes an open tool or detected
  item at or above this score. See `answered-in-thread` in `bb inbox detections`.
- `pings` (true) — one push per new item and a daily nudge.
- `nudgeHour` (9) — hour of the daily nudge, server local time.

## Constraints

- Turn-end detection checks non-empty final replies in top-level threads.
- Answer checks run when the user sends a message in a thread with open items.
  Inbox replies and messages from other agents are skipped.
- Card items close only through their card (answer, dismiss, or the card
  settling in its thread), never by detection.
- Never put secrets in an item: the question, context, and answer are stored
  in the plugin database and shown in the UI.
