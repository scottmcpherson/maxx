import type { RuntimeEvent, RuntimeEventEnvelope, WorkspaceDocument } from "../types";

function ordered(events: RuntimeEvent[]) {
  return [...events].sort((a, b) =>
    a.occurredAt - b.occurredAt
    || (a.sequence ?? 0) - (b.sequence ?? 0)
    || a.id.localeCompare(b.id));
}

export function applyRuntimeEvent(
  workspace: WorkspaceDocument | null,
  envelope: RuntimeEventEnvelope,
): WorkspaceDocument | null {
  if (!workspace) return workspace;
  let changed = false;
  const projects = workspace.projects.map((project) => {
    if (project.id !== envelope.projectID) return project;
    const threads = project.threads.map((thread) => {
      if (thread.id !== envelope.threadID) return thread;
      if (thread.runtimeEvents.some((event) => event.id === envelope.event.id)) return thread;
      changed = true;
      return {
        ...thread,
        runtimeEvents: ordered([...thread.runtimeEvents, envelope.event]),
        updatedAt: Math.max(thread.updatedAt, envelope.event.occurredAt),
      };
    });
    return changed ? { ...project, threads } : project;
  });
  return changed ? { ...workspace, projects } : workspace;
}

/** Preserve events that arrived while an in-flight workspace snapshot was being encoded. */
export function mergeLiveRuntimeEvents(
  snapshot: WorkspaceDocument,
  current: WorkspaceDocument | null,
): WorkspaceDocument {
  if (!current) return snapshot;
  let merged = snapshot;
  for (const project of current.projects) {
    for (const thread of project.threads) {
      for (const event of thread.runtimeEvents) {
        merged = applyRuntimeEvent(merged, {
          projectID: project.id,
          threadID: thread.id,
          event,
        }) ?? merged;
      }
    }
  }
  return merged;
}
