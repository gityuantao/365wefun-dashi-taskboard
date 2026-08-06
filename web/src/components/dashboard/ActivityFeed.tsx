import type { ActivityItem } from "../../types";

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
                <time className="activity-time">
                  {new Date(item.time).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
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
