# RP continuity fixes

Goal: recover mood with elapsed real time, space unanswered wakes, and recall
recent experiences outside the latest three rounds.

Architecture: reuse settlement on a working copy for read previews. Capture
turn gates after elapsed time settles, before authored operations. Reuse the
wake runtime's persisted delivery timestamp; retain the existing memory quota.
No save migration, new dependency, branch change or commit is needed.

## 1. Regression tests first

- [x] `engine/tests/test_mood_gates.py`: use an isolated database and a patched
  clock. Expire two negative thoughts; assert brief/full context and mood
  panels recover without modifying stored state. Assert the next normal reply
  succeeds, the original absence still requires its offscreen beat, and undo
  retains the stored state rather than the preview.
- [x] `engine/tests/test_wake.py`: after a delivered wake, assert another
  unanswered wake waits 12/24 hours, respects quiet hours, and a later player
  reply takes precedence. Exercise the timestamp through the sidecar schema.
- [x] `test/wake.mjs`: assert delivery time is forwarded, repeated schedules
  retain it, and a real reply in the watched conversation resets the streak.
- [x] `engine/tests/test_memories.py`: cue a memory older than the latest three
  but still in 刚刚; assert retrieval, quota and no duplicates.
- [x] Run these test files and confirm failures describe the reviewed bugs.

## 2. Small implementation changes

- [x] `domain/settlement.py`, `application/service.py`: add a read-only time
  preview using `facts.working_copy()` and existing `settlement.advance()`;
  use it for context, status and mood reads.
- [x] `domain/ops.py`, `domain/turn.py`: capture initial mood and action
  candidates after time settlement, before applying authored operations.
- [x] `domain/wake.py`, `application/specs.py`, `application/service.py`,
  `lib/wake.js`: accept an optional last-delivery timestamp; anchor repeated
  waits to it, preserve quiet-hour conversion, reset streak on a watched user
  reply and keep its protocol value within the existing limit.
- [x] `domain/memories.py`: exclude already-injected entries and action-only
  records from retrieval, while allowing remaining 刚刚 experiences to score.
- [x] Update the existing documentation to describe the resulting behavior.

## 3. Verification

- [x] Run focused tests until the new cases and existing cases pass.
- [x] Run `python tests/run_all.py` from `engine/` and all nine Node test
  scripts from the repository root, once after implementation stabilizes.
- [x] Inspect `git diff --check`, the final diff and repository status.
- [x] Report the result and the lack of a live DSH/overnight acceptance run.

Verified: all 8 Python suites (195 cases), all 9 Node scripts (560 assertions), and git diff --check passed. Live DSH and overnight use remain unverified.
