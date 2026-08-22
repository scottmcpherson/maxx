import headless from "@xterm/headless";
import { performance } from "node:perf_hooks";

const { Terminal } = headless;

const ROWS = 32;
const SCROLLBACK = 25_000;
const LINE = "\x1b[38;2;117;167;232magent output with ANSI styling\x1b[0m\r\n";

function write(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function benchmark(lines) {
  global.gc?.();
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: 120,
    rows: ROWS,
    scrollback: SCROLLBACK,
  });
  const batchLines = 1_000;
  const batch = new TextEncoder().encode(LINE.repeat(batchLines));
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  for (let written = 0; written < lines; written += batchLines) {
    await write(terminal, batch);
  }
  await write(terminal, new TextEncoder().encode("BENCHMARK_COMPLETE"));
  global.gc?.();
  const elapsedMs = performance.now() - started;
  const memory = process.memoryUsage();
  const result = {
    lines,
    inputMiB: Number(((LINE.length * lines) / 1_048_576).toFixed(2)),
    elapsedMs: Number(elapsedMs.toFixed(1)),
    linesPerSecond: Math.round(lines / (elapsedMs / 1_000)),
    heapDeltaMiB: Number(((memory.heapUsed - heapBefore) / 1_048_576).toFixed(1)),
    rssDeltaMiB: Number(((memory.rss - rssBefore) / 1_048_576).toFixed(1)),
    retainedRows: terminal.buffer.active.length,
  };
  terminal.dispose();
  return result;
}

for (const lines of [10_000, 100_000]) {
  console.log(JSON.stringify(await benchmark(lines)));
}
