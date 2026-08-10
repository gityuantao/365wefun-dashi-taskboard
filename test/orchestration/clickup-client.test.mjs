import assert from "node:assert/strict";
import test from "node:test";
import { createClickUpClient } from "../../orchestration/clickup/client.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { tasks: [] });
  };
}

test("client requires a token", () => {
  assert.throws(() => createClickUpClient({ token: "" }), /TOKEN_REQUIRED/);
});

test("getTask returns the parsed task", async () => {
  const task = { id: "86d3x800a", name: "Sample", status: { status: "待发布" } };
  const calls = [];
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, task);
    },
  });
  const result = await client.getTask("86d3x800a");
  assert.deepEqual(result, task);
  assert.ok(calls[0].url.includes("/task/86d3x800a"));
  assert.equal(calls[0].init.headers.Authorization, "pk_test");
});

test("getTasksByList returns the tasks array", async () => {
  const tasks = [{ id: "t1" }, { id: "t2" }];
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: async (url) => jsonResponse(200, { tasks }),
  });
  const result = await client.getTasksByList("901616282651");
  assert.equal(result.length, 2);
});

test("client retries transient 429 and 5xx responses", async () => {
  let attempts = 0;
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return jsonResponse(500, { err: "boom" });
      return jsonResponse(200, { id: "t1" });
    },
  });
  const result = await client.getTask("t1");
  assert.equal(result.id, "t1");
  assert.equal(attempts, 3);
});

test("client does not retry permanent client errors", async () => {
  let attempts = 0;
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse(404, { err: "not found" });
    },
  });
  await assert.rejects(() => client.getTask("missing"), /HTTP_404/);
  assert.equal(attempts, 1);
});

test("client times out slow requests", async () => {
  const client = createClickUpClient({
    token: "pk_test",
    timeoutMs: 50,
    fetchImpl: () => new Promise(() => {}),
  });
  await assert.rejects(() => client.getTask("t1"), /TIMEOUT/);
});

test("updateTaskStatus posts the status to the task", async () => {
  const calls = [];
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: recordingFetch(calls),
  });
  await client.updateTaskStatus("t1", "待发布");
  assert.ok(calls[0].url.includes("/task/t1"));
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].init.body), { status: "待发布" });
});

test("updateTaskStatus does not blindly retry an unknown transport outcome", async () => {
  let attempts = 0;
  const client = createClickUpClient({
    token: "pk_test",
    retries: 3,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("socket closed after upload");
    },
  });

  await assert.rejects(
    () => client.updateTaskStatus("t1", "待发布"),
    /NETWORK_ERROR/,
  );
  assert.equal(attempts, 1);
});

test("updateTaskDescription posts the description to the task", async () => {
  const calls = [];
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: recordingFetch(calls),
  });
  await client.updateTaskDescription("t1", "## 分析结果\n范围说明");
  assert.ok(calls[0].url.includes("/task/t1"));
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    description: "## 分析结果\n范围说明",
  });
});

test("updateCustomField posts the field value", async () => {
  const calls = [];
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: recordingFetch(calls),
  });
  await client.updateCustomField("t1", "field-1", true);
  assert.ok(calls[0].url.includes("/task/t1/field/field-1"));
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { value: true });
});

test("postComment sends the comment body", async () => {
  const calls = [];
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: recordingFetch(calls),
  });
  await client.postComment("t1", "测试通过");
  assert.ok(calls[0].url.includes("/task/t1/comment"));
  assert.deepEqual(JSON.parse(calls[0].init.body), { comment_text: "测试通过" });
});

test("getComments returns the comments array", async () => {
  const comments = [{ id: "c1", comment_text: "hello" }];
  const client = createClickUpClient({
    token: "pk_test",
    fetchImpl: async () => jsonResponse(200, { comments }),
  });
  const result = await client.getComments("t1");
  assert.deepEqual(result, comments);
});

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
  assert.equal(file.contentType, "image/png");
  assert.equal(file.contentLength, 4);
  assert.equal(seen[0].init.headers.Authorization, "pk-test");
});

test("downloadAttachment rejects an untrusted host", async () => {
  const client = createClickUpClient({ token: "pk-test" });
  await assert.rejects(() => client.downloadAttachment("https://example.com/a.png"), /ATTACHMENT_HOST/);
});

test("downloadAttachment rejects non-HTTPS URLs", async () => {
  const client = createClickUpClient({ token: "pk-test" });
  await assert.rejects(() => client.downloadAttachment("http://attachments.clickup.com/a.png"), /ATTACHMENT_HOST/);
});

test("downloadAttachment reports byte length when Content-Length is missing", async () => {
  const client = createClickUpClient({
    token: "pk-test",
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3, 4]), {
      headers: { "content-type": "image/png" },
    }),
  });

  const file = await client.downloadAttachment("https://attachments.clickup.com/a.png");

  assert.equal(file.contentLength, 4);
});

test("downloadAttachment reports byte length when Content-Length disagrees", async () => {
  const client = createClickUpClient({
    token: "pk-test",
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3, 4]), {
      headers: { "content-length": "2" },
    }),
  });

  const file = await client.downloadAttachment("https://attachments.clickup.com/a.png");

  assert.equal(file.contentLength, 4);
});

test("downloadAttachment disables automatic redirects before sending authentication", async () => {
  const calls = [];
  const client = createClickUpClient({
    token: "pk-test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response("", {
        status: 302,
        headers: { location: "https://example.com/a.png" },
      });
    },
  });

  await assert.rejects(
    () => client.downloadAttachment("https://attachments.clickup.com/a.png"),
    /HTTP_302/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "manual");
});

test("downloadAttachment accepts an explicitly allowed non-static host", async () => {
  const calls = [];
  const client = createClickUpClient({
    token: "pk-test",
    attachmentHostAllowlist: ["uploads.clickup-cdn.example"],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(Uint8Array.from([1]), { headers: { "content-length": "1" } });
    },
  });

  const file = await client.downloadAttachment("https://uploads.clickup-cdn.example/a.png");

  assert.deepEqual([...file.body], [1]);
  assert.equal(calls[0].url, "https://uploads.clickup-cdn.example/a.png");
});

test("downloadAttachment accepts official and exact tenant ClickUp attachment hosts", async () => {
  const calls = [];
  const client = createClickUpClient({
    token: "pk-test",
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(Uint8Array.from([1]));
    },
  });

  await client.downloadAttachment("https://attachments-public.clickup.com/public.png");
  await client.downloadAttachment(
    "https://t90161712199.p.clickup-attachments.com/private.png",
  );

  assert.deepEqual(calls, [
    "https://attachments-public.clickup.com/public.png",
    "https://t90161712199.p.clickup-attachments.com/private.png",
  ]);
});

test("downloadAttachment rejects ClickUp attachment suffix tricks and nested tenant labels", async () => {
  const client = createClickUpClient({ token: "pk-test" });

  for (const url of [
    "https://t90161712199.p.clickup-attachments.com.evil.example/private.png",
    "https://nested.t90161712199.p.clickup-attachments.com/private.png",
    "https://evilp.clickup-attachments.com/private.png",
  ]) {
    await assert.rejects(
      () => client.downloadAttachment(url),
      (error) => error.code === "ATTACHMENT_HOST",
    );
  }
});

test("client rejects malformed explicit attachment host allowlists", () => {
  assert.throws(
    () => createClickUpClient({
      token: "pk-test",
      attachmentHostAllowlist: ["uploads.clickup-cdn.example@evil.example"],
    }),
    /ATTACHMENT_HOST/,
  );
});
