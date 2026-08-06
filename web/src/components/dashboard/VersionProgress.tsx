import type { VersionProgress } from "../../types";

const VERSION_STATUS_LABELS: Record<string, string> = {
  planning: "规划中",
  active: "进行中",
  ready_for_release: "待发布",
  releasing: "发布中",
  release_failed: "发布失败",
  published: "已发布",
  canceled: "已取消",
};

export function VersionProgressList({
  versions,
  onOpen,
}: {
  versions: VersionProgress[];
  onOpen: (version: VersionProgress) => void;
}) {
  return (
    <section className="dashboard-section version-progress" aria-labelledby="version-progress-title">
      <div className="dashboard-section-heading">
        <h2 id="version-progress-title">版本进度</h2>
        <span className="dashboard-section-count">{versions.length}</span>
      </div>
      {versions.length === 0 ? (
        <p className="version-progress-empty">暂无版本</p>
      ) : (
        <ul className="version-progress-list">
          {versions.map((version) => {
            const percent = version.taskCount === 0
              ? 0
              : Math.round((version.readyCount / version.taskCount) * 100);
            return (
              <li key={version.id}>
                <button
                  className="version-progress-card"
                  type="button"
                  onClick={() => onOpen(version)}
                >
                  <span className="version-progress-name">{version.name}</span>
                  {version.releasable && <span className="badge badge-releasable">可发布</span>}
                  {version.releaseFailed && <span className="badge badge-failed">发布失败</span>}
                  <span className={`badge badge-status badge-status-${version.status ?? "unknown"}`}>
                    {VERSION_STATUS_LABELS[version.status ?? ""] ?? version.status ?? "未知"}
                  </span>
                  <span className="version-progress-track" aria-hidden="true">
                    <span
                      className={`version-progress-fill${percent >= 100 ? " is-complete" : ""}`}
                      style={{ width: `${percent}%` }}
                    />
                  </span>
                  <span className="version-progress-meta">
                    {version.readyCount}/{version.taskCount} 就绪
                    {version.notReadyCount > 0 && ` · 未就绪 ${version.notReadyCount} 个任务`}
                    {version.hasOpenBlockers && " · 存在阻塞任务"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
