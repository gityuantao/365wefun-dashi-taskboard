import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, getOrchestrationVersionDetail, publishOrchestrationVersion } from "../../api";
import type { TaskDetail, VersionDetail } from "../../types";

interface DetailDrawerProps {
  kind: "task" | "version";
  detail: TaskDetail | VersionDetail | null;
  onChanged?: () => void;
}

const TASK_STATUS_LABELS: Record<string, string> = {
  inbox: "收件箱",
  analyzing: "分析中",
  waiting_info: "待补充信息",
  ready_for_development: "待开发",
  developing: "开发中",
  acceptance_rejected: "验收不通过",
  ready_for_test: "待测试",
  testing: "测试中",
  ready_for_release: "待发布",
  published: "已发布",
  canceled: "已取消",
};

const VERSION_STATUS_LABELS: Record<string, string> = {
  planning: "规划中",
  active: "进行中",
  releasing: "发布中",
  release_failed: "发布失败",
  published: "已发布",
  canceled: "已取消",
};

export function DetailDrawer({ kind, detail, onChanged }: DetailDrawerProps) {
  return (
    <>
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
        <VersionDetailBody detail={detail as VersionDetail} onChanged={onChanged} />
      )}
    </>
  );
}

function TaskHero({ detail }: { detail: TaskDetail }) {
  const statusLabel = TASK_STATUS_LABELS[detail.status ?? ""] ?? detail.status ?? "未知";
  return (
    <header className="detail-dialog-hero">
      <div className="detail-dialog-title">
        <h3>{detail.name}</h3>
        <DetailLinks kind="task" detail={detail} />
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
        <DetailLinks kind="version" detail={detail} />
      </div>
      <span className={`badge badge-status badge-status-${detail.status ?? "unknown"}`}>
        {statusLabel}
      </span>
    </header>
  );
}

function DetailLinks({
  kind,
  detail,
}: {
  kind: "task" | "version";
  detail: TaskDetail | VersionDetail;
}) {
  return (
    <span className="detail-dialog-links">
      <a
        className="detail-external-link"
        href={`https://app.clickup.com/t/${detail.id}`}
        target="_blank"
        rel="noreferrer"
        title="在 ClickUp 打开"
      >
        {detail.id}
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
    </span>
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

function VersionDetailBody({
  detail,
  onChanged,
}: {
  detail: VersionDetail;
  onChanged?: () => void;
}) {
  const statusLabel = VERSION_STATUS_LABELS[detail.status ?? ""] ?? detail.status ?? "未知";
  const [publishState, setPublishState] = useState<"idle" | "submitting" | "submitted">("idle");
  const [publishError, setPublishError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmationVersion, setConfirmationVersion] = useState("");
  const releaseRequestIdRef = useRef(crypto.randomUUID());
  const confirmDialogRef = useRef<HTMLElement>(null);
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
  const transitionedRef = useRef(false);
  const readyCount = detail.tasks.filter((task) => task.ready).length;
  const totalCount = detail.tasks.length;
  const percent = totalCount === 0 ? 0 : Math.round((readyCount / totalCount) * 100);

  useEffect(() => {
    if (!confirming) return;
    const focusable = () => [...(confirmDialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? [])];
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && publishState !== "submitting") {
        event.preventDefault();
        setConfirming(false);
        window.setTimeout(() => confirmTriggerRef.current?.focus(), 0);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const containFocus = (event: FocusEvent) => {
      if (!confirmDialogRef.current?.contains(event.target as Node)) focusable()[0]?.focus();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", containFocus, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", containFocus, true);
    };
  }, [confirming, publishState]);

  function closeConfirmation() {
    setConfirming(false);
    window.setTimeout(() => confirmTriggerRef.current?.focus(), 0);
  }

  // 提交发布后轮询版本状态，直到编排器/ClickUp 同步为「发布中/已发布/发布失败」
  useEffect(() => {
    if (publishState !== "submitted" || !detail.releasable) return;
    transitionedRef.current = false;
    const timer = window.setInterval(() => {
      if (transitionedRef.current) return;
      void getOrchestrationVersionDetail(detail.id)
        .then((next) => {
          if (next.status !== "active" && next.status !== null) {
            transitionedRef.current = true;
            onChanged?.();
          }
        })
        .catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
  }, [publishState, detail.releasable, detail.id, onChanged]);

  async function publish() {
    setPublishState("submitting");
    setPublishError(null);
    try {
      await publishOrchestrationVersion(detail.id, confirmationVersion, releaseRequestIdRef.current);
      setPublishState("submitted");
      onChanged?.();
    } catch (caught) {
      setPublishError(caught instanceof ApiError ? caught.message : "发布请求失败");
      setPublishState("idle");
    }
  }
  const submitting = publishState === "submitting";
  const submitted = publishState === "submitted";
  const exactConfirmation = confirmationVersion === detail.name;
  const retrying = detail.status === "release_failed";
  return (
    <div className="form-body detail-dialog-body">
      {detail.releaseReadiness.ready && (
        <div className={`detail-publish-band${submitted ? " is-submitted" : ""}`}>
          <div className="detail-publish-copy">
            <strong>{submitted ? "发布已提交" : "此版本可以发布"}</strong>
            <span>
              {submitted
                ? "正在同步 ClickUp，版本状态即将变为「发布中」并自动开始发布…"
                : "点击发布后版本状态将变为「发布中」，随后自动开始发布流程"}
            </span>
          </div>
          <button
            className={`button primary detail-publish-button${submitted ? " is-submitted" : ""}`}
            type="button"
            ref={confirmTriggerRef}
            disabled={submitting || submitted}
            onClick={() => setConfirming(true)}
          >
            {submitting ? "发布中…" : submitted ? "已提交" : retrying ? "重试失败目标" : "发布版本"}
          </button>
        </div>
      )}
      {publishError && <p className="detail-publish-error" role="alert">{publishError}</p>}

      {confirming && !submitted && createPortal(
        <div className="release-confirm-backdrop" role="presentation">
          <section ref={confirmDialogRef} tabIndex={-1} className="release-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="release-confirm-title">
            <header>
              <div>
                <span className="release-confirm-eyebrow">PRODUCTION RELEASE</span>
                <h4 id="release-confirm-title">确认正式发布</h4>
              </div>
              <button className="button icon-button" type="button" aria-label="取消发布" disabled={submitting} onClick={closeConfirmation}>×</button>
            </header>
            <p className="release-confirm-warning">
              将部署 Web/API 生产环境，并把全部启用的 iOS App 提交 App Store 审核；审核通过后自动上架。
            </p>
            <div className="release-confirm-targets">
              <strong>生产目标</strong>
              <span>Candidate：{detail.manifest?.candidateCommit ?? "将在确认后冻结"} · 任务 {detail.tasks.length} 个</span>
              {detail.releaseTargets.length > 0 ? (
                <ul>{detail.releaseTargets.map((target) => {
                  return <li key={`${target.platform}:${target.appId ?? ""}`}>
                    {target.label}{target.appStoreAppId ? ` · App ${target.appStoreAppId} · ${target.scheme} · ${target.bundleId} · ${target.marketingVersion}` : ""}
                  </li>;
                })}</ul>
              ) : <span>目标将在冻结 Manifest 后按任务平台和 iOS 注册表确定</span>}
            </div>
            <label className="release-confirm-field">
              <span>输入版本号 <strong>{detail.name}</strong> 以确认</span>
              <input autoFocus value={confirmationVersion} onChange={(event) => setConfirmationVersion(event.target.value)} placeholder={detail.name} />
            </label>
            <footer>
              <button className="button secondary" type="button" disabled={submitting} onClick={closeConfirmation}>取消</button>
              <button className="button primary" type="button" disabled={!exactConfirmation || submitting} onClick={() => void publish()}>
                {submitting ? "正在提交…" : retrying ? "确认重试失败目标" : "确认发布到生产环境"}
              </button>
            </footer>
          </section>
        </div>, document.body,
      )}

      <div className="detail-info-grid">
        <div className="detail-info-cell">
          <dt>状态</dt>
          <dd className={`detail-status-text detail-status-${detail.status ?? "unknown"}`}>
            {statusLabel}
          </dd>
        </div>
        <div className="detail-info-cell">
          <dt>发布阻塞</dt>
          <dd className={detail.blocked ? "detail-blocked-yes" : "detail-blocked-no"}>
            {detail.blocked ? "是" : "否"}
          </dd>
        </div>
        <div className="detail-info-cell detail-progress-cell">
          <dt>就绪任务</dt>
          <dd>{readyCount}/{totalCount}</dd>
          <span className="detail-progress-track" aria-hidden="true">
            <span
              className={`detail-progress-fill${percent >= 100 ? " is-complete" : ""}`}
              style={{ width: `${percent}%` }}
            />
          </span>
        </div>
      </div>

      <section className="detail-section">
        <h4>发布进度 <span className="detail-section-count">{detail.releaseTargets.length}</span></h4>
        {detail.releaseTargets.length === 0 ? <p className="detail-empty">尚未创建生产发布目标</p> : (
          <ul className="release-target-list">
            {detail.releaseTargets.map((target) => (
              <li key={`${target.platform}:${target.appId ?? ""}`}>
                <span><strong>{target.label}</strong><small>{target.platform.toUpperCase()}{target.buildNumber ? ` · Build ${target.buildNumber}` : ""}</small></span>
                <span className={`badge badge-release-target-${target.status}`}>{target.stage} · {target.status}</span>
                <small className="release-target-readback">
                  {target.updatedAt ? `${target.readbackStatus || target.stage === "readback" || target.stage === "live_readback" ? "最近权威回读" : "阶段更新"} ${new Date(target.updatedAt).toLocaleString("zh-CN")}` : "尚无权威回读"}
                  {target.reconciliationStatus ? ` · ${target.reconciliationStatus}` : ""}
                  {target.readbackStatus ? ` · ${target.readbackStatus}` : ""}
                </small>
                {target.error && <p>{target.error}</p>}
              </li>
            ))}
          </ul>
        )}
        {detail.releaseReadiness.gaps.length > 0 && <ul className="release-readiness-gaps">{detail.releaseReadiness.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
      </section>

      <section className="detail-section">
        <h4>任务清单 <span className="detail-section-count">{totalCount}</span></h4>
        {totalCount === 0 ? (
          <p className="detail-empty">暂无任务</p>
        ) : (
          <ul className="detail-task-list">
            {detail.tasks.map((task) => (
              <li key={task.id}>
                <span
                  className={`detail-task-dot${task.ready ? " is-ready" : ""}`}
                  aria-hidden="true"
                />
                <span className="detail-task-name">{task.name}</span>
                <span className={task.ready ? "badge badge-releasable detail-task-badge" : "badge badge-status detail-task-badge"}>
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
          <pre className="detail-manifest">
            <code>
              {`checksum:   ${detail.manifest.checksum}
createdAt:  ${detail.manifest.createdAt}`}
            </code>
          </pre>
        </section>
      )}
    </div>
  );
}
