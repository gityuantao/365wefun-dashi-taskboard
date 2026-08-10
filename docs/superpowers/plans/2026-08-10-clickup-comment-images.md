# ClickUp Comment Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ClickUp comment images authenticated, validated, temporary Codex image inputs for analysis, development, and acceptance, with fail-closed diagnostics and cleanup.

**Architecture:** A focused comment-media collector converts raw ClickUp comments into text plus local image descriptors. The ClickUp client exposes authenticated binary download, AI executors own collector lifetime, and `runCodex` passes local files through repeatable `--image` arguments. Selection, validation, limits, diagnostics, and cleanup remain independent from prompt formatting.

**Tech Stack:** Node.js ESM, ClickUp REST API, filesystem temporary directories, Codex CLI `exec --image`, Node test runner.

## Global Constraints

- Analysis, development, and acceptance must all receive comment images as real multimodal input.
- Image-only comments are valid feedback and must not be discarded.
- Supported inputs are PNG, JPEG, WebP, and GIF; GIF is passed using the supported static-image behavior of the installed Codex CLI.
- Authentication failures, corrupt content, and unavailable critical images fail closed and move the task to `waiting_info` with a non-sensitive reason.
- Temporary images never enter Git or persistent logs and are removed on success, failure, timeout, and cancellation.
- New production behavior must be introduced through a failing test first.

---

## File Structure

- Create `orchestration/clickup/comment-media.mjs`: select comments, discover image attachments, download and validate bytes, create structured context, and clean temporary files.
- Modify `orchestration/clickup/client.mjs`: expose an authenticated `downloadAttachment(url)` binary method restricted to ClickUp-hosted URLs returned by the API.
- Modify `orchestration/ai/prompts.mjs`: render comment/image association labels without embedding local paths.
- Modify `orchestration/runner/codex-runner.mjs`: accept `imagePaths` and append repeatable `--image` arguments.
- Modify `orchestration/ai/analyzer.mjs`, `developer.mjs`, `acceptance.mjs`: create the media bundle, pass images, fail closed, and always clean up.
- Test `test/orchestration/comment-media.test.mjs`, `codex-runner.test.mjs`, `analyzer.test.mjs`, `developer.test.mjs`, `acceptance.test.mjs`.

### Task 1: Authenticated ClickUp binary download

**Files:**
- Modify: `orchestration/clickup/client.mjs`
- Test: `test/orchestration/clickup-client.test.mjs`

**Interfaces:**
- Produces: `client.downloadAttachment(url): Promise<{ body: Uint8Array, contentType: string, contentLength: number }>`
- Security rule: only `https:` URLs whose host is `api.clickup.com`, `attachments.clickup.com`, or a host explicitly returned by the ClickUp API allowlist helper are accepted.

- [ ] **Step 1: Write failing tests for authenticated binary download and host rejection**

```js
test("downloadAttachment sends ClickUp auth and returns binary metadata", async () => {
  const seen = [];
  const client = createClickUpClient({ token: "pk-test", fetchImpl: async (url, init) => {
    seen.push({ url, init });
    return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {
      headers: { "content-type": "image/png", "content-length": "4" },
    });
  }});
  const file = await client.downloadAttachment("https://attachments.clickup.com/a.png");
  assert.deepEqual([...file.body], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(seen[0].init.headers.Authorization, "pk-test");
});

test("downloadAttachment rejects an untrusted host", async () => {
  const client = createClickUpClient({ token: "pk-test" });
  await assert.rejects(() => client.downloadAttachment("https://example.com/a.png"), /ATTACHMENT_HOST/);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/orchestration/clickup-client.test.mjs`

Expected: FAIL because `downloadAttachment` is not defined.

- [ ] **Step 3: Implement the binary request path**

Add a binary request helper that reuses timeout/retry logic, never JSON-decodes bytes, validates URL protocol/host, and returns copied `Uint8Array` data with normalized content type and length.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `node --test test/orchestration/clickup-client.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestration/clickup/client.mjs test/orchestration/clickup-client.test.mjs
git commit -m "feat: download ClickUp comment images securely"
```

### Task 2: Comment media selection, validation, and cleanup

**Files:**
- Create: `orchestration/clickup/comment-media.mjs`
- Create: `test/orchestration/comment-media.test.mjs`

**Interfaces:**
- Produces: `collectCommentMedia({ comments, client, taskId, tempRoot, maxComments = 12, maxImages = 8, maxImageBytes = 10_000_000, maxTotalBytes = 30_000_000 }): Promise<{ textContext, images, diagnostics, cleanup }>`
- `images` item: `{ commentId, date, filename, contentType, localPath }`.
- `cleanup(): Promise<void>` is idempotent.

- [ ] **Step 1: Write failing selection tests**

Cover newest-first comments, image-only comments, attachment/image fields used by ClickUp, and preserved comment-to-image labels. Assert that the newest 12 comments are selected and an image-only comment contributes an image descriptor.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/orchestration/comment-media.test.mjs`

Expected: FAIL because `collectCommentMedia` does not exist.

- [ ] **Step 3: Implement selection and safe temporary paths**

Use `mkdtemp(path.join(tempRoot ?? tmpdir(), "taskboard-clickup-images-"))`, generated filenames based on ordinal plus verified extension, and mode `0700` for the directory. Never use upstream filenames as a filesystem path.

- [ ] **Step 4: Add failing validation and limit tests**

Test valid PNG/JPEG/WebP/GIF signatures; reject HTML with `image/png` header; reject per-image overflow; prefer newer images when the count/total limit is reached; record a diagnostic for every omitted image.

- [ ] **Step 5: Implement signature validation and deterministic limits**

Map signatures to canonical MIME/extensions, compare response MIME with detected bytes, enforce limits before writing, and return structured diagnostics such as `{ code: "IMAGE_LIMIT", commentId, filename }`.

- [ ] **Step 6: Add failing cleanup tests**

Call `cleanup()` twice after success and after a simulated second-download failure; assert the temporary directory is absent both times.

- [ ] **Step 7: Implement fail-safe cleanup**

Wrap collection in `try/catch`; remove the temporary directory before rethrowing. Implement returned cleanup with `rm(dir, { recursive: true, force: true })`.

- [ ] **Step 8: Run the complete component tests**

Run: `node --test test/orchestration/comment-media.test.mjs`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add orchestration/clickup/comment-media.mjs test/orchestration/comment-media.test.mjs
git commit -m "feat: collect validated comment images"
```

### Task 3: Codex CLI multimodal arguments

**Files:**
- Modify: `orchestration/runner/codex-runner.mjs`
- Modify: `test/orchestration/codex-runner.test.mjs`

**Interfaces:**
- Consumes: `runCodex({ ..., imagePaths?: string[] })`.
- Produces: CLI args `exec --image <absolute-path> --image <absolute-path>` before any optional skill argument.

- [ ] **Step 1: Write the failing runner test**

```js
test("runCodex attaches every comment image", async () => {
  const child = mockChild();
  let args;
  const promise = runCodex({
    workdir: "/tmp/worktree",
    prompt: "inspect screenshots",
    imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
    spawnImpl: (_bin, value) => { args = value; return child; },
  });
  child.emit("close", 0);
  await promise;
  assert.deepEqual(args, ["exec", "--image", "/tmp/a.png", "--image", "/tmp/b.jpg"]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/orchestration/codex-runner.test.mjs`

Expected: FAIL because image arguments are absent.

- [ ] **Step 3: Implement path validation and CLI arguments**

Require each path to be an absolute non-empty string and append `--image`, path pairs. Reject relative paths with `INVALID_IMAGE_PATH` before spawning.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/orchestration/codex-runner.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestration/runner/codex-runner.mjs test/orchestration/codex-runner.test.mjs
git commit -m "feat: pass comment images to Codex"
```

### Task 4: Wire images into analysis, development, and acceptance

**Files:**
- Modify: `orchestration/ai/prompts.mjs`
- Modify: `orchestration/ai/analyzer.mjs`
- Modify: `orchestration/ai/developer.mjs`
- Modify: `orchestration/ai/acceptance.mjs`
- Modify: `test/orchestration/analyzer.test.mjs`
- Modify: `test/orchestration/developer.test.mjs`
- Modify: `test/orchestration/acceptance.test.mjs`

**Interfaces:**
- Consumes: `collectCommentMedia(...)` and `codex.run({ prompt, workdir, taskId, imagePaths })`.
- Produces: prompt labels `评论 <commentId> 图片：<filename>` and guaranteed cleanup in `finally`.

- [ ] **Step 1: Write failing tests for all three AI stages**

For each executor, return one text comment and one image from the fake client. Capture Codex options and assert `imagePaths` contains the downloaded path and the prompt contains the matching comment id/filename.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/orchestration/analyzer.test.mjs test/orchestration/developer.test.mjs test/orchestration/acceptance.test.mjs`

Expected: FAIL because executors still pass only text.

- [ ] **Step 3: Replace direct `buildCommentContext(getComments())` calls**

Each executor creates one media bundle, builds the prompt from `textContext`, passes `images.map(image => image.localPath)`, and calls `await bundle.cleanup()` in `finally` after Codex returns or throws.

- [ ] **Step 4: Add failing fail-closed tests**

Simulate a corrupt critical image. Assert Codex is never called, the task transitions to `waiting_info`, and the ClickUp comment names the failed attachment without token or local temporary path.

- [ ] **Step 5: Implement shared diagnostic formatting**

Convert collector failures into a concise `comment image unavailable: <filename> (<code>)` reason and use each executor's existing needs-info transition path. Do not silently catch media errors.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/orchestration/analyzer.test.mjs test/orchestration/developer.test.mjs test/orchestration/acceptance.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add orchestration/ai/prompts.mjs orchestration/ai/analyzer.mjs orchestration/ai/developer.mjs orchestration/ai/acceptance.mjs test/orchestration/analyzer.test.mjs test/orchestration/developer.test.mjs test/orchestration/acceptance.test.mjs
git commit -m "feat: read ClickUp screenshots in every AI stage"
```

### Task 5: End-to-end regression and operational documentation

**Files:**
- Modify: `test/orchestration/mvp-e2e.test.mjs`
- Modify: `docs/开发记录.md`

**Interfaces:**
- Verifies the public workflow rather than adding a new production interface.

- [ ] **Step 1: Add an end-to-end image-only feedback scenario**

Create a ClickUp task whose newest rejection comment contains only an image. Assert the development Codex call receives the image and the workflow can continue to acceptance without losing the association.

- [ ] **Step 2: Run the scenario and verify RED before final wiring**

Run: `node --test test/orchestration/mvp-e2e.test.mjs`

Expected before final fixture wiring: FAIL because the fake ClickUp binary endpoint is absent.

- [ ] **Step 3: Complete the fake binary endpoint and record operations behavior**

Document supported types, limits, fail-closed behavior, cleanup, and how operators identify the specific unreadable attachment.

- [ ] **Step 4: Run all orchestration tests**

Run: `node --test test/orchestration/*.test.mjs`

Expected: all tests PASS with no leaked temporary `taskboard-clickup-images-*` directories.

- [ ] **Step 5: Commit**

```bash
git add test/orchestration/mvp-e2e.test.mjs docs/开发记录.md
git commit -m "test: cover image-only ClickUp feedback"
```
