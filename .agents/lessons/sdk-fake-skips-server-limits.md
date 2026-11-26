# The SDK test fake does not enforce bb server limits

date: 2026-11-26
status: verified
scope: server tests that stub `bb.sdk.*` with `createFakePluginHost` or `harness.sdk.stub`
keywords: createFakePluginHost, stub, events.list, limit, HTTP 400, test fake
evidence: inbox 0.1.5 asked `threads.events.list` for `limit: "200"`. All tests passed; the live server logged `HTTP 400: Thread event limit cannot exceed 100`, and no item got its message.
action: When a stub stands in for a bb API, make it refuse what the server refuses (for `threads.events.list`, a limit over 100), and page with `beforeSeq` for more rows.
verify: plugins/inbox/server.test.ts "points a tool ask at its turn's message…" throws on a limit over 100; it fails with `MESSAGE_EVENT_PAGE = 200`.
retire-when: the SDK fake validates request limits itself.
