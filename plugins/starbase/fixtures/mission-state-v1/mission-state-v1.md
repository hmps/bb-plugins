# Mission state v1 reference slice

N1 supplies strict storage, checked writes, pure projection, and synthetic fixtures.
N2 integrates dispatch, outcome, SITREP, and archive.
A separate plugin Crew integrates the board consumer.
The existing scripts use the helper for canonical state and checked writes.
N1 performs no live queue migration or installation.

## Accepted amendments

- Authority uses explicit Commander attestation, not proof of human authorship.
- Dispositions include scope, quote, context, and checked message digests.
- Lifecycle adds `cancelled` with a scoped cancellation attestation.
- Closed rows add `bead_status: "closed"`, separate from existing BB `status`.
- Receipts match `attention:<id>@<revision>#<full-sha256>`.
- `pending_attention` always contains an array.
- Source failures remain separate from stored integrity.
- Requested Build target names remain immutable after adoption in v1.

## Public consumer contract

SITREP remains an array with all old row fields.
N2 adds `contract_version: 1`, `bead_status`, and `mission_state`.
`bead_status` copies the Beads source status string.
Missing records and orphans use `"unknown"`; other Beads status strings remain intact.
Consumers reject unsupported contract versions.
No source-error sentinel mission or extra public interface exists.

N2 also adds two string fields to the existing row `source` object:

- `source.output` is `"ok"` when `bb thread output` answered, and `"unreachable"` when a row with a thread got no output.
  A confirmed thread 404 uses `"absent"`; its consequent missing output is known absence.
  Rows without a thread or bead omit it.
- `source.canonical` is `"failed"` when the row has any source failure, and `"ok"` otherwise.
  Failures include the `bb-error`, `bb-unreachable`, and `forge-error` flags.
  They also include unavailable output, message, or owner evidence, and failed target checks.

A row with `source.canonical: "failed"` adds the flag `source-error` and drops `ok`.
An unrecorded current report adds `output-not-recorded` and drops `ok`.
Checked report fingerprints control this flag; missing legacy outcome notes do not override a matching checked report.
Confirmed thread absence retains `thread-gone` without `source-error` from that absence or its missing output.
The mission problem names cancellation or an authorized replacement and retains the record until archive safety is verified.
The existing row fields, flags, and progress fields keep their meaning.

The read-only command runs from the canonical Base main checkout:

```bash
bash scripts/sitrep.sh --project all --commander <root-thread> --recent-closed 50 --json
```

`--recent-closed` counts missions, not days.
Its range is 0 through 100, with default 0.
SITREP scopes closed missions before it applies the limit.
Reads never reconcile state or write receipts.

Every projected `mission_state` has exactly these fields:

| Field | Type |
| --- | --- |
| `integrity` | `valid`, `legacy`, `invalid`, or `conflict` |
| `problems` | string array |
| `revision` | positive integer or null |
| `lifecycle` | `active`, `source-ready`, `ready-for-deploy`, `awaiting-decision`, `blocked`, `complete`, `cancelled`, or `unverified` |
| `owner` | null or `{thread: string, role: "crew" \| "commander"}` |
| `owner_active` | boolean; current BB status equals `active` only |
| `next_action` | nonempty string or null |
| `evidence` | Evidence array |
| `targets` | Target array |
| `disposition` | null or Decision with action `act`, `defer`, or `reject` |
| `attention` | Attention array |
| `pending_attention` | Attention array without a currently verified receipt |
| `report` | null or Report |
| `archive_allowed` | boolean |

An idle owner never proves progress.
SITREP marks an active lifecycle with an idle owner as requiring checked continuation.
An open mission without an owner or next action reports that problem.
An ordinary next action on active work is not a verification problem.
A terminal mission with a next action cannot archive.
Malformed state exposes none of its unvalidated success fields.

Objects reject unknown fields.
Strings are nonempty unless the type states otherwise.
Evidence, targets, and attention each have at most 100 entries.
Digests use 64 lowercase hexadecimal characters.
Commits use 40 or 64 lowercase hexadecimal characters.
UTC timestamps use `YYYY-MM-DDTHH:MM:SSZ`.

```text
Evidence = {
  kind: "command" | "file" | "url" | "message",
  ref: string, checked_at: UTC timestamp, digest: SHA256,
  commit: commit | null, target: string | null
}
Target = {
  name: unique string, commit: commit | null,
  status: "pending" | "verified", evidence: Evidence[]
}
Report = {
  fingerprint: SHA256 of exact current UTF-8 output bytes,
  verdict: "complete" | "blocked" | "progress", reference: string
}
Decision = {
  action: "act" | "defer" | "reject", // internal cancellation uses "cancel"
  verification: "commander-attested", attested_by: Commander thread string,
  quoted_decision: string, scope: exact scope string,
  message_ref: answer reference, question_ref: question reference,
  answer_ref: answer reference, message_digest: SHA256,
  turn_id: answer turn string, question_digest: SHA256,
  question_turn_id: question turn string,
  recommendation: exact text present in the question,
  question_marker: event marker present in the question,
  go_mapping: boolean, no_intervening_question: true,
  implementation_mission: string | null,
  authorship: "context-only-not-human-proof"
}
Attention = {
  id: 24 lowercase hexadecimal characters, revision: positive integer,
  kind: "blocker" | "verification-failed" | "decision",
  source: string, fingerprint: SHA256, summary: string,
  evidence: Evidence[], receipt: Receipt | null
}
Receipt = {
  message_ref: "@thread:<id>#msg=<positive integer>",
  message_digest: SHA256, turn_id: string, verified_at: UTC timestamp,
  event_id: exact Attention.id, event_revision: exact Attention.revision,
  event_fingerprint: exact Attention.fingerprint
}
```

Survey completion requires a checked disposition.
An `act` disposition can name an implementation mission.
It grants no build, merge, deploy, or spending authority.
Cancellation requires an internal `cancellation` Decision with action `cancel`.
Cancellation cannot bypass safety, source, or attention checks.
A lost Crew thread does not prevent cancellation evidence from its retained Commander root.
Use `state.sh apply` with the existing `update` operation, `lifecycle: "cancelled"`, null `next_action`, and a scoped `cancellation` Decision.
The candidate preserves immutable linkage and existing history, evidence, and attention.
Assign the retained Commander as owner when Crew no longer exist.
The current Commander identity, conversation context, snapshot, and revision checks still apply.
`land.sh` refuses archive when the Crew thread is missing; absence cannot prove PR or worktree safety.
Keep the record open and let the Commander restore verifiable safety evidence.
An unavailable Build worktree also adds a problem with that recovery action.
Verified targets and a merged PR cannot prove worktree cleanliness.

## Current target evidence

Build completion requires every named target and exact target-commit evidence.
Missing targets keep legacy missions unverified.
Source-ready and ready-for-deploy never establish completion.
Partial targets remain visible.
PR merge text and Crew reports never verify installation or deployment.

The Commander selects evidence that proves acceptance at each requested target.
The helper checks its shape and exact target/commit association.
Stored JSON alone cannot establish current verification.
Completion and projection require fresh `observation.target_checks` from a source collector:

```text
{ name: target name, commit: exact commit, kind: Evidence.kind,
  ref: Evidence.ref, digest: current observed SHA256, available: true }
```

The collector inspects actual target evidence during the current read.
It never copies checks from stored state or Crew text.
Changed, missing, or unsupported evidence blocks completion and archive.
A failed current check for a verified target creates verification-failed attention.
Its fingerprint includes the expected target proof and current digests or unavailable result.
SITREP marks that source as failed and returns an incomplete read.
Pending targets remain ordinary work and create no verification failure.
A Base change can name `base-main` as its accepted installation target.
Its evidence is a fresh install and acceptance report file.
An independently authorized verification of the actual Base main checkout and exact commit writes that file.
No v1 collector checks the main checkout or commit ancestry.

The CLI supplies one collector: `gather_target_checks` for absolute local file references.
It reads the file again and compares its SHA256 digest.
The helper checks only the recorded target name, commit, and digest association.
A matching digest proves that the file is unchanged.
It does not prove runtime behavior, installation, or commit ancestry.
The Commander remains accountable for evidence meaning and the exact target and commit.
Command, URL, and message evidence have no current target collector in v1.
Such evidence keeps the target check unavailable.
The CLI never executes arbitrary stored commands.
No generic deployment verifier exists.

## Pure API for N2

Import `scripts/mission_state.py` without IO.

```python
project(issue, project_slug, observation=None, bundles=None) -> mission_state
parse_note_records(notes) -> {thread, env, outcome, decision}
derive_attention(bead, stored_events, event_inputs) -> Attention[]
prepare(issue, project_slug, operation, bundles=None) -> full wanted issue
snapshot_token(issue) -> SHA256
consume_result(exit_code, stdout, stderr="", prior=None) -> board read result
```

`issue` has `id`, `notes`, `metadata`, `status`, `labels`, `updated_at`, `closed_at`, and `close_reason`.
Pure reads accept metadata as an object or JSON text.
Store snapshots use the full SQL text rendering of JSON metadata.

`observation` supplies current `owner_status`, `worktree`, `pr`, `failures`, `events`, and optional report fields.
Worktree values are `clean`, `dirty`, `n/a`, or unknown.
PR values are `none`, `merged`, `closed`, `open`, or unknown.
Failures contain source error strings, separate from stored integrity.
`report_output` contains exact output; `report_verdict` optionally supplies its parsed verdict.
`target_checks` supplies independent current checks as above.
Missing safety evidence never permits archive.
A finished Survey can have worktree `n/a`; a Build requires `clean`.

Event inputs have `kind`, `source`, `fingerprint`, `summary`, and `evidence`.
Awaiting-decision and blocked lifecycles automatically derive stable events.
Their fingerprint includes the current report and next action.
One newly derived lifecycle event covers a report and its matching lifecycle cause.
A fresh report replaces the current derived cause rather than adding a second report event.
Previously stored report events and receipts remain intact; no automatic migration removes them.
An explicit non-none `outcome.sh --decision` creates a separate `decision:explicit` event.
Its fingerprint binds the exact decision text and current report fingerprint.
An unchanged replay keeps its identity, revision, and receipt.
A later `none` creates no new explicit event and does not remove unsurfaced events.
Outcome-style updates persist these events through `prepare` under CAS.
Recording a report fingerprint never erases its decision event.
New blocked reports derive blocker attention before outcome records them.
Returned Surveys derive decision attention.
Routine progress and Build source completion create no generic decision event.
An unrecorded fingerprint remains an internal reconciliation problem.
Quiet verified completion requires no receipt for that internal problem.
Quiet verified completion creates no forced event.
Changed report bytes prevent archive until checked reconciliation records them.

`bundles` maps references to current BB evidence:
`{thread, message, events, events_complete: true}`.
`gather_bundles(state, extra_refs)` reads those bundles through BB.
`gather_target_checks(state)` reads supported local file evidence.
These adapters perform IO; projection never does.
N2 converts adapter failures into source failures.
Missing or changed bundles invalidate receipts and dispositions for archive.

The note parser accepts complete legacy dispatch records only.
A record starts with `thread=thr_... env=env_...`.
Optional mode, authorities, and grants follow existing dispatch order.
Contradictory full dispatch records fail.
Tokens inside prose, outcome, decisions, or quotes never change linkage.
Whole `outcome=` and `decision=` lines use latest-wins history.
No note token establishes landed state.

The board adapter returns `{rows, incomplete, stale, error}`.
Exit 0 plus an array supplies authoritative current rows.
Exit 1 plus an array supplies partial current rows and sets `incomplete`.
Exit 1 with empty stdout retains prior rows as stale, with an error.
Other failures and malformed stdout do the same.
Without prior rows, `rows` is null and the source is unavailable.
Only a successful read can establish an authoritative empty queue.

## Checked CLI and storage

```bash
bash scripts/state.sh read --project example --bead <bead>
bash scripts/state.sh apply --project example --bead <bead> \
  --expected <snapshot-token> --revision <prior-revision> --operation /path/op.json
bash scripts/state.sh project --project example --issue /path/issue.json \
  --observation /path/current-evidence.json --bundles /path/current-messages.json
bash scripts/state.sh notes --issue /path/issue.json
```

Read and apply refuse linked Base worktrees.
Tests copy scripts into a scratch Base outside git.
Every bd subprocess exports explicit `BEADS_DIR`.
Export the approved scratch value before Git commands too.
Existing repository hooks invoke bd during commits.
In a Base worktree, run each Git mutation as `git -c core.hooksPath=/dev/null ...`.
Run the source checks explicitly instead.
Do not change hooks, Git config, or file permissions persistently.
Apply uses prior revision 0 for explicit legacy adoption.
Read returns `{snapshot, revision, issue, mission_state, capability}`.
Unknown arguments fail before mutation.
JSON errors use stderr; conflicts exit 3; invalid or unsupported operations exit 2.

Operation JSON uses `op`: `adopt`, `update`, `observe`, `receipt`, or `close`.
Permitted extra fields are `state`, `append_notes`, `events`, `receipt`, `observation`, and `close_reason`.
Adopt requires initial schema version 1 state and refuses existing state.
It starts with empty attention; checked event inputs can create initial events.
Update accepts a complete candidate with unchanged managed fields.
Managed fields are `schema_version`, `revision`, `history`, `guard`, and `attention`.
Linkage and requested target names remain immutable after adoption.
Evidence arrays accept appends only.
Events and receipts use dedicated checked paths.
No operation removes or replaces notes.
Close requires a reason and current safety evidence.

A receipt request has exactly `id`, `revision`, `fingerprint`, and `message_ref`.
The CLI independently collects target checks and message bundles.
Caller JSON cannot substitute synthetic target checks for CLI file reads.

Storage uses `issue.metadata.starbase_mission`, schema version 1.
Its exact stored keys are:
`schema_version`, `revision`, `lifecycle`, `linkage`, `owner`, `next_action`, `evidence`, `targets`, `report`, `disposition`, `cancellation`, `attention`, `history`, and `guard`.
Projection-only integrity, problem, owner activity, pending attention, and archive fields are not stored.
Linkage has exactly `project`, `project_id`, `mission_type`, `thread`, `env`, and `commander`.
`project_id` identifies the BB project that owns the Commander root conversation.
It can differ from the Crew target BB project.
N2 reads this identity from the verified Commander root.
`project` and the project label hold the target slug.
`env` may be empty for old records without an environment.
History keeps the latest 20 `{revision, digest, op, report}` entries in ascending revision order.
Prior report objects and state digests remain available there.
Evidence remains append-only; reaching the bound fails rather than discarding entries.
Unrelated metadata and all original notes survive writes.

Each write increments revision and appends a fixed audit line:
`mission-audit=rN op=<enum> id=<hex>`.
Audit records contain no user text or linkage/control tokens.
The guard covers notes, metadata except its guard, labels, status, and closure fields.
Out-of-band changes produce conflict, without automatic repair.

The store probes server Dolt SQL and required keys, types, nullability, and label columns.
Embedded SQL and unsupported schemas fail before mutation.
The conditional UPDATE guards full notes, serialized JSON metadata, status, timestamps, closure fields, and labels.
Data enters SQL through UTF-8 hex literals, never shell interpolation.
Every statement changes both notes and metadata.
Read-back checks all guard fields.
A mismatch remains a conflict even after SQL commits.
Recognized serialization failures retry at most three times with the same expected snapshot.
A changed snapshot rejects the retry.
No host-local lock provides concurrency safety.
Label predicates and read-back do not prove a separate-table label lock.

Closure sets `status`, `closed_at`, `close_reason`, and `updated_at`.
Raw SQL bypasses Beads events and content-hash hooks.
A checked close writes no Beads `closed` event.
Archive saves the report before closure and closes before the BB archive call.
Failed BB archive leaves `housekeeping=pending-archive` in the closed record.
Recent closed rows expose this incomplete housekeeping.
The helper does not claim equivalent Beads storage-layer side effects.
Its timestamp never moves behind the observed issue timestamp.
Operators must check their actual store before opt-in.
No Dolt push or pull runs.

## Authority and receipts

The authorized Commander explicitly records the Governor decision through the checked command.
The record includes conversation references, quote, exact scope, and attestation.
Reference checks prove existence and context, not human authorship.
Spawn/tell, Crew output, and arbitrary user-role events never automatically grant authority.
The CLI checks the current Commander thread and project for new authority or receipt writes.
V1 pins `linkage.commander` as the authority and evidence root and has no rebind operation.
Keep that root visible after disposition and source closure, because stored evidence is revalidated.
`land.sh` refuses archive when the mission thread equals that Commander root.
The mission record stays open; no root-close or root-archive route exists in v1.
Other root discussions are not blocked solely because `parentThreadId` is null.
Manual BB archive is outside script control and can invalidate stored evidence.

Question and answer belong to the same visible project root Commander thread.
The answer follows the question.
Known agent/system initiators, senders, system kinds, and wrapper text fail context checks.
Tell alone and an unlabeled message alone do not prove agent origin.
The Commander remains accountable for ambiguous user-role provenance.
A `go` mapping requires explicit attestation and an unambiguous `go` reply.
The Commander attests recommendation scope and absence of an intervening decision question.
A global `go` still needs each chosen disposition recorded explicitly.
Merge and deploy grants remain separate.

Receipts require an actual assistant conversation message in the authorized visible root thread and project.
The turn must complete successfully after the message.
No later same-turn assistant or tool action can follow it.
Internal messages, commentary, stale markers, changed digests, and agent-only threads fail.
Stored message digests and turn identities are revalidated.
Receipt raw event collection stops after 100 pages and fails closed if evidence remains incomplete.
Disposition checks read the referenced messages and current root context only.
They do not require a complete raw history tail.
A stored receipt remains stored when history exceeds the bound.
SITREP then shows pending attention, a current source failure, and `archive_allowed: false`.
The receipt does not disappear or establish healthy completion.
The old real seq159 read reaches this bound; it records no receipt.
The supplied bounded samples still permit a schema and provenance extraction check.
A receipt proves surfacing, never resolution.
It can be recorded on the next wake, without Governor acknowledgement.

Stable attention ID hashes bead, kind, and source.
A changed fingerprint advances that event's stored revision by one.
Identical fingerprints reuse their revision and receipt.
Two unpersisted reports can share a revision; the full fingerprint is mandatory.
A newer event stays pending after an older final-message receipt.
Projection derives events without writes; apply persists events under CAS.

## Verification and fixture paths

```bash
bash tests/state-test.sh
bash tests/state-sql-test.sh --approved-scratch
bash -n scripts/state.sh tests/state-test.sh tests/state-sql-test.sh
shellcheck scripts/state.sh tests/state-test.sh tests/state-sql-test.sh
git diff --check
```

The SQL runner requires explicit opt-in and fixes the approved scratch endpoint and database.
The trial observes bd 1.2.2 and Dolt 2.5.0.
It makes no live version equality claim.
It proves update/read-back, stale rejection, overlapping helpers, raw note/metadata overlap, target checks, and closure.
Results go to `/tmp/starbase-state-n1-sql-proof.json`.
Helper SQL leaves `content_hash` and event counts unchanged in this trial.
Consumers must read current SITREP data; Beads events alone cannot establish freshness.
Raw bd metadata/note updates advance events and timestamps; their content hashes also remain unchanged here.

Synthetic fixtures live in `tests/fixtures/mission-state-v1/`.
They cover the lifecycle states, partial targets, receipt races, malformed state, future versions, and source failures.
They include direct root discussion and cross-project scope.
Subprocess fixtures cover whole failure, partial failure, malformed output, and empty success.
Their expected objects test mission_state projections only.
Full rows live in `tests/fixtures/mission-state-v1/full-rows/`.
The copied SITREP command produces these fixtures with synthetic BB and SQL transports.
Run `bash tests/lifecycle-test.sh --write-fixtures <directory>` to reproduce them.
The SQL fixture executes checked predicates and read-back through SQLite translation.
It does not establish Dolt concurrency behavior; the separate SQL trial covers that boundary.

The real conversation sample at `@thread:thr_9mhukyfy2t#msg=66` exposes origin fields at the message top level.
Its `turnRequest` holds message status, not origin.
Its user role and unlabeled kind permit only the documented context check.
The saved samples distinguish final seq159 from commentary seq24.
No live receipt is created from those samples.

## N1 retrospective

The reference slice passes focused state, SQL overlap, and synthetic CLI receipt checks.
The SQL JSON text guard needs the server CAST rendering, not its compact JSON result encoding.
The adapter now reads that rendering before it writes.
Serialization errors arrive on JSON stdout in this bd version.
The error adapter checks that channel without echoing SQL data.
Real BB origin fields occur at the conversation row top level.
Origin regressions now cover ambiguous attested replies and known agent replies separately.
The first Git commit lacks the scratch export in its shell call.
Existing hooks print Base permission warnings; live queue side effects remain unconfirmed by this worker.
The parent owns that verification.
The safeguard above covers subsequent Git commands as well as explicit bd calls.
No separate lesson record is needed; code, tests, and this contract hold the safeguards.
