# bb-plugin-inbox

One place for everything that waits on you. The inbox collects the items
that wait on the user from every bb thread, shows them in the left rail with
a badge, and sends each answer back to the thread that asked. It works in
every thread and has no dependency on Starbase or Beads.

## Sources

| Source     | Where it comes from                                                                 |
| ---------- | ----------------------------------------------------------------------------------- |
| `card`     | A pending decision card of the builtin decisions plugin (`request_decisions`).       |
| `tool`     | An agent called the `inbox_ask` tool, or someone ran `bb inbox ask`.                 |
| `detected` | The detection pass found an ask in a top-level thread's final reply (optional key). |

An item is created open and unread. Opening it marks it read; it never
closes it. A repeated ask (the same open question in the same thread) bumps
`askCount` and `lastAskedAt` and refreshes the context, options, and
recommendation. It never adds a duplicate and never pings.

## UI

A navigation entry in the left rail with a badge (open, unread count). The
list shows open items newest ask first, with snoozed items apart. Each item
shows its question, context, options, recommendation, and source thread.
A detected item also shows "From the thread": a collapsed quote of the
passage of the reply that it came from.
The page refetches on the realtime signal `items-changed`
(`{ openCount, unreadCount }`), which every write publishes.

## Actions

| Action         | Effect                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Answer         | Card: answers the card in its thread. Tool/detected: sends `[Inbox] Answer to inb_… (ref: X): …`. |
| Done           | "do" items: sends `[Inbox] Done: <question>` (and a note).                                       |
| Snooze         | Hides the item until a time; it then comes back open and unread.                                 |
| Dismiss        | Card: cancels the card. Tool: sends `[Inbox] The user dismissed inb_…`. Detected: no message.    |
| Hand to parent | Sends the item to the source thread's parent thread and closes it.                               |
| Close          | Closes without a message (`bb inbox close`, `items_close`).                                      |

An item also closes when its thread is archived or deleted, when its card
settles outside the inbox, or when detection sees a later reply that
resolves it (tool and detected items only).

## Pings

One push notification per new item, any source: title `Inbox · Decide` (or
Approve, To do), body the question, linked to the source thread. A repeat
never pings. One daily nudge while items are open: `Inbox: N open`, `oldest
3d`, at `nudgeHour`, at most once per calendar day.

The Plugin SDK has no push API. Pings go through the builtin
push-notifications plugin's RPC:
`bb.sdk.plugins.callRpc({ pluginId: "push-notifications", method:
"notifications.send", input: { title, body, threadId } })`. A failed ping
logs a warning and changes nothing. Set `pings` to false to turn them off.

## Detection

Detection is off until you set an OpenAI API key. With no key, nothing calls
a model, and `bb inbox status` reports `{ enabled: false, reason: "no
OpenAI API key set" }`.

With a key, each turn end (`thread.idle`) of a top-level thread with a
non-empty final reply runs the detector, one run at a time per thread. A
child thread is skipped: its final reply goes to an agent, not to the user.

- Pass 1 scores the reply: the probability that it asks the user for
  something, whether that ask is new, a repeat, or already covered, and per
  open item of the thread the probability that the reply resolves it.
- Pass 2 runs only when the ask score is at or above `askThreshold`. It
  extracts each ask (kind, question, options, recommendation, context,
  excerpt). The prompt asks for text that stands alone: it resolves
  references such as "option 1" to the real option. The excerpt is the
  source passage, word for word (at most 1500 chars). When the reply does
  not hold the quoted text, the item keeps the end of the reply instead.
- A new ask becomes a `detected` item at once. A repeat bumps its item. An
  open tool or detected item whose resolve score is at or above
  `resolveThreshold` closes as `resolved`.

Inbox also checks user messages as they arrive. It listens for
`experimental_thread.events` and reads user-initiated `client/turn/requested`
events from the SDK. It skips Inbox replies and messages from other agents.
For each open tool or detected item, the Decisions API scores whether the
message answers the item's question. The request includes the options and
recommendation. A score at or above `answerThreshold` closes the item as
`answered-in-thread`, with a row in `bb inbox detections`.

Each turn-end run writes one row to `detection_log` (outcome, scores, whether pass 2
ran, created, repeated and resolved ids, duration, error). The plugin keeps
the last 2000 rows. Use `bb inbox detections` to tune the thresholds. A
detector error logs a warning and changes nothing.

## Settings

| Key                | Default      | Meaning                                                  |
| ------------------ | ------------ | -------------------------------------------------------- |
| `openaiApiKey`     | (none)       | Secret. Turns detection on.                              |
| `detectionModel`   | `gpt-6-luna` | Model for ask detection and answer checks.               |
| `askThreshold`     | `0.6`        | Pass 2 runs at or above this ask score.                  |
| `resolveThreshold` | `0.8`        | An item resolves at or above this score.                 |
| `answerThreshold`  | `0.8`        | An item closes as answered in thread at or above this score. |
| `pings`            | `true`       | One push per new item, and the daily nudge.              |
| `nudgeHour`        | `9`          | Hour of the daily nudge (0-23, server local time).       |

```
bb plugin config inbox set pings false
```

## CLI

```
bb inbox list [--json] [--thread <id>] [--project <id>] [--all] [--limit <n>]
bb inbox ask --kind <decide|approve|do> --question <q> [--context <md>]
             [--option <o>]... [--recommendation <r>] [--ref <ref>] [--thread <id>] [--json]
bb inbox close <id> [--reason <text>] [--json]
bb inbox status [--json]
bb inbox detections [--limit <n>] [--json]
```

`bb inbox list --json` prints an array that matches `cliItemSchema` in
`contract.ts` exactly. Starbase reads it; fields are only added, never
renamed or removed. See `skills/inbox/SKILL.md` for examples.

## Card sync

The card mirror rests on facts proven live on 2026-11-25:

- A decision card from the builtin decisions plugin is a pending plugin
  interaction: `{ id: "pint_…", threadId, status: "pending", expiresAt
  (7 days), origin: { kind: "plugin", pluginId: "bb--decisions",
  rendererId: "decisions" }, payload: { kind: "plugin", title, data: {
  headline, decisions: [{ question, context, options: [{ label, does }],
  suggested, links }] } }, resolution: null }`.
- The decisions frontend submits `{ answers: [ { option: <index> } | {
  text: "<own answer>" } ] }`, one per decision, in order.
- `bb thread interactions respond pint_… thr_… --value
  '{"answers":[{"option":1}]}'` from outside the thread settled the card:
  status `resolved`, resolution `{ kind: "plugin_submitted", description:
  { title: "Decided: <headline>", detail: "- Decision 1 — <question>: Pick
  B" } }`, and the thread's agent received the answer and replied.

So the plugin:

- mirrors each card on `interaction.pending` (once per interaction id),
- answers it with `bb.sdk.threads.interactions.respond({ threadId,
  interactionId, value: { answers } })`, and dismisses it with
  `interactions.cancel`,
- closes the item with `card-settled` when the card settles elsewhere
  (answered or written to in the thread, dismissed, expired). It checks with
  `interactions.get` on thread activity for threads with open cards, on
  `thread.idle`, every 5 minutes, and at startup. The item's answer is the
  resolution detail when there is one.
- At startup it also scans non-archived threads updated in the last 7 days
  (at most 200) for cards that went pending while it was not loaded.

## Develop

```
npm install --include=dev --legacy-peer-deps
npm test
npm run typecheck
bb plugin build .
```

Files: `contract.ts` (shared shapes), `server.ts` (wiring), `store.ts`
(SQLite store), `cards.ts` (card parsing and answers), `detection.ts`
(the two-pass detector), `app.tsx` (UI).
