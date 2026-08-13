import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { decodeBase64Chunks, writeTerminalBatch } from "./terminalStream";

describe("terminal output streaming", () => {
  it("combines transport chunks and waits for xterm's write callback", async () => {
    expect(new TextDecoder().decode(decodeBase64Chunks([btoa("one"), btoa("two")]))).toBe("onetwo");
    let callback: (() => void) | undefined;
    let settled = false;
    const pending = writeTerminalBatch({
      write: (_data, next) => { callback = next; },
    }, new TextEncoder().encode("output")).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    callback?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("parses 100,000 ANSI lines while keeping scrollback bounded", async () => {
    const rows = 32;
    const scrollback = 25_000;
    const terminal = new Terminal({ allowProposedApi: true, cols: 120, rows, scrollback });
    const line = "\x1b[38;2;117;167;232magent output with ANSI styling\x1b[0m\r\n";
    const batch = new TextEncoder().encode(line.repeat(1_000));
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      await writeTerminalBatch(terminal, batch);
    }
    await writeTerminalBatch(terminal, new TextEncoder().encode("BENCHMARK_COMPLETE"));
    const elapsedMs = performance.now() - started;
    const heapGrowthMiB = (process.memoryUsage().heapUsed - heapBefore) / 1_048_576;
    const buffer = terminal.buffer.active;
    expect(buffer.length).toBeLessThanOrEqual(scrollback + rows);
    expect(buffer.getLine(buffer.length - 1)?.translateToString(true)).toContain("BENCHMARK_COMPLETE");
    expect(elapsedMs).toBeLessThan(30_000);
    expect(heapGrowthMiB).toBeLessThan(256);
    console.info(`terminal benchmark: 100,000 lines in ${elapsedMs.toFixed(0)}ms; heap delta ${heapGrowthMiB.toFixed(1)} MiB`);
    terminal.dispose();
  }, 35_000);
});
