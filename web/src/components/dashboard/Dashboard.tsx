import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
  const [controlMenuOpen, setControlMenuOpen] = useState(false);
  const [controlMenuPosition, setControlMenuPosition] = useState({
    left: 0,
    top: 0,
    ready: false,
  });
  const controlTriggerRef = useRef<HTMLButtonElement>(null);
  const controlMenuRef = useRef<HTMLDivElement>(null);

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

  useLayoutEffect(() => {
    if (!controlMenuOpen || !controlTriggerRef.current || !controlMenuRef.current) return;
    const trigger = controlTriggerRef.current.getBoundingClientRect();
    const menu = controlMenuRef.current.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8),
    );
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setControlMenuPosition({ left, top, ready: true });
  }, [controlMenuOpen]);

  useEffect(() => {
    if (!controlMenuOpen) return;
    function closeFromOutside(event: PointerEvent) {
      if (
        !controlMenuRef.current?.contains(event.target as Node)
        && !controlTriggerRef.current?.contains(event.target as Node)
      ) {
        setControlMenuOpen(false);
      }
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setControlMenuOpen(false);
        controlTriggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [controlMenuOpen]);

  function toggleControlMenu() {
    if (!controlMenuOpen) {
      setControlMenuPosition({ left: 0, top: 0, ready: false });
    }
    setControlMenuOpen((open) => !open);
  }

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
            ref={controlTriggerRef}
            type="button"
            className={`project-automation-trigger no-drag${control?.enabled ? " is-active" : " is-paused"}`}
            aria-label={control?.enabled ? "编排运行中" : "编排已暂停"}
            aria-haspopup="dialog"
            aria-expanded={controlMenuOpen}
            title={control?.enabled ? "编排运行中" : "编排已暂停"}
            disabled={!control}
            onClick={toggleControlMenu}
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
          <ReleaseActions versions={payload.releasableVersions} />
          <PipelineOverview pipeline={payload.pipeline} />
          <VersionProgressList versions={payload.versions} onOpen={openVersion} />
          <ActivityFeed items={payload.activity} onOpen={openActivity} />
        </>
      )}

      {drawer && (
        <DetailDrawer
          kind={drawer.kind}
          detail={detail}
          onClose={() => setDrawer(null)}
        />
      )}

      {controlMenuOpen && createPortal(
        <div
          ref={controlMenuRef}
          className="project-automation-menu dashboard-control-menu"
          role="dialog"
          aria-label="编排总开关"
          style={{
            left: controlMenuPosition.left,
            top: controlMenuPosition.top,
            visibility: controlMenuPosition.ready ? "visible" : "hidden",
          }}
        >
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
        </div>,
        document.body,
      )}
    </div>
  );
}
