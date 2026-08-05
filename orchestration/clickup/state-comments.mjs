const TASK_NAMES = {
  inbox: "收件箱",
  analyzing: "分析中",
  waiting_info: "待补充信息",
  ready_for_development: "待开发",
  developing: "开发中",
  ready_for_test: "待测试",
  testing: "测试中",
  ready_for_acceptance: "待验收",
  accepting: "验收中",
  ready_for_release: "待发布",
  published: "已发布",
  canceled: "已取消",
};

const VERSION_NAMES = {
  planning: "规划中",
  active: "进行中",
  ready_for_release: "待发布",
  releasing: "发布中",
  release_failed: "发布失败",
  published: "已发布",
  canceled: "已取消",
};

const TASK_COMMENTS = {
  "inbox:analyzing": "开始分析",
  "analyzing:ready_for_development": "分析完成，进入待开发",
  "analyzing:waiting_info": "信息不足，等待补充",
  "waiting_info:analyzing": "重新开始分析",
  "ready_for_development:developing": "开始开发",
  "developing:ready_for_test": "开发完成，进入待测试",
  "developing:ready_for_development": "开发失败，退回待开发",
  "ready_for_test:testing": "开始测试",
  "testing:ready_for_acceptance": "测试通过，进入待验收",
  "testing:ready_for_development": "测试不通过，退回待开发",
  "ready_for_acceptance:accepting": "开始验收",
  "accepting:ready_for_release": "验收通过，进入待发布",
  "accepting:ready_for_development": "验收不通过，退回待开发",
  "ready_for_release:published": "任务已随版本发布",
};

const VERSION_COMMENTS = {
  "active:ready_for_release": "版本任务就绪，进入待发布",
  "ready_for_release:releasing": "开始发布",
  "releasing:published": "发布成功",
  "releasing:release_failed": "发布失败",
  "release_failed:releasing": "重新发布",
  "release_failed:active": "回到进行中",
};

export function stateChangeText(type, from, to, detail = "") {
  const map = type === "version" ? VERSION_COMMENTS : TASK_COMMENTS;
  const names = type === "version" ? VERSION_NAMES : TASK_NAMES;
  const text = map[`${from}:${to}`];
  if (!text) return null;
  const suffix = detail ? `：${detail}` : "";
  return `${text}${suffix}`;
}
