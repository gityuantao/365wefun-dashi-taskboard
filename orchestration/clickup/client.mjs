import { DomainError } from "../domain/errors.mjs";

const DEFAULT_BASE_URL = "https://api.clickup.com/api/v2";
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 200;

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

export function createClickUpClient({
  token,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  retries = DEFAULT_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new DomainError("TOKEN_REQUIRED", "ClickUp API token is required");
  }
  const headers = {
    Authorization: token.trim(),
    "Content-Type": "application/json",
  };

  async function request(pathname, { method = "GET", body } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
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
          if (attempt < retries) {
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
        if (attempt < retries) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new DomainError("NETWORK_ERROR", `ClickUp request failed: ${error.message}`);
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
  };
}
