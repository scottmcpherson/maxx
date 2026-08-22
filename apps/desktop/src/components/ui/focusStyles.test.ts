import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiDirectory = fileURLToPath(new URL("./", import.meta.url));
const stylesPath = fileURLToPath(new URL("../../styles.css", import.meta.url));

describe("shared focus styles", () => {
  it("does not add focus rings to shadcn primitives", () => {
    const source = readdirSync(uiDirectory)
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => readFileSync(`${uiDirectory}/${file}`, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/focus-(?:visible|within):ring-(?!0\b)/);
    expect(source).not.toMatch(/focus-(?:visible|within):border-ring/);
    expect(source).not.toMatch(/focus-visible:outline-(?!none\b)/);
    expect(source).not.toMatch(/data-\[active=true\]:(?:border-ring|ring-(?!0\b))/);
  });

  it("does not expose a focus-ring theme token or runtime-picker override", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).not.toMatch(/--(?:color-)?(?:sidebar-)?ring\s*:/);
    expect(styles).not.toContain(".runtime-popover button:focus-visible");
    expect(styles).not.toContain(".runtime-popover input:focus-visible");
  });
});
