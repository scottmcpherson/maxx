import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export function encodeTerminalInput(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
  }
  return btoa(binary);
}

export function terminalArchive(terminal: Terminal | null): string {
  if (!terminal) return "";
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n").trim().slice(0, 512 * 1_024);
}

export function createTerminalEmulator(container: HTMLElement): { terminal: Terminal; fit: FitAddon } {
  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.22,
    scrollback: 25_000,
    theme: {
      background: "#171717",
      foreground: "#e7e7e7",
      cursor: "#e7e7e7",
      selectionBackground: "#7657ee66",
      black: "#191919",
      brightBlack: "#777777",
      red: "#e47370",
      brightRed: "#ff8a86",
      green: "#6fc58b",
      brightGreen: "#8ddd9f",
      yellow: "#d7ae5c",
      brightYellow: "#edc76e",
      blue: "#75a7e8",
      brightBlue: "#91bdf3",
      magenta: "#a98af7",
      brightMagenta: "#bea5ff",
      cyan: "#6fc8c8",
      brightCyan: "#8bdddd",
      white: "#d7d7d7",
      brightWhite: "#ffffff",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    terminal.loadAddon(webgl);
  } catch {
    // Electron can deny WebGL after GPU resets; xterm's DOM renderer remains active.
  }
  return { terminal, fit };
}
