import { DomainError } from "../domain/errors.mjs";

const DEFAULT_BASE_URL = "https://api.clickup.com/api/v2";
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_ATTACHMENT_MAX_BYTES = 10_000_000;
const TRUSTED_ATTACHMENT_HOSTS = new Set([
  "api.clickup.com",
  "attachments.clickup.com",
  "attachments-public.clickup.com",
]);
const CLICKUP_TENANT_ATTACHMENT_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.p\.clickup-attachments\.com$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DomainError("TIMEOUT", message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createAttachmentHostAllowlist(extraHosts) {
  if (!Array.isArray(extraHosts)) {
    throw new DomainError("ATTACHMENT_HOST", "Attachment host allowlist must be an array");
  }
  const hosts = new Set(TRUSTED_ATTACHMENT_HOSTS);
  for (const host of extraHosts) {
    if (typeof host !== "string" || host.trim() === "") {
      throw new DomainError("ATTACHMENT_HOST", "Attachment host allowlist contains an invalid host");
    }
    const normalizedHost = host.trim().toLowerCase();
    let parsed;
    try {
      parsed = new URL(`https://${normalizedHost}`);
    } catch {
      throw new DomainError("ATTACHMENT_HOST", "Attachment host allowlist contains an invalid host");
    }
    if (parsed.hostname !== normalizedHost || parsed.port !== "") {
      throw new DomainError("ATTACHMENT_HOST", "Attachment host allowlist contains an invalid host");
    }
    hosts.add(parsed.hostname);
  }
  return hosts;
}

function trustedAttachmentUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError("ATTACHMENT_HOST", "Attachment URL must be a trusted HTTPS URL");
  }
  if (
    url.protocol !== "https:"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || (
      !allowedHosts.has(url.hostname)
      && !CLICKUP_TENANT_ATTACHMENT_HOST.test(url.hostname)
    )
  ) {
    throw new DomainError("ATTACHMENT_HOST", "Attachment URL host is not trusted");
  }
  return url;
}

function normalizedContentType(value) {
  return value?.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
}

async function cancelBody(body) {
  try {
    await body?.cancel?.();
  } catch {
    // The original HTTP/limit error remains authoritative.
  }
}

async function readBoundedBody(response, { maxBytes, controller, setReader }) {
  const rawLength = response.headers.get("content-length");
  const declaredLength = /^\d+$/.test(rawLength ?? "") ? Number(rawLength) : null;
  if (declaredLength !== null && declaredLength > maxBytes) {
    await cancelBody(response.body);
    controller.abort(new Error("attachment exceeds byte limit"));
    throw new DomainError("IMAGE_TOO_LARGE", "ClickUp attachment exceeds the byte limit", {
      maxBytes,
    });
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new DomainError("ATTACHMENT_BODY", "ClickUp attachment response has no readable body");
  }
  const reader = response.body.getReader();
  setReader(reader);
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size error remains authoritative.
      }
      controller.abort(new Error("attachment exceeds byte limit"));
      throw new DomainError("IMAGE_TOO_LARGE", "ClickUp attachment exceeds the byte limit", {
        maxBytes,
      });
    }
    chunks.push(Uint8Array.from(chunk));
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createClickUpClient({
  token,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  retries = DEFAULT_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  attachmentHostAllowlist = [],
} = {}) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new DomainError("TOKEN_REQUIRED", "ClickUp API token is required");
  }
  const allowedAttachmentHosts = createAttachmentHostAllowlist(attachmentHostAllowlist);
  const headers = {
    Authorization: token.trim(),
    "Content-Type": "application/json",
  };

  async function request(pathname, { method = "GET", body } = {}) {
    let lastError = null;
    const requestRetries = method === "GET" ? retries : 0;
    for (let attempt = 0; attempt <= requestRetries; attempt += 1) {
      try {
        const response = await withTimeout(
          fetchImpl(`${baseUrl}${pathname}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          timeoutMs,
          `ClickUp request timed out after ${timeoutMs}ms`,
        );
        if (response.status === 429 || response.status >= 500) {
          lastError = new DomainError(
            `HTTP_${response.status}`,
            `ClickUp API returned ${response.status}`,
            { status: response.status },
          );
          if (attempt < requestRetries) {
            await sleep(retryDelayMs * 2 ** attempt);
            continue;
          }
          throw lastError;
        }
        const text = await response.text();
        if (!response.ok) {
          throw new DomainError(
            `HTTP_${response.status}`,
            `ClickUp API returned ${response.status}: ${text.slice(0, 200)}`,
            { status: response.status, body: text.slice(0, 500) },
          );
        }
        return text === "" ? null : JSON.parse(text);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        lastError = error;
        if (attempt < requestRetries) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new DomainError("NETWORK_ERROR", `ClickUp request failed: ${error.message}`);
      }
    }
    throw lastError;
  }

  async function requestAttachment(url, { maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new DomainError("INVALID_IMAGE_LIMIT", "Attachment maxBytes must be a positive integer");
    }
    const attachmentUrl = trustedAttachmentUrl(url, allowedAttachmentHosts);
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeoutError = new DomainError(
        "TIMEOUT",
        `ClickUp attachment request timed out after ${timeoutMs}ms`,
      );
      let timedOut = false;
      let reader = null;
      let timer;
      try {
        const operation = (async () => {
          const response = await fetchImpl(attachmentUrl.href, {
            method: "GET",
            headers,
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status === 429 || response.status >= 500) {
            await cancelBody(response.body);
            throw new DomainError(
              `HTTP_${response.status}`,
              `ClickUp API returned ${response.status}`,
              { status: response.status },
            );
          }
          if (!response.ok) {
            await cancelBody(response.body);
            throw new DomainError(
              `HTTP_${response.status}`,
              `ClickUp API returned ${response.status}`,
              { status: response.status },
            );
          }
          const body = await readBoundedBody(response, {
            maxBytes,
            controller,
            setReader: (value) => { reader = value; },
          });
          return {
            body,
            contentType: normalizedContentType(response.headers.get("content-type")),
            contentLength: body.byteLength,
          };
        })();
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort(timeoutError);
            void reader?.cancel?.().catch?.(() => {});
            reject(timeoutError);
          }, timeoutMs);
        });
        return await Promise.race([operation, timeout]);
      } catch (error) {
        if (timedOut) throw timeoutError;
        if (error instanceof DomainError) {
          lastError = error;
          if ((error.code === "HTTP_429" || /^HTTP_5\d\d$/.test(error.code)) && attempt < retries) {
            await sleep(retryDelayMs * 2 ** attempt);
            continue;
          }
          throw error;
        }
        lastError = error;
        if (attempt < retries) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new DomainError("NETWORK_ERROR", `ClickUp request failed: ${error.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  function listTasks(listId, page) {
    return request(
      `/list/${encodeURIComponent(listId)}/task?archived=false&page=${page}`,
    );
  }

  return {
    getTask: (id) => request(`/task/${encodeURIComponent(id)}`),
    getTasksByList: async (listId, { page = 0 } = {}) => {
      const data = await listTasks(listId, page);
      return data.tasks ?? [];
    },
    getVersion: (id) => request(`/task/${encodeURIComponent(id)}`),
    getVersionsByList: async (listId, { page = 0 } = {}) => {
      const data = await listTasks(listId, page);
      return data.tasks ?? [];
    },
    createTask: (listId, data) => request(
      `/list/${encodeURIComponent(listId)}/task`,
      { method: "POST", body: data },
    ),
    updateTaskStatus: (taskId, status) => request(
      `/task/${encodeURIComponent(taskId)}`,
      { method: "PUT", body: { status } },
    ),
    updateTaskDescription: (taskId, description) => request(
      `/task/${encodeURIComponent(taskId)}`,
      { method: "PUT", body: { description } },
    ),
    updateCustomField: (taskId, fieldId, value) => request(
      `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`,
      { method: "POST", body: { value } },
    ),
    postComment: (taskId, commentText) => request(
      `/task/${encodeURIComponent(taskId)}/comment`,
      { method: "POST", body: { comment_text: commentText } },
    ),
    getComments: async (taskId) => {
      const data = await request(`/task/${encodeURIComponent(taskId)}/comment`);
      return data.comments ?? [];
    },
    downloadAttachment: (url, options) => requestAttachment(url, options),
  };
}
