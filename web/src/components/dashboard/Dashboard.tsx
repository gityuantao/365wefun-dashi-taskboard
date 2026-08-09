import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { LinearIcon } from "../LinearIcon";
import {
  ApiError,
  getOrchestrationControl,
  getOrchestrationDashboard,
  getOrchestrationTaskDetail,
  getOrchestrationVersionDetail,
  setOrchestrationControl,
} from "../../api";
import type {
  ActivityItem,
  DashboardPayload,
  OrchestrationControl,
  ReleasableVersion,
  TaskDetail,
  VersionDetail,
  VersionProgress,
} from "../../types";
import { ActivityFeed } from "./ActivityFeed";
import { DashboardDialog } from "./DashboardDialog";
import { DetailDrawer } from "./DetailDrawer";
import { PipelineOverview } from "./PipelineOverview";
import { ReleaseActions } from "./ReleaseActions";
import { VersionProgressList } from "./VersionProgress";
import "./dashboard.css";

const REFRESH_INTERVAL_MS = 15_000;

type DialogState =
  | { kind: "task"; id: string; trigger: HTMLElement }
  | { kind: "version"; id: string; trigger: HTMLElement }
  | { kind: "release"; id: string; trigger: HTMLElement }
  | { kind: "control"; trigger: HTMLElement }
  | null;

export function Dashboard() {
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [detail, setDetail] = useState<TaskDetail | VersionDetail | null>(null);
  const [control, setControl] = useState<OrchestrationControl | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setRefreshing(true);
    try {
      const [next, controlValue] = await Promise.all([
        getOrchestrationDashboard(signal),
        getOrchestrationControl(signal),
      ]);
      if (generation !== loadGenerationRef.current) return;
      setPayload(next);
      setControl(controlValue);
      setError(null);
      setLastUpdated(Date.now());
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      if (generation !== loadGenerationRef.current) return;
      setError(caught instanceof ApiError ? caught.message : "无法加载驾驶舱数据");
    } finally {
      if (generation !== loadGenerationRef.current) return;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    const generation = ++detailGenerationRef.current;
    if (!dialog || dialog.kind === "control") {
      if (generation !== detailGenerationRef.current) return;
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    void (dialog.kind === "task"
      ? getOrchestrationTaskDetail(dialog.id, controller.signal)
      : getOrchestrationVersionDetail(dialog.id, controller.signal)
    )
      .then((next) => {
        if (generation !== detailGenerationRef.current) return;
        setDetail(next);
      })
      .catch((caught) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (generation !== detailGenerationRef.current) return;
        setDetail(null);
      });
    return () => controller.abort();
  }, [dialog]);

  async function toggleControl() {
    if (!control || controlPending) return;
    setControlPending(true);
    try {
      const next = await setOrchestrationControl(!control.enabled);
      setControl(next);
      setControlError(null);
    } catch (caught) {
      setControlError(caught instanceof ApiError ? caught.message : "无法更新编排总开关");
    } finally {
      setControlPending(false);
    }
  }

  function openActivity(item: ActivityItem, event: MouseEvent<HTMLButtonElement>) {
    setDialog({ kind: item.objectType, id: item.objectId, trigger: event.currentTarget });
  }

  function openVersion(version: VersionProgress, event: MouseEvent<HTMLButtonElement>) {
    setDialog({ kind: "version", id: version.id, trigger: event.currentTarget });
  }

  function openRelease(version: ReleasableVersion, event: MouseEvent<HTMLButtonElement>) {
    setDialog({ kind: "release", id: version.id, trigger: event.currentTarget });
  }

  function openControl(event: MouseEvent<HTMLButtonElement>) {
    setDialog({ kind: "control", trigger: event.currentTarget });
  }

  return (
    <div className="dashboard" aria-label="运营驾驶舱">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <span className="dashboard-title-mark" aria-hidden="true">
            <LinearIcon name="project" />
          </span>
          <strong>运营驾驶舱</strong>
          <span className="dashboard-title-time">
            {lastUpdated
              ? `最近更新 ${new Date(lastUpdated).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : "等待首次同步…"}
          </span>
        </div>

        <div className="dashboard-header-actions">
          <button
            type="button"
            className={`project-automation-trigger no-drag${control?.enabled ? " is-active" : " is-paused"}`}
            aria-label={control?.enabled ? "编排运行中" : "编排已暂停"}
            aria-haspopup="dialog"
            aria-expanded={dialog?.kind === "control"}
            title={control?.enabled ? "编排运行中" : "编排已暂停"}
            disabled={!control}
            onClick={openControl}
          >
            <LinearIcon name={control?.enabled ? "play" : "pause"} />
            <span>{control?.enabled ? "编排运行中" : "编排已暂停"}</span>
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={refreshing ? "更新中" : "刷新"}
            title={refreshing ? "更新中" : "刷新"}
            disabled={refreshing}
            onClick={() => void load()}
          >
            <LinearIcon name="recurrence" />
          </button>
        </div>
      </header>

      {error && (
        <div className="dashboard-error" role="alert">
          <strong>数据加载失败</strong>
          <span>{error}</span>
        </div>
      )}

      {!payload && !error && (
        <div className="dashboard-loading" aria-busy="true">正在加载驾驶舱…</div>
      )}

      {payload && (
        <>
          <ReleaseActions versions={payload.releasableVersions} onOpen={openRelease} />
          <PipelineOverview pipeline={payload.pipeline} />
          <VersionProgressList versions={payload.versions} onOpen={openVersion} />
          <ActivityFeed items={payload.activity} onOpen={openActivity} />
        </>
      )}

      {dialog && (
        <DashboardDialog
          title={dialog.kind === "task" ? "任务详情" : dialog.kind === "control" ? "编排总开关" : "版本详情"}
          labelledBy="dashboard-dialog-title"
          triggerRef={{ current: dialog.trigger }}
          busy={dialog.kind === "control" && controlPending}
          closeDisabled={dialog.kind === "control" && controlPending}
          onClose={() => setDialog(null)}
        >
          {dialog.kind === "control" ? (
            <div className="form-body dashboard-control-panel">
              <div className="project-automation-menu-heading">
                <strong>编排总开关</strong>
                <span className={control?.enabled ? "is-active" : "is-paused"}>
                  {control?.enabled ? "运行中" : "已暂停"}
                </span>
              </div>
              <div className="project-automation-switch">
                <span>编排处理</span>
                <button
                  type="button"
                  className={`board-setting-switch${control?.enabled ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={control?.enabled ?? false}
                  disabled={controlPending || !control}
                  onClick={() => void toggleControl()}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
              <p className="project-automation-note">
                关闭后停止轮询与处理，驾驶舱仍可查看最后一次数据。
              </p>
              {controlError && (
                <p className="project-automation-error" role="alert">{controlError}</p>
              )}
            </div>
          ) : (
            <DetailDrawer
              kind={dialog.kind === "task" ? "task" : "version"}
              detail={detail}
              onChanged={() => setDialog((current) => (
                current && current.kind !== "control" ? { ...current } : current
              ))}
            />
          )}
        </DashboardDialog>
      )}
    </div>
  );
}
