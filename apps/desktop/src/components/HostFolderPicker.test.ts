import { describe, expect, it } from "vitest";
import { folderBreadcrumbs, folderPickerError } from "./HostFolderPicker";

describe("folderBreadcrumbs", () => {
  it("uses Home as the root while browsing inside the home folder", () => {
    expect(folderBreadcrumbs("/Users/scott/Developer/maxx", "/Users/scott")).toEqual([
      { label: "Home", path: "/Users/scott" },
      { label: "Developer", path: "/Users/scott/Developer" },
      { label: "maxx", path: "/Users/scott/Developer/maxx" },
    ]);
  });

  it("shows the filesystem root when browsing above the home folder", () => {
    expect(folderBreadcrumbs("/Users", "/Users/scott")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
    ]);
  });
});

describe("folderPickerError", () => {
  it("turns a remote disconnect into an actionable message", () => {
    expect(folderPickerError("The remote Maxx disconnected", "Mac mini"))
      .toBe("Mac mini is disconnected. Reconnect it, then try again.");
  });

  it("preserves useful folder errors without an Error prefix", () => {
    expect(folderPickerError(new Error("Could not read /private"), "Mac mini"))
      .toBe("Could not read /private");
  });
});
