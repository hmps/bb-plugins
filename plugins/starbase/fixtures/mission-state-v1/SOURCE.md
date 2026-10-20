# Mission state v1 fixtures (pinned copy)

These files are a byte-for-byte copy of the Starbase core fixtures. Do not
edit them here. Copy them again from the core when the contract changes.

- Source: Starbase core, commit `78d68f2cbb4d0dd733558f9dc6ccd761ec978dd3`,
  `tests/fixtures/mission-state-v1/*.json`, copied from the committed blobs.
- Copied: 2026-10-20T07:43:34Z.
- Contract reference at that commit: `docs/mission-state-v1.md`, sha256
  `42a3ee773d51c2784a8bbc8bf606ef141239eb5dc1f5f372799b4001087107e0`.
- Python reference at that commit: `scripts/mission_state.py`, sha256
  `270ded538a440d0a0d6d801096922317df65dee472efbf7c1185456c3d932a56`.
- All data is synthetic.

Each mission fixture holds the inputs and `expected`, the exact
`mission_state` the core projects. `subprocess-*.json` hold one SITREP run and
the board read result the core expects for it.

## sha256

```
9de953d0b600b028a3e46233d8c781e318ec6e8be149f2c90938af092d2c5619  active.json
7e5a5001638bd958d576e42e7208181bea093e409bb18761067b2ec53fa4d432  awaiting-survey-decision.json
366833e1552531043befb14f338f12493c28015fe871d0a1746c597b4be39422  cancelled.json
1b7cac207b8fcfc366a5a147bc32e5842c73507d41ff4dd518d72b3bff8521d5  cross-project-scope.json
3c8888437cf5b3f630426abb5f2decc585479c673e88012e945d0bf83a2e5e2d  current-failed-source.json
bd7d971bf0973cbcffc4a9cf38de7508cb01fccbb73c4f89cab5294cb290e9e0  direct-root-discussion.json
04056d28bbe85dd4442fb02fe58fa990352f96323e9ad29ff5d62d79e0a75c38  full-fingerprint-receipt-race.json
9be33ed398d297e38b5d8675442aab60de71e3addb4bf3ebaf7fc61fa35690dd  issue-legacy.json
695793edf3c36564915eb82b9851707cdd4167b473f907402bda132f2705209d  legacy.json
4309ecbb61ed9765b7124e0e7642638cc316da325fafc66f987a56aaa2b6abdf  legacy-new-blocker-after-old-outcome.json
c0323a1c448c0ed67b90859d2feaf1a960f5cc5ecbe8bbd12a994da396e0aafd  malformed.json
9065bd94eab3f4d7aba5a79ee010d6e19908669cac8ac6c027baf3d957341a32  partially-deployed.json
dce11b00c89d1d15dac86bbf57f934a49e44f4bfb671e0e1a19d96e65a0ecde2  pending-new-blocker-after-old-report.json
334ca33a51a546f5c7b83d110f6606fb8fb7fc9fa2684c31902b9b9f8e1cb831  quiet-complete.json
51bf1d96c71864393d8258b9a931057acf505fc07a6a446ca51ac7b69a5cfe8a  ready-for-deploy.json
c232852e33f158bf489f7d30c3e5027aa77cc4f5a4892363069c823e4b075b32  source-ready.json
e825d2fd368dd6ace756ad15a978f205ea9fda927ffc6339a33af78b2c776663  stale-conflict.json
4ab031f3b5563a5393fe78459386beedd616a90c8c85a09f6afbf6b0fc86d8c9  subprocess-empty-failure.json
141871f5459298a63c6b726d0a98ce5cbdb2bda578d43c5a3128e9f27ea6ce59  subprocess-empty-success.json
b9039ca568955f0d19e8dec27a8531faa09ab578fe17628ed91caac12912b789  subprocess-malformed-failure.json
93d485056cf3c6727fac44ab1a838cf12440a248355f92ceeaa270ec7990bc5c  subprocess-other-failure.json
9fc4347689c258e730189134f8dea4e8e70797d12a7c8a5e137f4c607938425e  subprocess-partial-failure.json
7a0d4396b8300b9ba99791202cc83766df21cd39834717c865d9e75097c139e6  unsupported-contract-version.json
94059670e56aa69adf1c7388325eda4488738628148b27d7a4cfc047c06d519f  unsupported-schema-version.json
```

## full-rows (provisional)

`full-rows/*.json` hold one whole SITREP run each: `exit_code`, `stdout` (the
row array), `stderr`, and the `command` the core ran. They are not committed
in the core yet. They are copies of the uncommitted working files on top of
core commit `78d68f2cbb4d0dd733558f9dc6ccd761ec978dd3`, and must be copied
again from the stable committed core head before the final review.

- Copied: 2026-10-20T08:05:10Z.
- Working `docs/mission-state-v1.md`, sha256
  `9f8f44f5fde29d11c1067b13f76305774113bae74c4a88c08871525c01147363`.
- Working `scripts/sitrep.sh`, sha256
  `b4c85df7347d82869cfea5236eae0213fca5d3df8d020022057df0ae118e6323`.

```
04d788285c3ff6004710ebd657899bbd13d7545551469f32a88f4345fa665375  active.json
34894531fb73d2ec0c77dac5ea5fd7b54ecd856e1a732bee281c925e6ef657b0  new-blocker.json
1c8838f231d3c31243a2a06421ac201cc048a8373fbe5471c4493e880b65ac5a  partial-source-failure.json
11710a8aea1adf5947802920e2553c8e63ea54bc9532b5d9c6b504388699a267  quiet-complete.json
b4653104cb9fc5eb2fbdb2988106e00aca1a63d4b4d940a6037b163c5d02e5a8  ready-for-deploy.json
140ed2318dba6fd7aabb2ad50c1099fc6a577ea6be340d5fa561eda2f9817a6d  recent-closed.json
bdd770165b7ccc35739f6a2dcd38922f1807cdeb2b17dcc4fc829cd1b2c9b945  stale-conflict.json
b9ac1fc904bcbccc3829e25fed32898818f0f981e54c733bd97d7bd84ed9bc5d  survey-decision.json
```
