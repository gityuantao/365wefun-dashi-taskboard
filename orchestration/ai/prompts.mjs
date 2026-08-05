export function buildAnalysisPrompt(task) {
  return [
    "你是研发分析器。分析下面的 ClickUp 任务，输出严格的 JSON，不要输出其他文字。",
    `任务名称：${task.name ?? ""}`,
    `任务描述：${task.description ?? ""}`,
    "输出格式：",
    '{ "scope": "范围描述", "acceptance_criteria": [ { "id": "ac-1", "criterion": "验收标准", "verification": "如何验证" } ], "risks": [ { "level": "低", "description": "风险" } ], "open_questions": [ { "question": "未决问题" } ] }',
    "约束：不修改代码，不推进状态，只输出 JSON。",
    "决策原则：你是独立的产品/研发分析者，不是客服。基于任务名称、描述和产品常识主动做合理假设，自主确定实现方向、范围和验收标准；",
    "所有假设必须写进 scope 或 risks（例如：假设 X 平台默认包含、假设未知品牌保留灰色占位图兜底），而不是抛给用户确认。",
    "open_questions 仅在信息完全缺失、无法从上下文推断、且该决策会显著改变实现方向或验收标准时才填写，最多 2 条；其余任何不确定性和小范围细节一律放入 risks。默认返回空数组 []。",
  ].join("\n");
}

export function buildDevelopmentPrompt(task, acceptanceCriteria = []) {
  return [
    "你是研发开发器。在任务 Worktree 内实现需求并完成自动验证，输出严格 JSON，不要输出其他文字。",
    `任务名称：${task.name ?? ""}`,
    `任务描述：${task.description ?? ""}`,
    "验收标准：",
    ...acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion}`),
    "输出格式：",
    '{ "change_summary": "改动摘要", "tests": [ { "name": "测试名", "passed": true } ] }',
    "约束：只修改当前 Worktree，不推进状态、不读取凭据、不部署生产。",
    "约束：不要执行 pnpm install / npm install；不要运行完整 typecheck、构建或测试套件（Worktree 无依赖，会卡住）；改为用文件检查和代码阅读验证改动正确性。",
  ].join("\n");
}

export function buildAcceptancePrompt(task, acceptanceCriteria = [], commitSha) {
  return [
    "你是验收器。按验收标准独立核验交付结果，输出严格 JSON，不要输出其他文字。只读核验，不得修改代码或自行修复。",
    `任务名称：${task.name ?? ""}`,
    `目标 Commit：${commitSha ?? "未指定"}`,
    "验收标准：",
    ...acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion}（验证：${criterion.verification ?? "未指定"}）`),
    "输出格式：",
    '{ "acceptance_result": "accepted|rejected", "criteria_results": [ { "id": "ac-1", "result": "passed|failed" } ], "findings": [ { "severity": "high", "description": "问题" } ] }',
    "约束：证据缺失不能视为通过；不推进状态。",
  ].join("\n");
}
