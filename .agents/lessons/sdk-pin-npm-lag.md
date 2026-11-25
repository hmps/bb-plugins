# SDK pin when the server runs an unpublished SDK

date: 2026-11-25
status: verified
scope: `plugins/*/package.json` (`@get-bb/plugin-sdk` pin, `engines.bbPluginSdk`)
keywords: plugin-sdk, ETARGET, bb plugin types, version pin, fork
evidence: plugins/inbox: the server ran SDK 0.6.190; `npm install @get-bb/plugin-sdk@0.6.190` → ETARGET (not on npm). Pinned 0.6.189; `bb plugin build` only warns about the mismatch, and the plugin loads.
action: Pin the newest SDK version that npm has and set `engines.bbPluginSdk` to `>=` that version (a range, so the newer server SDK still matches); do not run `bb plugin types .` when it would pin a version npm lacks.
verify: `npm view @get-bb/plugin-sdk versions --json` does not list the version that `bb plugin build` names in its warning.
retire-when: the server's SDK version is published on npm.
supersedes: refines the `.claude/LESSONS.md` note "After a bb update, run `bb plugin types .`" for this case.
