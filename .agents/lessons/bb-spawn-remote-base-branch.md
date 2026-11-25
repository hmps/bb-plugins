# Spawn on another machine: base on the remote branch

date: 2026-11-25
status: verified
scope: `bb thread spawn --new-environment worktree --base-branch` for workers and reviewers
keywords: bb thread spawn, base-branch, invalid reference, worktree, machine, pick_machine
evidence: thr_vdhqwtr6pb failed setup: `git worktree add --detach … bb/<branch>` → `fatal: invalid reference` on the picked machine; the same spawn with `origin/bb/<branch>` (thr_chbxz78h49) worked.
action: Push the branch first, then pass `--base-branch origin/<branch>`, because the picked machine's checkout has no local copy of your branch.
verify: Spawn a child with a local-only branch name on a machine other than your own; setup fails before the first turn.
retire-when: bb fetches and resolves a missing local base branch from origin.
