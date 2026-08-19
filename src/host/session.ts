import type { ChatProject, ChatThread, WorkspaceDocument } from "../contract/types";

export const LOCAL_HOST_ID = "local";

export type HostKind = "local" | "remote";

export interface HostInfo {
  id: string;
  name: string;
  kind: HostKind;
  address?: string;
}

export interface RemoteSession {
  host: HostInfo;
  workspace: WorkspaceDocument;
}

export interface HostCatalog {
  localHost: HostInfo;
  local: WorkspaceDocument;
  remotes: RemoteSession[];
}

export interface HostedProject {
  hostId: string;
  hostName: string;
  project: ChatProject;
}

export function localHostInfo(name = "This computer"): HostInfo {
  return { id: LOCAL_HOST_ID, name, kind: "local" };
}

export function emptyCatalog(local: WorkspaceDocument, name = "This computer"): HostCatalog {
  return { localHost: localHostInfo(name), local, remotes: [] };
}

export function attachRemote(
  catalog: HostCatalog,
  host: HostInfo,
  workspace: WorkspaceDocument,
): HostCatalog {
  if (host.kind !== "remote" || host.id === LOCAL_HOST_ID) return catalog;
  const next: RemoteSession = { host, workspace };
  return {
    ...catalog,
    remotes: [...catalog.remotes.filter((session) => session.host.id !== host.id), next],
  };
}

export function detachRemote(catalog: HostCatalog, hostId: string): HostCatalog {
  if (hostId === LOCAL_HOST_ID || hostId === catalog.localHost.id) return catalog;
  return {
    ...catalog,
    remotes: catalog.remotes.filter((session) => session.host.id !== hostId),
  };
}

export function workspaceOf(catalog: HostCatalog, hostId: string): WorkspaceDocument | null {
  if (hostId === LOCAL_HOST_ID || hostId === catalog.localHost.id) return catalog.local;
  return catalog.remotes.find((session) => session.host.id === hostId)?.workspace ?? null;
}

export function replaceWorkspace(
  catalog: HostCatalog,
  hostId: string,
  workspace: WorkspaceDocument,
): HostCatalog {
  if (hostId === LOCAL_HOST_ID || hostId === catalog.localHost.id) {
    return { ...catalog, local: workspace };
  }
  return {
    ...catalog,
    remotes: catalog.remotes.map((session) =>
      session.host.id === hostId ? { ...session, workspace } : session,
    ),
  };
}

export function hostedProjects(catalog: HostCatalog): HostedProject[] {
  const projects = [
    ...catalog.local.projects.map((project) => ({
      hostId: catalog.localHost.id,
      hostName: catalog.localHost.name,
      project,
    })),
    ...catalog.remotes.flatMap((session) =>
      session.workspace.projects.map((project) => ({
        hostId: session.host.id,
        hostName: session.host.name,
        project,
      })),
    ),
  ];
  const uniqueByHostAndPath = new Map<string, HostedProject>();
  for (const item of projects) {
    const key = `${item.hostId}\0${item.project.folderPath}`;
    const existing = uniqueByHostAndPath.get(key);
    if (!existing || item.project.threads.length > existing.project.threads.length) {
      uniqueByHostAndPath.set(key, item);
    }
  }
  return [...uniqueByHostAndPath.values()];
}

export function mergedWorkspace(catalog: HostCatalog): WorkspaceDocument {
  return {
    ...catalog.local,
    projects: hostedProjects(catalog).map((item) => item.project),
  };
}

export function hostOwnsProject(catalog: HostCatalog, hostId: string, projectId: string): boolean {
  return workspaceOf(catalog, hostId)?.projects.some((project) => project.id === projectId) ?? false;
}

export function findHostedProject(
  catalog: HostCatalog,
  hostId: string,
  projectId: string,
): ChatProject | undefined {
  return workspaceOf(catalog, hostId)?.projects.find((project) => project.id === projectId);
}

export function findHostedThread(
  catalog: HostCatalog,
  hostId: string,
  projectId: string,
  threadId: string,
): ChatThread | undefined {
  return findHostedProject(catalog, hostId, projectId)?.threads.find((thread) => thread.id === threadId);
}

export function routeHostId(selectedHostId: string | null | undefined): string {
  return selectedHostId && selectedHostId.length > 0 ? selectedHostId : LOCAL_HOST_ID;
}

export function isLocalHost(hostId: string | null | undefined): boolean {
  return !hostId || hostId === LOCAL_HOST_ID;
}

export function serializeLocalWorkspace(catalog: HostCatalog): string {
  return JSON.stringify(catalog.local);
}
