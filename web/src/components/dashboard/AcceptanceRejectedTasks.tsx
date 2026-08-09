import type { MouseEvent } from "react";
import type { AcceptanceRejectedTask } from "../../types";

export function AcceptanceRejectedTasks({
  tasks,
  onOpen,
}: {
  tasks: AcceptanceRejectedTask[];
  onOpen: (
    task: AcceptanceRejectedTask,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  if (tasks.length === 0) return null;

  return (
    <section
      className="dashboard-section acceptance-rejected-tasks"
      aria-labelledby="acceptance-rejected-heading"
    >
      <div className="dashboard-section-heading">
        <h2 id="acceptance-rejected-heading">验收不通过</h2>
        <span className="dashboard-section-count">{tasks.length}</span>
      </div>
      <ul className="acceptance-rejected-list">
        {tasks.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              className="acceptance-rejected-row"
              onClick={(event) => onOpen(task, event)}
            >
              <span className="acceptance-rejected-copy">
                <strong>{task.name}</strong>
                <span>{task.id}</span>
              </span>
              {task.targetVersion && (
                <span className="badge badge-status acceptance-rejected-version">
                  {task.targetVersion}
                </span>
              )}
              <span className="badge acceptance-rejected-status">验收不通过</span>
              <span className="acceptance-rejected-chevron" aria-hidden="true">›</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
