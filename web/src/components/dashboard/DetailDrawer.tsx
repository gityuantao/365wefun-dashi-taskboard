import type { TaskDetail, VersionDetail } from "../../types";

interface DetailDrawerProps {
  kind: "task" | "version";
  detail: TaskDetail | VersionDetail | null;
  onClose: () => void;
}

export function DetailDrawer({ kind, detail, onClose }: DetailDrawerProps) {
  return (
    <aside className="detail-drawer" aria-label="详情" role="dialog">
      <header className="detail-drawer-header">
        <strong>{kind === "task" ? "任务详情" : "版本详情"}</strong>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭详情"
          title="关闭"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {!detail ? (
        <p className="detail-drawer-loading">正在加载…</p>
      ) : kind === "task" ? (
        <TaskDetailBody detail={detail as TaskDetail} />
      ) : (
        <VersionDetailBody detail={detail as VersionDetail} />
      )}
    </aside>
  );
}

function TaskDetailBody({ detail }: { detail: TaskDetail }) {
  return (
    <div className="detail-drawer-body">
      <h3>{detail.name}</h3>
      <dl className="detail-fields">
        <div><dt>目标版本</dt><dd>{detail.targetVersion ?? "未设置"}</dd></div>
        <div><dt>当前状态</dt><dd>{detail.status ?? "未知"}</dd></div>
        <div><dt>负责人</dt><dd>{detail.assignee ?? "未设置"}</dd></div>
      </dl>
      {detail.prUrl && (
        <p className="detail-link">
          <a href={detail.prUrl} target="_blank" rel="noreferrer">查看 PR</a>
        </p>
      )}
      {detail.summary && (
        <section className="detail-block">
          <h4>执行摘要</h4>
          <p>{detail.summary}</p>
        </section>
      )}
      {detail.acceptanceCriteria.length > 0 && (
        <section className="detail-block">
          <h4>验收标准</h4>
          <ol>
            {detail.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ol>
        </section>
      )}
      {detail.changeSummary && (
        <section className="detail-block">
          <h4>改动摘要</h4>
          <p>{detail.changeSummary}</p>
        </section>
      )}
      <section className="detail-block">
        <h4>状态时间线</h4>
        <ol className="detail-timeline">
          {detail.timeline.map((entry, index) => (
            <li key={`${entry.time}-${index}`}>
              <time>{new Date(entry.time).toLocaleString("zh-CN")}</time>
              <span>{entry.summary}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function VersionDetailBody({ detail }: { detail: VersionDetail }) {
  return (
    <div className="detail-drawer-body">
      <h3>{detail.name}</h3>
      <dl className="detail-fields">
        <div><dt>状态</dt><dd>{detail.status ?? "未知"}</dd></div>
        <div><dt>发布阻塞</dt><dd>{detail.blocked ? "是" : "否"}</dd></div>
      </dl>
      <section className="detail-block">
        <h4>任务清单</h4>
        {detail.tasks.length === 0 ? (
          <p>暂无任务</p>
        ) : (
          <ul className="detail-task-list">
            {detail.tasks.map((task) => (
              <li key={task.id}>
                <span>{task.name}</span>
                <span className={task.ready ? "detail-ready" : ""}>
                  {task.ready ? "就绪" : task.status ?? "未知"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {detail.manifest && (
        <section className="detail-block">
          <h4>Manifest</h4>
          <p className="detail-monospace">
            checksum: {detail.manifest.checksum}
            <br />
            createdAt: {detail.manifest.createdAt}
          </p>
        </section>
      )}
    </div>
  );
}
