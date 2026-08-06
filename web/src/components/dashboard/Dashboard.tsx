import { useCallback, useEffect, useState } from "react";
import { LinearIcon } from "../LinearIcon";
import {
  ApiError,
  getOrchestrationControl,
  getOrchestrationDashboard,
  setOrchestrationControl,
  getOrchestrationTaskDetail,
  getOrchestrationVersionDetail,
} from "../../api";
import type {
  ActivityItem,
  DashboardPayload,
  OrchestrationControl,
  TaskDetail,
  VersionDetail,
  VersionProgress,
} from "../../types";
import { ActivityFeed } from "./ActivityFeed";
import { DetailDrawer } from "./DetailDrawer";
import { PipelineOverview } from "./PipelineOverview";
import { ReleaseActions } from "./ReleaseActions";
import { VersionProgressList } from "./VersionProgress";
import "./dashboard.css";

const REFRESH_INTERVAL_MS = 15_000;

type DrawerState =
  | { kind: "task"; id: string }
  | { kind: "version"; id: string }
  | null;

export function Dashboard() {
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [detail, setDetail] = useState<TaskDetail | VersionDetail | null>(null);
  const [control, setControl] = useState<OrchestrationControl | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const [next, controlValue] = await Promise.all([
        getOrchestrationDashboard(signal),
        getOrchestrationControl(signal),
      ]);
      setPayload(next);
      setControl(controlValue);
      setError(null);
      setLastUpdated(Date.now());
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof ApiError ? caught.message : "无法加载驾驶舱数据");
    } finally {
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
    if (!drawer) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    void (drawer.kind === "task"
      ? getOrchestrationTaskDetail(drawer.id, controller.signal)
      : getOrchestrationVersionDetail(drawer.id, controller.signal)
    )
      .then(setDetail)
      .catch((caught) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setDetail(null);
      });
    return () => controller.abort();
  }, [drawer]);

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

  function openActivity(item: ActivityItem) {
    setDrawer({ kind: item.objectType, id: item.objectId });
  }

  function openVersion(version: VersionProgress) {
    setDrawer({ kind: "version", id: version.id });
  }

  return (
    <div className="dashboard" aria-label="运营驾驶舱">
      <header className="dashboard-header">
        <div>
          <h1>运营驾驶舱</h1>
          <p className="dashboard-subtitle">
            {lastUpdated
              ? `最近更新 ${new Date(lastUpdated).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : "等待首次同步…"}
          </p>
        </div>
        <div className="dashboard-control">
          <span className={`dashboard-control-dot${control?.enabled ? " is-active" : " is-paused"}`} />
          <span>{control?.enabled ? "运行中" : "已暂停"}</span>
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
          <span className="dashboard-control-label">编排总开关</span>
        </div>
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
      </header>

      {controlError && (
        <div className="dashboard-control-error" role="alert">{controlError}</div>
      )}

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
          <ReleaseActions versions={payload.releasableVersions} />
          <PipelineOverview pipeline={payload.pipeline} />
          <VersionProgressList versions={payload.versions} onOpen={openVersion} />
          <ActivityFeed items={payload.activity} onOpen={openActivity} />
        </>
      )}

      {drawer && (
        <>
          <div
            className="detail-drawer-overlay"
            aria-hidden="true"
            onClick={() => setDrawer(null)}
          />
          <DetailDrawer
            kind={drawer.kind}
            detail={detail}
            onClose={() => setDrawer(null)}
          />
        </>
      )}
    </div>
  );
}
