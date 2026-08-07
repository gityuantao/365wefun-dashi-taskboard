const TASK_NAMES = {
  inbox: "收件箱",
  analyzing: "分析中",
  waiting_info: "待补充信息",
  ready_for_development: "待开发",
  developing: "开发中",
  ready_for_test: "待测试",
  testing: "测试中",
  ready_for_release: "待发布",
  published: "已发布",
  canceled: "已取消",
};

const VERSION_NAMES = {
  planning: "规划中",
  active: "进行中",
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
  "developing:accepting": "开发完成，进入验收",
  "developing:ready_for_development": "开发失败，退回待开发",
  "ready_for_test:testing": "开始测试",
  "testing:ready_for_release": "测试通过，进入待发布",
  "ready_for_test:ready_for_release": "测试通过，进入待发布",
  "testing:ready_for_development": "测试不通过，退回待开发",
  "accepting:ready_for_test": "验收通过，进入待测试",
  "accepting:ready_for_development": "验收不通过，退回待开发",
  "ready_for_release:published": "任务已随版本发布",
};

const VERSION_COMMENTS = {
  "active:releasing": "开始发布",
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

export function correctionText(type, to, from = null) {
  const names = type === "version" ? VERSION_NAMES : TASK_NAMES;
  const toName = names[to] ?? to;
  if (
    type === "task"
    && from === "ready_for_release"
    && to === "published"
  ) {
    return null;
  }
  if (
    type === "version"
    && from === "releasing"
    && (to === "published" || to === "release_failed")
  ) {
    return null;
  }
  if (type === "version" && to === "active") {
    return `版本任务未全部就绪，状态回到「${toName}」。全部任务就绪后请改为「发布中」触发发布。`;
  }
  const fromName = from ? names[from] ?? from : "";
  const fromSuffix = fromName ? `（原「${fromName}」不符合当前流程）` : "";
  return `状态已回到「${toName}」${fromSuffix}`;
}
