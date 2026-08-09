import type { MouseEvent } from "react";
import type { ReleasableVersion } from "../../types";

export function ReleaseActions({
  versions,
  onOpen,
}: {
  versions: ReleasableVersion[];
  onOpen: (version: ReleasableVersion, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <section className="dashboard-section release-actions" aria-labelledby="release-actions-title">
      <div className="dashboard-section-heading">
        <h2 id="release-actions-title">版本发布（待你操作）</h2>
        <span className="dashboard-section-count">{versions.length}</span>
      </div>
      {versions.length === 0 ? (
        <p className="release-actions-empty">暂无待发布版本，所有版本都在推进中</p>
      ) : (
        <ul className="release-action-list">
          {versions.map((version) => (
            <li className="release-action-row" key={version.id}>
              <div className="release-action-copy">
                <strong>{version.name}</strong>
                <span>{version.readyCount}/{version.taskCount} 个任务已就绪</span>
              </div>
              {version.releaseFailed ? (
                <span className="badge badge-failed">发布失败 · 可重试</span>
              ) : (
                <span className="badge badge-releasable">可发布</span>
              )}
              <a
                className="button release-action-link"
                href={version.url}
                target="_blank"
                rel="noreferrer"
                title={`在 ClickUp 打开 ${version.id}`}
              >
                {version.id}
              </a>
              <button
                className="button secondary release-action-detail"
                type="button"
                onClick={(event) => onOpen(version, event)}
              >
                查看详情
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
