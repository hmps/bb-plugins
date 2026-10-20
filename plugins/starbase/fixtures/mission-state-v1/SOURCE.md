# Mission state v1 fixtures (pinned copy)

These files are a byte-for-byte copy of the Starbase core contract and its
fixtures. Do not edit them here. Copy them again from the core when the
contract changes.

- Source: Starbase core, commit `afd7cc872ab732cb2c103b5ee657065cb262800b`
  ("fix: correct mission attention and recovery gates"), the reviewed head
  of hmps/starbase#17, copied from the committed blobs. Every file's git
  blob id matched the commit.
- Copied: 2026-10-20T09:02:30Z.
- `mission-state-v1.md` is `docs/mission-state-v1.md` at that commit, sha256
  `f0e1e520e5dae5148cc20f85f27809811d0208da1802afa902a9d3d7273db33b`.
- `*.json` and `full-rows/*.json` are `tests/fixtures/mission-state-v1/`.
- Not copied, for reference: `scripts/mission_state.py` sha256
  `9fad5f4bde66dbbca8dcfd708bffd4384df41072ae8e07a6697049ad7bc29267`,
  `scripts/sitrep.sh` sha256
  `fc8dc7d7e5723db3a9bf87d09a10f203838af8deeadd6de2af21e19dfb258006`.
- All data is synthetic.

Each mission fixture holds the inputs and `expected`, the exact
`mission_state` the core projects. `subprocess-*.json` hold one SITREP run and
the board read result the core expects for it. `full-rows/*.json` hold one
whole SITREP run each: `exit_code`, `stdout` (the row array), `stderr`, and
the `command` the core ran.

These are source evidence for the board's tests. They do not prove what the
installed SITREP prints.

## sha256

```
9de953d0b600b028a3e46233d8c781e318ec6e8be149f2c90938af092d2c5619  active.json
7e5a5001638bd958d576e42e7208181bea093e409bb18761067b2ec53fa4d432  awaiting-survey-decision.json
366833e1552531043befb14f338f12493c28015fe871d0a1746c597b4be39422  cancelled.json
1b7cac207b8fcfc366a5a147bc32e5842c73507d41ff4dd518d72b3bff8521d5  cross-project-scope.json
3c8888437cf5b3f630426abb5f2decc585479c673e88012e945d0bf83a2e5e2d  current-failed-source.json
65f8873b651d5264dea9d602c4f378fa1bf2a4fccc80b7b8cb7daf431970b038  direct-root-discussion.json
86e2a5d12374c59f808c5c513913e84351bbc4985aa5a0a841117c78289b5527  full-fingerprint-receipt-race.json
9be33ed398d297e38b5d8675442aab60de71e3addb4bf3ebaf7fc61fa35690dd  issue-legacy.json
695793edf3c36564915eb82b9851707cdd4167b473f907402bda132f2705209d  legacy.json
5ddf25539d4c71fff18ca7322cf2e07969de5c4f5b9baa671cfb29640a7be38d  legacy-new-blocker-after-old-outcome.json
c0323a1c448c0ed67b90859d2feaf1a960f5cc5ecbe8bbd12a994da396e0aafd  malformed.json
9065bd94eab3f4d7aba5a79ee010d6e19908669cac8ac6c027baf3d957341a32  partially-deployed.json
79367b97a86caf618a3e397188cbbb0ed0a432fb12300201ea46d7bf45e7d32a  pending-new-blocker-after-old-report.json
334ca33a51a546f5c7b83d110f6606fb8fb7fc9fa2684c31902b9b9f8e1cb831  quiet-complete.json
51bf1d96c71864393d8258b9a931057acf505fc07a6a446ca51ac7b69a5cfe8a  ready-for-deploy.json
c232852e33f158bf489f7d30c3e5027aa77cc4f5a4892363069c823e4b075b32  source-ready.json
2390826d6bc5a76044da89f12e8f5911e270f993308c05960aa3b80d3b788586  stale-conflict.json
4ab031f3b5563a5393fe78459386beedd616a90c8c85a09f6afbf6b0fc86d8c9  subprocess-empty-failure.json
141871f5459298a63c6b726d0a98ce5cbdb2bda578d43c5a3128e9f27ea6ce59  subprocess-empty-success.json
b9039ca568955f0d19e8dec27a8531faa09ab578fe17628ed91caac12912b789  subprocess-malformed-failure.json
93d485056cf3c6727fac44ab1a838cf12440a248355f92ceeaa270ec7990bc5c  subprocess-other-failure.json
9fc4347689c258e730189134f8dea4e8e70797d12a7c8a5e137f4c607938425e  subprocess-partial-failure.json
7a0d4396b8300b9ba99791202cc83766df21cd39834717c865d9e75097c139e6  unsupported-contract-version.json
94059670e56aa69adf1c7388325eda4488738628148b27d7a4cfc047c06d519f  unsupported-schema-version.json
```

### full-rows

```
04d788285c3ff6004710ebd657899bbd13d7545551469f32a88f4345fa665375  active.json
e79e609bc4fc0d69b72f76f9a8d9b7fd8c7ea963f4728e5d05799849830835ca  changed-verified-target.json
0bc6607032df8d4d5e5f5e11ddaa833175e189080fc37ae9c395974ea4717baa  direct-root-discussion.json
e8ad163a6c910ddd021d7729dd0ad5096b4693243854406d76b08ce915303afe  missing-verified-target.json
68d85313c4bd0aea84fcd99eaeb24c8fcda144c4da871dce6e7be6720e812426  new-blocker.json
ee396fdb6669e05f8a98187ee7e82b31df374172de52140052985e2d146e7800  partial-source-failure.json
7a170641d7cf7be08c188f13a794dfa937564d4360fce2bd9f0e24dc59ece11e  quiet-complete.json
15df79e89c4d31b38343a72b4f839aa3c28686ebf40909e3f94757fe9e502c62  ready-for-deploy.json
712e51fa334af02f6ac53f9dcbbdedcf10e23aadff0e0a8287725768ba0d9aae  recent-closed.json
0de9df24e7f5448d3c3be073a9fc359c2d111209faf2c63eb68adef3fc57c4d4  stale-conflict.json
866e47526086b632fc146980ccbed6ee20b641008b8512af5dac96d2d8654c2e  survey-decision.json
```
