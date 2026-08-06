import type { ActivityItem } from "../../types";

function formatActivityTime(value: string): string {
  const time = new Date(value).getTime();
  const delta = Date.now() - time;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function ActivityFeed({
  items,
  onOpen,
}: {
  items: ActivityItem[];
  onOpen: (item: ActivityItem) => void;
}) {
  return (
    <section className="dashboard-section activity-feed" aria-labelledby="activity-title">
      <div className="dashboard-section-heading">
        <h2 id="activity-title">实时活动</h2>
        <span className="dashboard-section-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="activity-empty">暂无活动</p>
      ) : (
        <ol className="activity-list">
          {items.map((item, index) => (
            <li key={`${item.objectId}-${item.time}-${index}`}>
              <button className="activity-item" type="button" onClick={() => onOpen(item)}>
                <time className="activity-time" title={item.time}>
                  {formatActivityTime(item.time)}
                </time>
                <span className={`activity-object activity-${item.objectType}`}>
                  {item.objectType === "version" ? "版本" : "任务"}
                </span>
                <span className="activity-summary">{item.summary}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
