/**
 * Full project unregister: stop sessions/ports, wipe chat runtime, drop registry entry.
 * Does not delete the app tree on disk (same contract as homebase_project_delete).
 */
import { deleteProject, loadProjects } from "./config";
import { purgeProjectWorkspace } from "./cursor";
import { stopProject } from "./process";
import { killByProject } from "./pty";

export type RemoveProjectResult = {
  ok: boolean;
  id: string;
  killedSessions: string[];
  chatsDeleted: number;
  agentsUnmapped: number;
  error?: string;
};

/** Seeded control-plane project — keep it registered. */
export const PROTECTED_PROJECT_ID = "homebase";

export function removeRegisteredProject(projectId: string): RemoveProjectResult {
  const id = String(projectId || "").trim();
  if (!id) {
    return {
      ok: false,
      id,
      killedSessions: [],
      chatsDeleted: 0,
      agentsUnmapped: 0,
      error: "project id required",
    };
  }
  if (id === PROTECTED_PROJECT_ID) {
    return {
      ok: false,
      id,
      killedSessions: [],
      chatsDeleted: 0,
      agentsUnmapped: 0,
      error: "cannot remove the Home Base project",
    };
  }

  const project = loadProjects().get(id);
  if (!project) {
    return {
      ok: false,
      id,
      killedSessions: [],
      chatsDeleted: 0,
      agentsUnmapped: 0,
      error: "project not found",
    };
  }

  // Stop managed run/expo/ship + pidfile + ports, then any leftover shells.
  const killed = stopProject(project);
  for (const sid of killByProject(id)) {
    if (!killed.includes(sid)) killed.push(sid);
  }

  const { chatsDeleted, agentsUnmapped } = purgeProjectWorkspace(id);

  if (!deleteProject(id)) {
    return {
      ok: false,
      id,
      killedSessions: killed,
      chatsDeleted,
      agentsUnmapped,
      error: "project not found",
    };
  }

  return {
    ok: true,
    id,
    killedSessions: killed,
    chatsDeleted,
    agentsUnmapped,
  };
}
