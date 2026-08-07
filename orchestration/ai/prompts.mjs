export function buildCommentContext(comments, limit = 12) {
  if (!Array.isArray(comments) || comments.length === 0) return null;
  const lines = comments
    .slice(-limit)
    .map((comment) => `- ${String(comment.comment_text ?? comment.text ?? "")}`)
    .filter((line) => line.trim() !== "-")
    .join("\n");
  return lines.length > 0 ? lines : null;
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

export function buildDevelopmentPrompt(task, acceptanceCriteria = [], commentContext = null, platforms = null) {
  return [
    "你是研发开发器。在任务 Worktree 内实现需求并完成自动验证，输出严格 JSON，不要输出其他文字。",
    `任务名称：${task.name ?? ""}`,
    `任务描述：${task.description ?? ""}`,
    ...(platforms ? [`影响平台（ClickUp 字段）：${platforms}`] : []),
    "验收标准：",
    ...acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion}`),
    "输出格式（完成修复时）：",
    '{ "change_summary": "改动摘要", "tests": [ { "name": "测试名", "passed": true } ] }',
    "无法完成开发时（问题无法复现、任务信息不足、线上实测正常找不到可修点），必须输出：",
    '{ "needs_info": true, "reason": "为什么无法完成/需要补充什么信息" }',
    "约束：无法复现或信息不足时禁止强行改动代码或为了出 PR 而凑改动，一律输出 needs_info。",
    "约束：改动必须覆盖「影响平台」字段列出的全部平台（web/iOS/安卓/小程序）；字段为空时按任务描述与验收标准推断。",
    "约束：只修改当前 Worktree，不推进状态、不读取凭据、不部署生产。",
    "约束：不要执行 pnpm install / npm install；不要运行完整 typecheck、构建或测试套件（Worktree 无依赖，会卡住）；改为用文件检查和代码阅读验证改动正确性。",
    ...(commentContext
      ? [
          "任务评论区（重点：上一次验收不通过的原因，必须在本次实现中修复）：",
          commentContext,
        ]
      : []),
  ].join("\n");
}

export function buildAcceptancePrompt(task, acceptanceCriteria = [], commitSha, commentContext = null) {
  return [
    "你是验收器。按验收标准独立核验交付结果，输出严格 JSON，不要输出其他文字。只读核验，不得修改代码或自行修复。",
    `任务名称：${task.name ?? ""}`,
    `目标 Commit：${commitSha ?? "未指定"}`,
    "验收标准：",
    ...acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion}（验证：${criterion.verification ?? "未指定"}）`),
    "输出格式：",
    '{ "acceptance_result": "accepted|rejected", "criteria_results": [ { "id": "ac-1", "result": "passed|failed" } ], "findings": [ { "severity": "high", "description": "问题" } ] }',
    "约束：证据缺失不能视为通过；不推进状态。",
    ...(commentContext
      ? [
          "任务评论区（历史验收反馈，避免重复遗漏同一问题）：",
          commentContext,
        ]
      : []),
  ].join("\n");
}
