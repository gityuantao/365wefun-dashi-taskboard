# Rework Retry and Latest Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an explicit ClickUp move back to 待开发 authorize one new development attempt while guaranteeing that development reads the latest 12 comments and their images.

**Architecture:** Reuse the existing `clearOrdinaryDevelopmentFailures` boundary in the ClickUp poller at the two explicit rework transitions, leaving version/waiting/info failures untouched. Keep comment selection centralized in `collectCommentMedia`/`buildCommentContext`; add an end-to-end developer regression that proves the exact latest-12 text and image window reaches Codex. Recover the already-transitioned `86d3yebnh` with one exact local D1 cleanup after the code is deployed.

**Tech Stack:** Node.js ESM, Cloudflare D1/SQLite, Node test runner, ClickUp poller, Codex multimodal runner.

## Global Constraints

- Explicit rework transitions are only `acceptance_rejected -> ready_for_development` and `ready_for_test -> ready_for_development`.
- Clear only ordinary failed `auto-develop-<taskId>` jobs; preserve `waiting_version`, `waiting:`, `needs_human`, and `needs_info` failures.
- Do not create automatic retry loops after an ordinary development failure without a new explicit user transition.
- Select comments by descending timestamp and use exactly the latest 12 for both text and images.
- Include the ClickUp 验收反馈 field with the selected comment context.
- Comment-image collection remains fail-closed and keeps its current validation, redaction, and cleanup behavior.
- Do not add a database migration or change ClickUp statuses.

---

### Task 1: Authorize a Fresh Development Job on Explicit Rework

**Files:**
- Modify: `cloud/src/clickup-poller.mjs:547-562`
- Modify: `cloud/src/clickup-poller.mjs:599-614`
- Test: `test/orchestration/clickup-poller.test.mjs:1236-1259`
- Test: `test/orchestration/clickup-poller.test.mjs:1384-1400`

**Interfaces:**
- Consumes: existing `clearOrdinaryDevelopmentFailures(db, taskId): Promise<void>`.
- Produces: both explicit rework paths clear only ordinary historical develop failures before dispatching their state transition; `ensureStateJob` then enqueues `<taskId>-develop-<aggregateVersion>`.

- [ ] **Step 1: Extend the rejected-task test with a historical ordinary failure**

Before `pollClickUpOnce`, insert a failed job using the real persistence helper:

```js
await enqueueJob(harness.db, {
  jobId: "task-1-develop-old",
  commandId: "auto-develop-task-1",
  jobType: "develop",
  payload: { taskId: "task-1" },
  payloadHash: "old-failure",
  expiresAt: "2026-08-11T02:00:00.000Z",
  createdAt: "2026-08-11T00:00:00.000Z",
});
await harness.db.prepare(
  `UPDATE runner_jobs
   SET status = 'failed', result = ?, completed_at = ?
   WHERE id = ?`,
).bind(
  JSON.stringify({
    status: "failed",
    error: "HTTP_400: Custom field usages exceeded for your plan",
  }),
  "2026-08-11T00:01:00.000Z",
  "task-1-develop-old",
).run();
```

After polling, assert the old row is absent and a new queued develop row exists:

```js
const oldFailure = await harness.db.prepare(
  "SELECT id FROM runner_jobs WHERE id = ?",
).bind("task-1-develop-old").first();
assert.equal(oldFailure, null);
const queued = await harness.db.prepare(
  "SELECT id FROM runner_jobs WHERE job_type = 'develop' AND status = 'queued'",
).first();
assert.ok(queued);
```

- [ ] **Step 2: Run the rejected-task regression and verify RED**

Run:

```bash
node --test --test-name-pattern='poller routes a rejected task back to rework' test/orchestration/clickup-poller.test.mjs
```

Expected: FAIL because `task-1-develop-old` remains and no new develop job is queued.

- [ ] **Step 3: Extend the ready-for-test → 待开发 test with the same historical failure**

Use the same `enqueueJob` plus exact `UPDATE runner_jobs SET status = 'failed'` setup in `moving directly to 待开发 is treated as test failed`, then assert the old ordinary failure is deleted and the new develop job is queued.

- [ ] **Step 4: Run the ready-for-test regression and verify RED**

Run:

```bash
node --test --test-name-pattern='moving directly to 待开发 is treated as test failed' test/orchestration/clickup-poller.test.mjs
```

Expected: FAIL for the same stale ordinary-failure blocker.

- [ ] **Step 5: Clear ordinary failures at both explicit transition boundaries**

In the rejected-task branch, add the clear immediately before dispatching `acceptance_rejected_to_develop`:

```js
if (aggregate.state === "acceptance_rejected" && snapshot.status === "ready_for_development") {
  await clearOrdinaryDevelopmentFailures(env.DB, snapshot.id);
  // existing command construction and dispatch
}
```

In the ready-for-test branch, add the clear immediately before dispatching `test_failed`:

```js
} else if (aggregate.state === "ready_for_test" && snapshot.status === "ready_for_development") {
  await clearOrdinaryDevelopmentFailures(env.DB, snapshot.id);
  // existing command construction and dispatch
}
```

Do not call the helper from `ensureStateJob`; doing so would create an automatic retry loop without a new user transition.

- [ ] **Step 6: Verify GREEN and preserved special failures**

Run:

```bash
node --test --test-name-pattern='rejected task back to rework|moving directly to 待开发|ordinary failed task stays blocked|waiting.*version|needs info' test/orchestration/clickup-poller.test.mjs
```

Expected: all selected tests PASS. Confirm tests that cover `waiting_version`, `waiting:`, `needs_human`, and `needs_info` still pass unchanged.

- [ ] **Step 7: Commit Task 1**

```bash
git add cloud/src/clickup-poller.mjs test/orchestration/clickup-poller.test.mjs
git commit -m "fix: authorize explicit development rework"
```

---

### Task 2: Prove the Latest-12 Text and Image Window Reaches Development

**Files:**
- Test: `test/orchestration/developer.test.mjs`
- Verify existing implementation: `orchestration/ai/developer.mjs:176-235`
- Verify existing implementation: `orchestration/clickup/comment-media.mjs:164-176,305-417`
- Verify existing implementation: `orchestration/ai/prompts.mjs:1-14,93-117`

**Interfaces:**
- Consumes: `collectCommentMedia({ comments, client, taskId, limit = 12 })` returning `{ textContext, images, cleanup }`.
- Produces: regression evidence that `executeDevelopment` sends Codex only the newest 12 comments, includes latest rejection text and image, excludes the oldest comment and image, includes 验收反馈, and cleans downloaded files.

- [ ] **Step 1: Write a developer test with 13 deliberately unordered comments**

Create comments with numeric `date` values where `comment-oldest` is outside the latest 12 and `comment-rejected` is newest:

```js
const comments = Array.from({ length: 13 }, (_, index) => ({
  id: `comment-${index}`,
  date: String(1_000 + index),
  comment_text: index === 12
    ? "❌ 最新验收不通过：支付按钮仍然无响应"
    : `评论-${index}`,
  attachments: index === 12
    ? [{ title: "latest-rejection.png", url: "https://attachments.clickup.com/latest-rejection.png" }]
    : index === 0
      ? [{ title: "old-outside-window.png", url: "https://attachments.clickup.com/old-outside-window.png" }]
      : [],
})).reverse();
```

Make `getTask` return an 验收反馈 value of `验收字段：测试环境支付仍失败`. Capture `codex.run` options and downloaded URLs. Assert:

```js
assert.match(options.prompt, /最新验收不通过：支付按钮仍然无响应/);
assert.match(options.prompt, /验收字段：测试环境支付仍失败/);
assert.doesNotMatch(options.prompt, /评论-0/);
assert.equal(downloadedUrls.some((url) => url.includes("latest-rejection.png")), true);
assert.equal(downloadedUrls.some((url) => url.includes("old-outside-window.png")), false);
assert.equal(options.imagePaths.length, 1);
```

Also assert the downloaded latest image path is removed after `executeDevelopment` returns.

- [ ] **Step 2: Run the new developer regression**

Run:

```bash
node --test --test-name-pattern='development uses the latest 12 comments and images' test/orchestration/developer.test.mjs
```

Expected: PASS with the existing centralized latest-comment implementation. If it fails, make only the smallest correction in `comment-media.mjs` or `prompts.mjs` needed to make text and images share the exact same descending-time window, then rerun.

- [ ] **Step 3: Run all comment-image development regressions**

Run:

```bash
node --test --test-name-pattern='development.*comment|development.*image|development waits for info' test/orchestration/developer.test.mjs
```

Expected: all selected tests PASS, including corrupt-image and decoder-failure fail-closed cases.

- [ ] **Step 4: Commit Task 2**

```bash
git add test/orchestration/developer.test.mjs orchestration/clickup/comment-media.mjs orchestration/ai/prompts.mjs
git commit -m "test: protect latest rework feedback context"
```

Only stage production files if the new regression required an actual implementation correction.

---

### Task 3: Full Regression, Runtime Restart, and `86d3yebnh` Recovery

**Files:**
- Verify: `cloud/src/clickup-poller.mjs`
- Verify: `orchestration/ai/developer.mjs`
- Local runtime data only: `.data/orchestration-d1/**`
- Update: `docs/开发记录.md`

**Interfaces:**
- Consumes: committed Task 1 and Task 2 behavior.
- Produces: running orchestrator with the fix loaded and one queued/claimed development attempt for `86d3yebnh` whose prompt contains the latest rejection context.

- [ ] **Step 1: Run focused tests**

```bash
node --test test/orchestration/clickup-poller.test.mjs test/orchestration/developer.test.mjs
```

Expected: 0 failures.

- [ ] **Step 2: Run full orchestration regression and static checks**

```bash
pnpm test:orchestration
node --check cloud/src/clickup-poller.mjs
node --check orchestration/ai/developer.mjs
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Commit the verification record**

Append to `docs/开发记录.md` the bug cause, explicit-rework behavior, latest-12 comment/image guarantee, focused/full test results, and commit IDs. Then run:

```bash
git add docs/开发记录.md
git commit -m "docs: record explicit rework recovery"
```

- [ ] **Step 4: Restart only the orchestrator child and verify supervision**

```bash
old_pid=$(lsof -nP -t -iTCP:47824 -sTCP:LISTEN | head -1)
kill -TERM "$old_pid"
sleep 8
new_pid=$(lsof -nP -t -iTCP:47824 -sTCP:LISTEN | head -1)
test -n "$new_pid" && test "$new_pid" != "$old_pid"
curl -fsS http://127.0.0.1:47824/api/orchestration/dashboard >/dev/null
```

Expected: a new PID listens on 47824 and the Dashboard API returns HTTP 200.

- [ ] **Step 5: Recover only the already-transitioned live task**

Because `86d3yebnh` transitioned before the fixed code was loaded, delete only its stale ordinary failed rows using the exact production predicate:

```sql
DELETE FROM runner_jobs
WHERE command_id = 'auto-develop-86d3yebnh'
  AND status = 'failed'
  AND COALESCE(result, '') NOT LIKE '%waiting_version%'
  AND COALESCE(result, '') NOT LIKE '%waiting:%'
  AND COALESCE(result, '') NOT LIKE '%needs_human%'
  AND COALESCE(result, '') NOT LIKE '%needs_info%';
```

Before deleting, query and report the exact row IDs. Do not touch another task or another job classification.

- [ ] **Step 6: Verify the live task enters development**

Wait up to two poll intervals, then query D1 and ClickUp evidence:

```sql
SELECT id, job_type, status, created_at, claimed_at, result
FROM runner_jobs
WHERE command_id = 'auto-develop-86d3yebnh'
ORDER BY created_at DESC LIMIT 3;
```

Expected: a new develop job is queued or claimed, then ClickUp moves to 开发中. Inspect the Codex invocation evidence/logs to confirm the latest rejection comment context was collected; do not expose private attachment URLs or local temporary paths.

- [ ] **Step 7: Final workspace verification**

```bash
git status --short
```

Expected: only the pre-existing local `.data` symlink is untracked.
