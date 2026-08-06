import { useEffect, useRef } from "react";
import { LinearIcon } from "../LinearIcon";
import type { TaskDetail, VersionDetail } from "../../types";

interface DetailDrawerProps {
  kind: "task" | "version";
  detail: TaskDetail | VersionDetail | null;
  onClose: () => void;
}

const TASK_STATUS_LABELS: Record<string, string> = {
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

const VERSION_STATUS_LABELS: Record<string, string> = {
  planning: "规划中",
  active: "进行中",
  ready_for_release: "待发布",
  releasing: "发布中",
  release_failed: "发布失败",
  published: "已发布",
  canceled: "已取消",
};

export function DetailDrawer({ kind, detail, onClose }: DetailDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  function closeFromBackdrop(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="task-dialog detail-dialog"
      aria-label={kind === "task" ? "任务详情" : "版本详情"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={closeFromBackdrop}
    >
      <header className="dialog-header">
        <div className="dialog-context">
          <LinearIcon name={kind === "task" ? "myIssues" : "project"} />
          <strong>{kind === "task" ? "任务详情" : "版本详情"}</strong>
        </div>
        <div className="dialog-header-actions">
          {detail && (
            <>
              <a
                className="detail-external-link"
                href={`https://app.clickup.com/t/${detail.id}`}
                target="_blank"
                rel="noreferrer"
              >
                在 ClickUp 查看
              </a>
              {kind === "task" && (detail as TaskDetail).prUrl && (
                <a
                  className="detail-external-link"
                  href={(detail as TaskDetail).prUrl!}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看 PR
                </a>
              )}
            </>
          )}
          <button
            className="icon-button dialog-close"
            type="button"
            aria-label="关闭详情"
            title="关闭 (Esc)"
            onClick={onClose}
          >
            <LinearIcon name="close" />
          </button>
        </div>
      </header>

      {detail && (kind === "task"
        ? <TaskHero detail={detail as TaskDetail} />
        : <VersionHero detail={detail as VersionDetail} />)}

      {!detail ? (
        <div className="form-body detail-dialog-body detail-dialog-loading">
          <p>正在加载…</p>
        </div>
      ) : kind === "task" ? (
        <TaskDetailBody detail={detail as TaskDetail} />
      ) : (
        <VersionDetailBody detail={detail as VersionDetail} />
      )}

    </dialog>
  );
}

function TaskHero({ detail }: { detail: TaskDetail }) {
  const statusLabel = TASK_STATUS_LABELS[detail.status ?? ""] ?? detail.status ?? "未知";
  return (
    <header className="detail-dialog-hero">
      <div className="detail-dialog-title">
        <h3>{detail.name}</h3>
        <span className="detail-id">{detail.id}</span>
      </div>
      <span className="badge badge-status">{statusLabel}</span>
    </header>
  );
}

function VersionHero({ detail }: { detail: VersionDetail }) {
  const statusLabel = VERSION_STATUS_LABELS[detail.status ?? ""] ?? detail.status ?? "未知";
  return (
    <header className="detail-dialog-hero">
      <div className="detail-dialog-title">
        <h3>{detail.name}</h3>
        <span className="detail-id">{detail.id}</span>
      </div>
      <span className={`badge badge-status${detail.status === "release_failed" ? " badge-failed" : ""}`}>
        {statusLabel}
      </span>
    </header>
  );
}

function TaskDetailBody({ detail }: { detail: TaskDetail }) {
  return (
    <div className="form-body detail-dialog-body">
      <div className="detail-info-grid">
        <div className="detail-info-cell">
          <dt>目标版本</dt>
          <dd>{detail.targetVersion ?? "未设置"}</dd>
        </div>
        <div className="detail-info-cell">
          <dt>负责人</dt>
          <dd>{detail.assignee ?? "未设置"}</dd>
        </div>
        <div className="detail-info-cell">
          <dt>验收结论</dt>
          <dd>
            {detail.acceptanceResult === "accepted"
              ? "已通过"
              : detail.acceptanceResult === "rejected"
                ? "未通过"
                : "未验收"}
          </dd>
        </div>
      </div>

      {detail.summary && (
        <section className="detail-section">
          <h4>执行摘要</h4>
          <p>{detail.summary}</p>
        </section>
      )}

      {detail.acceptanceCriteria.length > 0 && (
        <section className="detail-section">
          <h4>验收标准</h4>
          <ol className="detail-criteria">
            {detail.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ol>
        </section>
      )}

      {detail.changeSummary && (
        <section className="detail-section">
          <h4>改动摘要</h4>
          <p>{detail.changeSummary}</p>
        </section>
      )}

      <section className="detail-section">
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
  const statusLabel = VERSION_STATUS_LABELS[detail.status ?? ""] ?? detail.status ?? "未知";
  return (
    <div className="form-body detail-dialog-body">
      <div className="detail-info-grid">
        <div className="detail-info-cell">
          <dt>状态</dt>
          <dd>{statusLabel}</dd>
        </div>
        <div className="detail-info-cell">
          <dt>发布阻塞</dt>
          <dd>{detail.blocked ? "是" : "否"}</dd>
        </div>
        <div className="detail-info-cell">
          <dt>就绪任务</dt>
          <dd>{detail.tasks.filter((task) => task.ready).length}/{detail.tasks.length}</dd>
        </div>
      </div>

      <section className="detail-section">
        <h4>任务清单</h4>
        {detail.tasks.length === 0 ? (
          <p className="detail-empty">暂无任务</p>
        ) : (
          <ul className="detail-task-list">
            {detail.tasks.map((task) => (
              <li key={task.id}>
                <span className="detail-task-name">{task.name}</span>
                <span className={task.ready ? "detail-ready" : "detail-task-status"}>
                  {task.ready ? "就绪" : TASK_STATUS_LABELS[task.status ?? ""] ?? task.status ?? "未知"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.manifest && (
        <section className="detail-section">
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
