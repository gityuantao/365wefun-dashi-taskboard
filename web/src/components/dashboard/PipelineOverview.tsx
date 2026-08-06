import type { PipelineCounts } from "../../types";

const PIPELINE_LABELS: Array<{ key: keyof PipelineCounts; label: string }> = [
  { key: "inbox", label: "收件箱" },
  { key: "analyzing", label: "分析中" },
  { key: "waiting_info", label: "待补充信息" },
  { key: "ready_for_development", label: "待开发" },
  { key: "developing", label: "开发中" },
  { key: "accepting", label: "验收中" },
  { key: "ready_for_test", label: "待测试" },
  { key: "testing", label: "测试中" },
  { key: "ready_for_release", label: "待发布" },
  { key: "published", label: "已发布" },
];

export function PipelineOverview({ pipeline }: { pipeline: PipelineCounts }) {
  return (
    <section className="dashboard-section pipeline-overview" aria-labelledby="pipeline-title">
      <div className="dashboard-section-heading">
        <h2 id="pipeline-title">流水线总览</h2>
      </div>
      <ol className="pipeline-grid">
        {PIPELINE_LABELS.map((item) => {
          const count = pipeline[item.key];
          const tone = item.key === "waiting_info"
            ? "warning"
            : item.key === "ready_for_release"
              ? "success"
              : "neutral";
          return (
            <li
              className={`pipeline-cell pipeline-${tone}${count === 0 ? " is-empty" : ""}`}
              key={item.key}
            >
              <span className="pipeline-count">{count}</span>
              <span className="pipeline-label">{item.label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
