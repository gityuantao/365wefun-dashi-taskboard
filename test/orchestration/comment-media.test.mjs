import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCommentMedia } from "../../orchestration/clickup/comment-media.mjs";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

async function makeTempRoot() {
  return mkdtemp(path.join(tmpdir(), "taskboard-comment-media-test-"));
}

test("collects the newest twelve comments and keeps image labels with their comments", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const comments = Array.from({ length: 13 }, (_, index) => ({
    id: `comment-${index + 1}`,
    date: String(index + 1),
    comment_text: `feedback ${index + 1}`,
  }));
  comments[12].attachments = [{
    title: "newest screenshot.png",
    url: "https://attachments.clickup.com/newest.png",
  }];
  comments[11].image = {
    filename: "second-newest.png",
    url: "https://attachments.clickup.com/second-newest.png",
  };
  const downloads = new Map([
    ["https://attachments.clickup.com/newest.png", { body: PNG, contentType: "image/png", contentLength: PNG.byteLength }],
    ["https://attachments.clickup.com/second-newest.png", { body: PNG, contentType: "image/png", contentLength: PNG.byteLength }],
  ]);

  const bundle = await collectCommentMedia({
    comments,
    client: { downloadAttachment: async (url) => downloads.get(url) },
    taskId: "task-1",
    tempRoot,
  });

  assert.match(bundle.textContext, /feedback 13/);
  assert.match(bundle.textContext, /feedback 2/);
  assert.doesNotMatch(bundle.textContext, /- feedback 1(?:\n|$)/);
  assert.match(bundle.textContext, /评论 comment-13 图片：newest screenshot\.png/);
  assert.match(bundle.textContext, /评论 comment-12 图片：second-newest\.png/);
  assert.deepEqual(
    bundle.images.map(({ commentId, filename, contentType }) => ({ commentId, filename, contentType })),
    [
      { commentId: "comment-13", filename: "newest screenshot.png", contentType: "image/png" },
      { commentId: "comment-12", filename: "second-newest.png", contentType: "image/png" },
    ],
  );
  for (const image of bundle.images) {
    assert.equal(path.dirname(image.localPath).startsWith(tempRoot), true);
    await access(image.localPath);
  }
});

test("keeps an image-only ClickUp comment as media context", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const bundle = await collectCommentMedia({
    comments: [{
      id: "image-only",
      date: "100",
      comment_text: "",
      attachments: [{
        name: "annotated.webp",
        url: "https://attachments.clickup.com/annotated.webp",
      }],
    }],
    client: {
      downloadAttachment: async () => ({
        body: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
        contentType: "image/webp",
        contentLength: 12,
      }),
    },
    taskId: "task-2",
    tempRoot,
  });

  assert.equal(bundle.images.length, 1);
  assert.equal(bundle.images[0].commentId, "image-only");
  assert.match(bundle.textContext, /评论 image-only 图片：annotated\.webp/);
});

test("rejects an image-only comment attachment that has no usable URL", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => collectCommentMedia({
      comments: [{
        id: "missing-url",
        date: "1",
        comment_text: "",
        attachments: [{ title: "unavailable.png" }],
      }],
      client: { downloadAttachment: async () => { throw new Error("must not download"); } },
      taskId: "task-missing-url",
      tempRoot,
    }),
    (error) => error.code === "IMAGE_UNAVAILABLE" && error.details.filename === "unavailable.png",
  );
});

test("accepts PNG, JPEG, WebP, and GIF bytes using their canonical media types", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const files = [
    ["png", "image/png", PNG],
    ["jpeg", "image/jpeg", JPEG],
    ["webp", "image/webp", WEBP],
    ["gif", "image/gif", GIF],
  ];
  const bundle = await collectCommentMedia({
    comments: files.map(([id], index) => ({
      id,
      date: String(4 - index),
      attachments: [{ title: `${id}.source`, url: `https://attachments.clickup.com/${id}` }],
    })),
    client: {
      downloadAttachment: async (url) => {
        const [, type, body] = files.find(([id]) => url.endsWith(`/${id}`));
        return { body, contentType: type, contentLength: body.byteLength };
      },
    },
    taskId: "task-types",
    tempRoot,
  });

  assert.deepEqual(
    bundle.images.map(({ contentType, localPath }) => [contentType, path.extname(localPath)]),
    [
      ["image/png", ".png"],
      ["image/jpeg", ".jpg"],
      ["image/webp", ".webp"],
      ["image/gif", ".gif"],
    ],
  );
});

test("rejects an HTML response that claims to be a PNG", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => collectCommentMedia({
      comments: [{
        id: "html-error",
        date: "1",
        attachments: [{ title: "screen.png", url: "https://attachments.clickup.com/error" }],
      }],
      client: {
        downloadAttachment: async () => ({
          body: new TextEncoder().encode("<html>expired attachment</html>"),
          contentType: "image/png",
          contentLength: 31,
        }),
      },
      taskId: "task-html",
      tempRoot,
    }),
    (error) => error.code === "INVALID_IMAGE" && error.details.filename === "screen.png",
  );
});

test("rejects bytes whose detected image type disagrees with the response MIME", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => collectCommentMedia({
      comments: [{
        id: "mime-mismatch",
        date: "1",
        attachments: [{ title: "screen.jpg", url: "https://attachments.clickup.com/mismatch" }],
      }],
      client: { downloadAttachment: async () => ({ body: PNG, contentType: "image/jpeg", contentLength: PNG.byteLength }) },
      taskId: "task-mismatch",
      tempRoot,
    }),
    (error) => error.code === "IMAGE_TYPE_MISMATCH" && error.details.filename === "screen.jpg",
  );
});

test("omits every older image after the image-count limit while retaining the newest one", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const bundle = await collectCommentMedia({
    comments: ["newest", "middle", "oldest"].map((id, index) => ({
      id,
      date: String(3 - index),
      attachments: [{ title: `${id}.png`, url: `https://attachments.clickup.com/${id}` }],
    })),
    client: { downloadAttachment: async () => ({ body: PNG, contentType: "image/png", contentLength: PNG.byteLength }) },
    taskId: "task-count-limit",
    tempRoot,
    maxImages: 1,
  });

  assert.deepEqual(bundle.images.map((image) => image.commentId), ["newest"]);
  assert.deepEqual(bundle.diagnostics, [
    { code: "IMAGE_LIMIT", commentId: "middle", filename: "middle.png" },
    { code: "IMAGE_LIMIT", commentId: "oldest", filename: "oldest.png" },
  ]);
  assert.match(bundle.textContext, /评论 middle 图片未读取：middle\.png（IMAGE_LIMIT）/);
  assert.match(bundle.textContext, /评论 oldest 图片未读取：oldest\.png（IMAGE_LIMIT）/);
});

test("omits an older missing-URL attachment after selecting the newest image limit", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const bundle = await collectCommentMedia({
    comments: [
      {
        id: "newest",
        date: "2",
        attachments: [{ title: "newest.png", url: "https://attachments.clickup.com/newest" }],
      },
      {
        id: "older-missing-url",
        date: "1",
        attachments: [{ title: "older.png" }],
      },
    ],
    client: { downloadAttachment: async () => ({ body: PNG, contentType: "image/png", contentLength: PNG.byteLength }) },
    taskId: "task-limit-before-url",
    tempRoot,
    maxImages: 1,
  });

  assert.deepEqual(bundle.images.map((image) => image.commentId), ["newest"]);
  assert.deepEqual(bundle.diagnostics, [
    { code: "IMAGE_LIMIT", commentId: "older-missing-url", filename: "older.png" },
  ]);
  assert.match(bundle.textContext, /评论 older-missing-url 图片未读取：older\.png（IMAGE_LIMIT）/);
});

test("omits an image that exceeds either the per-image or total byte limit", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const comments = [
    { id: "newest", date: "2", attachments: [{ title: "newest.png", url: "https://attachments.clickup.com/newest" }] },
    { id: "older", date: "1", attachments: [{ title: "older.png", url: "https://attachments.clickup.com/older" }] },
  ];
  const client = { downloadAttachment: async () => ({ body: PNG, contentType: "image/png", contentLength: PNG.byteLength }) };
  const perImage = await collectCommentMedia({
    comments: [comments[0]], client, taskId: "task-per-image", tempRoot, maxImageBytes: PNG.byteLength - 1,
  });
  const total = await collectCommentMedia({
    comments, client, taskId: "task-total", tempRoot, maxTotalBytes: PNG.byteLength,
  });

  assert.deepEqual(perImage.images, []);
  assert.deepEqual(perImage.diagnostics, [
    { code: "IMAGE_LIMIT", commentId: "newest", filename: "newest.png" },
  ]);
  assert.match(perImage.textContext, /评论 newest 图片未读取：newest\.png（IMAGE_LIMIT）/);
  assert.deepEqual(total.images.map((image) => image.commentId), ["newest"]);
  assert.deepEqual(total.diagnostics, [
    { code: "IMAGE_LIMIT", commentId: "older", filename: "older.png" },
  ]);
  assert.match(total.textContext, /评论 older 图片未读取：older\.png（IMAGE_LIMIT）/);
});

test("uses each discovered attachment ordinal for nameless omission diagnostics", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const bundle = await collectCommentMedia({
    comments: [{
      id: "nameless",
      date: "1",
      attachments: [
        { url: "https://attachments.clickup.com/first" },
        { url: "https://attachments.clickup.com/second" },
      ],
    }],
    client: { downloadAttachment: async () => { throw new Error("limit must skip downloads"); } },
    taskId: "task-nameless",
    tempRoot,
    maxImages: 0,
  });

  assert.deepEqual(bundle.diagnostics, [
    { code: "IMAGE_LIMIT", commentId: "nameless", filename: "attachment-1" },
    { code: "IMAGE_LIMIT", commentId: "nameless", filename: "attachment-2" },
  ]);
  assert.match(bundle.textContext, /评论 nameless 图片未读取：attachment-1（IMAGE_LIMIT）/);
  assert.match(bundle.textContext, /评论 nameless 图片未读取：attachment-2（IMAGE_LIMIT）/);
});

test("cleanup is idempotent after a successful download", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const bundle = await collectCommentMedia({
    comments: [{
      id: "successful-download",
      date: "1",
      attachments: [{ title: "screen.png", url: "https://attachments.clickup.com/success" }],
    }],
    client: { downloadAttachment: async () => ({ body: PNG, contentType: "image/png", contentLength: PNG.byteLength }) },
    taskId: "task-cleanup-success",
    tempRoot,
  });
  const directory = path.dirname(bundle.images[0].localPath);

  await bundle.cleanup();
  await bundle.cleanup();

  await assert.rejects(() => access(directory), { code: "ENOENT" });
});

test("removes downloaded media when a later attachment download fails", async (t) => {
  const tempRoot = await makeTempRoot();
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  let downloads = 0;
  const downloadFailure = Object.assign(
    new Error("authorization failed token=download-secret"),
    { code: "HTTP_401" },
  );

  await assert.rejects(
    () => collectCommentMedia({
      comments: [
        { id: "first", date: "2", attachments: [{ title: "first.png", url: "https://attachments.clickup.com/first" }] },
        { id: "second", date: "1", attachments: [{ title: "second.png", url: "https://attachments.clickup.com/second" }] },
      ],
      client: {
        downloadAttachment: async () => {
          downloads += 1;
          if (downloads === 2) throw downloadFailure;
          return { body: PNG, contentType: "image/png", contentLength: PNG.byteLength };
        },
      },
      taskId: "task-cleanup-failure",
      tempRoot,
    }),
    (error) => {
      assert.equal(error.code, "HTTP_401");
      assert.equal(error.details.commentId, "second");
      assert.equal(error.details.filename, "second.png");
      assert.deepEqual(error.details.cause, { name: "Error", code: "HTTP_401" });
      assert.doesNotMatch(error.message, /download-secret|token=/);
      return true;
    },
  );

  assert.deepEqual(await readdir(tempRoot), []);
});
