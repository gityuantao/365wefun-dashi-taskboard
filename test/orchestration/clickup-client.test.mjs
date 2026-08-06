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
