import { describe, expect, it } from "vitest";
import type { WorkspaceDocument } from "../contract/types";
import {
  attachRemote,
  detachRemote,
  emptyCatalog,
  hostedProjects,
  hostOwnsProject,
  LOCAL_HOST_ID,
  replaceWorkspace,
  serializeLocalWorkspace,
} from "./session";

function workspace(folderPath: string): WorkspaceDocument {
  return {
    schemaVersion: 7,
    projects: [{ id: `project-${folderPath}`, folderPath, threads: [] }],
    providerProfiles: [],
    agents: [],
    voice: {
      isEnabled: false,
      useGrokSignIn: false,
      language: "en",
      apiBase: "https://api.x.ai",
    },
  };
}

describe("host session catalog", () => {
  it("shows local and remote snapshots together and detach leaves local bytes unchanged", () => {
    const local = workspace("/Users/scott/macbook");
    let catalog = emptyCatalog(local, "This Mac");
    const before = serializeLocalWorkspace(catalog);
    catalog = attachRemote(
      catalog,
      { id: "mini", name: "Scott’s Mac mini", kind: "remote", address: "100.64.0.2:7422" },
      workspace("/Users/scott/mini"),
    );
    const visible = hostedProjects(catalog);
    expect(visible.map((item) => [item.hostId, item.project.folderPath])).toEqual([
      [LOCAL_HOST_ID, "/Users/scott/macbook"],
      ["mini", "/Users/scott/mini"],
    ]);
    catalog = detachRemote(catalog, "mini");
    expect(serializeLocalWorkspace(catalog)).toBe(before);
    expect(catalog.local).toEqual(local);
    expect(hostedProjects(catalog)).toHaveLength(1);
  });

  it("applies a mutation only to the addressed host", () => {
    let catalog = emptyCatalog(workspace("/tmp/local"), "This Mac");
    catalog = attachRemote(
      catalog,
      { id: "mini", name: "Mini", kind: "remote", address: "127.0.0.1:7422" },
      workspace("/tmp/mini"),
    );
    const localBefore = serializeLocalWorkspace(catalog);
    const remote = structuredClone(catalog.remotes[0].workspace);
    remote.projects.push({ id: "added", folderPath: "/tmp/mini/other", threads: [] });
    catalog = replaceWorkspace(catalog, "mini", remote);
    expect(serializeLocalWorkspace(catalog)).toBe(localBefore);
    expect(hostOwnsProject(catalog, "mini", "added")).toBe(true);
    expect(hostOwnsProject(catalog, LOCAL_HOST_ID, "added")).toBe(false);
  });
});
