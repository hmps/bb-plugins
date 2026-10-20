# Mission state v1 fixtures (pinned copy)

These files are a byte-for-byte copy of the Starbase core contract and its
fixtures. Do not edit them here. Copy them again from the core when the
contract changes.

- Source: Starbase core, commit `c31e4cd6ceea5e62954e3064fd16c6d9f247e9b3`
  ("fix(state): report failed target verification"), copied from the
  committed blobs. Every file's git blob id matched the commit.
- Copied: 2026-10-20T08:12:59Z.
- `mission-state-v1.md` is `docs/mission-state-v1.md` at that commit, sha256
  `a35fcf91d17bd56eb6f5b319f2dda3be1f72e6903c4b482ba7ae95c0dfb59567`.
- `*.json` and `full-rows/*.json` are `tests/fixtures/mission-state-v1/`.
- Not copied, for reference: `scripts/mission_state.py` sha256
  `50ab6608db29cc11f95453df64f39ac3bd37ed63741f368fafd4de552838db84`,
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
bd7d971bf0973cbcffc4a9cf38de7508cb01fccbb73c4f89cab5294cb290e9e0  direct-root-discussion.json
86e2a5d12374c59f808c5c513913e84351bbc4985aa5a0a841117c78289b5527  full-fingerprint-receipt-race.json
9be33ed398d297e38b5d8675442aab60de71e3addb4bf3ebaf7fc61fa35690dd  issue-legacy.json
695793edf3c36564915eb82b9851707cdd4167b473f907402bda132f2705209d  legacy.json
70afcf370388dbba1cc7a28da9b80aa057cc0e0bbe1afca755fb759b9f8edd21  legacy-new-blocker-after-old-outcome.json
c0323a1c448c0ed67b90859d2feaf1a960f5cc5ecbe8bbd12a994da396e0aafd  malformed.json
9065bd94eab3f4d7aba5a79ee010d6e19908669cac8ac6c027baf3d957341a32  partially-deployed.json
597068ab77fc154be423eaa75d095a2eabcdfaea2a4304657720ddbdc33399a6  pending-new-blocker-after-old-report.json
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
f2427604681fabfe09bd91732a346ed12bd9707e1f2e37536336440c3c11db6e  changed-verified-target.json
691f95fd09aa5b6add736cf5fa72306602c5de56db31aee3c937c358520597ac  missing-verified-target.json
34894531fb73d2ec0c77dac5ea5fd7b54ecd856e1a732bee281c925e6ef657b0  new-blocker.json
1c8838f231d3c31243a2a06421ac201cc048a8373fbe5471c4493e880b65ac5a  partial-source-failure.json
f964d7a7d0fa3b2d948df2fd8d4f72ce51ef8e1c48f7c859f8750d8f90a2c45c  quiet-complete.json
b4653104cb9fc5eb2fbdb2988106e00aca1a63d4b4d940a6037b163c5d02e5a8  ready-for-deploy.json
add2177a4cfcc68deebaefc2b0517f746301d65a4829d49a6fe5c8c7f2d9b8e2  recent-closed.json
8b624eecfe3e947de7da13cb96aacc6465f217b8a915bdfbaebb7d83428d63e3  stale-conflict.json
b9ac1fc904bcbccc3829e25fed32898818f0f981e54c733bd97d7bd84ed9bc5d  survey-decision.json
```
