export function buildCommentContext(comments, limit = 12) {
  if (!Array.isArray(comments) || comments.length === 0) return null;
  const allHaveDates = comments.every((comment) => Number.isFinite(Number(comment.date)));
  const recent = allHaveDates
    ? [...comments].sort((left, right) => Number(right.date) - Number(left.date)).slice(0, limit)
    : comments.slice(-limit);
  const lines = recent
    .map((comment) => `- ${String(comment.comment_text ?? comment.text ?? "")}`)
    .filter((line) => line.trim() !== "-")
    .join("\n");
  return lines.length > 0 ? lines : null;
}

function safeAttachmentFilename(value) {
  return String(value ?? "unknown-attachment")
    .replace(/[\r\n]/g, " ")
    .split(/[\\/]/)
    .at(-1)
    .split(/[?#]/, 1)[0]
    .trim()
    .slice(0, 120) || "unknown-attachment";
}

export function formatCommentMediaError(error) {
  if (!error?.details?.filename) {
    return "comment history unavailable (COMMENTS_UNAVAILABLE)";
  }
  const filename = safeAttachmentFilename(error.details.filename);
  const code = String(error?.code ?? "UNKNOWN")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 40) || "UNKNOWN";
  return `comment image unavailable: ${filename} (${code})`;
}

export function commentImageDecodeFailure(value, images = []) {
  const diagnostic = [value?.stderr, value?.message]
    .filter((part) => typeof part === "string")
    .join("\n");
  if (!(
    /(?:decode|decoder|invalid|unsupported|corrupt|unreadable)[^\r\n]{0,100}image/i.test(diagnostic)
    || /image[^\r\n]{0,100}(?:decode|decoder|invalid|unsupported|corrupt|unreadable)/i.test(diagnostic)
  )) {
    return null;
  }
  const image = images.find((candidate) => diagnostic.includes(candidate.localPath)) ?? images[0];
  if (!image) return null;
  return `comment image unavailable: ${safeAttachmentFilename(image.filename)} (IMAGE_DECODE_FAILED)`;
}

export function formatCommentMediaDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null;
  const lines = diagnostics.map((diagnostic) => {
    const commentId = String(diagnostic?.commentId ?? "unknown")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 80) || "unknown";
    const filename = safeAttachmentFilename(diagnostic?.filename);
    const code = String(diagnostic?.code ?? "IMAGE_LIMIT")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 40) || "IMAGE_LIMIT";
    return `- 评论 ${commentId} 图片：${filename}（${code}）`;
  });
  return ["⚠️ 部分评论图片未读取（已优先保留最新图片）：", ...lines].join("\n");
}

export function formatCodexMediaRunFailure(value, images = []) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const exitCode = Number.isInteger(value?.exitCode) ? `, exit ${value.exitCode}` : "";
  return `codex comment-image run failed (CODEX_IMAGE_RUN_FAILED${exitCode})`;
}

export function buildAnalysisPrompt(task, commentContext = null, platforms = null) {
  return [
    "你是研发分析器。分析下面的 ClickUp 任务，输出严格的 JSON，不要输出其他文字。",
    `任务名称：${task.name ?? ""}`,
    `任务描述：${task.description ?? ""}`,
    ...(platforms ? [`影响平台（ClickUp 字段）：${platforms}`] : []),
    "输出格式：",
    '{ "summary": "一句话问题/需求概述", "scope": "范围描述", "acceptance_criteria": [ { "id": "ac-1", "criterion": "验收标准", "verification": "如何验证" } ], "test_notes": [ "测试人员需要关注或操作的测试要点" ], "risks": [ { "level": "低", "description": "风险" } ], "open_questions": [ { "question": "未决问题" } ] }',
    "约束：不修改代码，不推进状态，只输出 JSON。",
    "决策原则：你是独立的产品/研发分析者，不是客服。基于任务名称、描述和产品常识主动做合理假设，自主确定实现方向、范围和验收标准；",
    "平台范围：优先严格按「影响平台」字段确定（如 web/iOS/安卓/小程序）；字段为空时根据任务描述推断并在 scope 中写明推断的平台范围。验收标准的验证方式必须覆盖这些平台，不得遗漏。",
    "所有假设必须写进 scope 或 risks（例如：假设 X 平台默认包含、假设未知品牌保留灰色占位图兜底），而不是抛给用户确认。",
    "open_questions 仅在信息完全缺失、无法从上下文推断、且该决策会显著改变实现方向或验收标准时才填写，最多 2 条；其余任何不确定性和小范围细节一律放入 risks。默认返回空数组 []。",
    ...(commentContext
      ? [
          "任务评论区（最近反馈，重点：需求澄清与验收不通过原因）：",
          commentContext,
        ]
      : []),
  ].join("\n");
}

export function buildDevelopmentPrompt(
  task,
  acceptanceCriteria = [],
  commentContext = null,
  platforms = null,
  rejectionFindings = [],
  acceptanceFeedback = null,
) {
  return [
    "你是研发开发器。在任务 Worktree 内实现需求并完成自动验证，输出严格 JSON，不要输出其他文字。",
    `任务名称：${task.name ?? ""}`,
    `任务描述：${task.description ?? ""}`,
    ...(platforms ? [`影响平台（ClickUp 字段）：${platforms}`] : []),
    "验收标准：",
    ...acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion}`),
    "输出格式（完成修复时）：",
    '{ "outcome": "changed", "change_summary": "改动摘要", "finding_responses": [ { "finding_index": 1, "location": "修复位置", "action": "修复动作", "verification": "验证证据" } ], "tests": [ { "name": "聚焦验证名", "passed": true } ] }',
    "仓库当前实现已经满足需求且不需要新增改动时：",
    '{ "outcome": "already_satisfied", "change_summary": "已有实现摘要", "evidence": [ { "location": "文件:行号", "verification": "实际执行的验证及结果" } ], "tests": [ { "name": "聚焦验证名", "passed": true } ] }',
    "只有缺少无法从任务、评论、仓库和合理默认值推断的业务决定，且不同答案会显著改变实现或验收时，才可请求信息：",
    '{ "outcome": "needs_info", "reason": "互斥或缺失的业务决定", "questions": [ "用户可以直接回答的具体问题" ] }',
    "无法复现、线上实测正常、已有修复、局部工具缺失、无关编译或测试故障都不是 needs_info；请分别继续检查已有实现、返回 already_satisfied，或在 tests 中如实记录验证阻塞。",
    "约束：禁止为了出 PR 而凑改动；已有实现必须给出精确代码位置和实际验证证据。",
    "执行顺序：先复现并定位一个最小根因，再实施能解决验收标准的最小改动；禁止把缺陷修复扩展成相邻功能重构、全平台架构改造或非必要公共包设计。",
    "范围规则：「影响平台」表示必须检查这些平台，不表示每个平台都必须修改。只修改实际存在根因的平台，其他平台用聚焦证据说明无需改动。",
    "收敛规则：如果 Worktree 已有大量未提交改动，先审计并保留与当前根因直接相关的部分；不得在未收敛前继续扩大范围。",
    "约束：只修改当前 Worktree，不推进状态、不读取凭据、不部署生产。",
    "验证规则：允许并应运行与改动直接相关的聚焦测试、聚焦 typecheck 或聚焦 build；只报告实际执行的命令和结果。",
    "命令边界：禁止无目的 pnpm install / npm install，禁止默认运行无边界的全仓测试、全仓 typecheck 或全仓 build，禁止生产部署；若依赖或平台工具缺失，明确记录未完成的验证，不得虚假声称通过。",
    ...(Array.isArray(rejectionFindings) && rejectionFindings.length > 0
      ? [
          "上一轮代码验收的完整结构化 findings（权威返工清单，独立于评论区）：",
          ...rejectionFindings.map((finding, index) => `- finding ${index + 1}: ${JSON.stringify(finding)}`),
          "必须在 finding_responses 中逐项对应上述 finding，分别写明修复位置、修复动作和验证证据；仅可在有仓库证据时标记不适用，并把证据写进 verification。",
        ]
      : []),
    ...(acceptanceFeedback
      ? [
          "ClickUp「验收反馈」字段（辅助上下文，独立于结构化 findings）：",
          String(acceptanceFeedback),
        ]
      : []),
    ...(commentContext
      ? [
          "任务评论区（最近补充说明与历史反馈；与结构化 findings 分开参考）：",
          commentContext,
        ]
      : []),
  ].join("\n");
}

export function buildAcceptancePrompt(task, acceptanceCriteria = [], commitSha, commentContext = null) {
  return [
    "你是代码验收器。按验收标准独立核验代码交付结果，输出严格 JSON，不要输出其他文字。只读核验，不得修改代码或自行修复。",
    `任务名称：${task.name ?? ""}`,
    `目标 Commit：${commitSha ?? "未指定"}`,
    "验收标准：",
    ...acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion}（验证：${criterion.verification ?? "未指定"}）`),
    "输出格式：",
    '{ "acceptance_result": "accepted|rejected", "criteria_results": [ { "id": "ac-1", "result": "passed|failed" } ], "findings": [ { "severity": "high", "description": "问题" } ] }',
    "职责边界：本阶段只做 code acceptance，检查真实代码缺陷、需求实现完整性、生产调用链是否接入，以及与改动相称的聚焦测试/typecheck/build 证据。不得虚假通过，不推进状态。",
    "可拒绝：存在真实代码缺陷、实现未接入生产链路、缺少当前代码改动应有且可运行的聚焦验证，或交付声称与仓库证据不符。",
    "不得仅因缺少 iOS/Web/Android/小程序四端实机、TestFlight、已部署测试环境或人工测试证据而拒绝；这些证据属于后续 staging/testing。若代码层面没有其他缺陷，将相应标准判为 passed。",
    "证据缺失不能视为代码已验证，但必须区分代码级证据与后续环境级证据。",
    ...(commentContext
      ? [
          "任务评论区（历史验收反馈，避免重复遗漏同一问题）：",
          commentContext,
        ]
      : []),
  ].join("\n");
}
