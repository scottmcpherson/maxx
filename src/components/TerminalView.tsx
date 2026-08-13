import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { ChatProject, ChatThread, TerminalStatus } from "../contract/types";
import { ipc } from "../ipc";
import { decodeBase64Chunks, writeTerminalBatch } from "../terminalStream";
import { Icons } from "./Icons";

export interface TerminalViewHandle {
  archiveText: () => string;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
  }
  return btoa(binary);
}

function terminalArchive(terminal: Terminal | null): string {
  if (!terminal) return "";
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n").trim().slice(0, 512 * 1_024);
}

export const TerminalView = forwardRef<TerminalViewHandle, {
  project: ChatProject;
  thread: ChatThread;
  hostID?: string;
  initialTurnRunning: boolean;
  onReturnToGUI: () => void;
}>(function TerminalView({ project, thread, hostID, initialTurnRunning, onReturnToGUI }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cursorRef = useRef(0);
  const inputQueueRef = useRef(Promise.resolve());
  const startingRef = useRef(false);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    archiveText: () => terminalArchive(terminalRef.current),
  }), []);

  const openTerminal = useCallback(async (restart = false) => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit || !thread.providerSessionID || initialTurnRunning || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      fit.fit();
      const existing = restart ? null : await ipc.terminalStatus(thread.id, hostID);
      const next = existing?.state === "running" ? existing : await ipc.terminalStart(
        project.id,
        thread.id,
        Math.max(2, terminal.rows),
        Math.max(2, terminal.cols),
        hostID,
      );
      cursorRef.current = 0;
      if (restart) {
        terminal.write("\r\n\x1b[2m──────── Terminal restarted ────────\x1b[0m\r\n");
      }
      setStatus(next);
      terminal.focus();
    } catch (cause) {
      setError(String(cause));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [hostID, initialTurnRunning, project.id, thread.id, thread.providerSessionID]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.22,
      // 25k wrapped rows covers long agent runs while keeping each terminal's
      // renderer memory bounded; the PTY replay buffer is bounded separately.
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
    terminalRef.current = terminal;
    fitRef.current = fit;
    const frame = requestAnimationFrame(() => fit.fit());
    const input = terminal.onData((data) => {
      const encoded = encodeBase64(data);
      inputQueueRef.current = inputQueueRef.current
        .then(() => ipc.terminalInput(thread.id, encoded, hostID))
        .catch((cause) => setError(String(cause)));
    });
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
        if (terminal.rows > 1 && terminal.cols > 1) {
          void ipc.terminalResize(thread.id, terminal.rows, terminal.cols, hostID).catch(() => undefined);
        }
      } catch {
        // xterm can briefly have no measurable rows while the pane is resizing.
      }
    });
    resize.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [hostID, thread.id]);

  useEffect(() => {
    if (!thread.providerSessionID || initialTurnRunning || status || starting || error) return;
    void openTerminal();
  }, [error, initialTurnRunning, openTerminal, starting, status, thread.providerSessionID]);

  useEffect(() => {
    if (!status) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        try {
          const read = await ipc.terminalRead(thread.id, cursorRef.current, hostID);
          if (cancelled) return;
          const encoded = read.chunks.map((chunk) => chunk.dataBase64);
          if (read.gap) {
            encoded.unshift(btoa("\r\n\x1b[33m[Older terminal output was evicted.]\x1b[0m\r\n"));
          }
          const terminal = terminalRef.current;
          if (terminal) await writeTerminalBatch(terminal, decodeBase64Chunks(encoded));
          if (cancelled) return;
          cursorRef.current = read.cursor;
          setStatus((current) => current ? { ...current, state: read.state, cursor: read.cursor } : current);
          if (read.state === "exited") return;
        } catch (cause) {
          if (!cancelled) setError(String(cause));
          return;
        }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [hostID, status?.startedAt, thread.id]);

  const waitingForFirstTurn = !thread.providerSessionID || initialTurnRunning;
  return (
    <section className="terminal-chat" aria-label={`${thread.provider} terminal chat`}>
      <div ref={containerRef} className="terminal-emulator" />
      {(waitingForFirstTurn || starting) && (
        <div className="terminal-state-card" role="status">
          <span className="loading-orb" />
          <strong>{waitingForFirstTurn ? "Preparing terminal session" : "Opening terminal"}</strong>
          <span>
            {waitingForFirstTurn
              ? "Maxx is establishing the provider session from your first prompt."
              : `Resuming this ${thread.provider} conversation in its native CLI.`}
          </span>
        </div>
      )}
      {!waitingForFirstTurn && !starting && status?.state === "exited" && (
        <div className="terminal-ended-bar" role="status">
          <Icons.terminal size={17} />
          <div className="terminal-ended-copy">
            <strong>Terminal session ended</strong>
            <span>{error || `The ${thread.provider} CLI exited.`}</span>
          </div>
          <button onClick={() => void openTerminal(true)}>Restart terminal</button>
          <button className="secondary" onClick={onReturnToGUI}>Return to GUI</button>
        </div>
      )}
      {error && status?.state !== "exited" && (
        <div className="terminal-error" role="alert">
          <span>{error}</span>
          {!waitingForFirstTurn && <button onClick={() => { setError(null); void openTerminal(); }}>Try again</button>}
        </div>
      )}
      {status && !status.browserAvailable && (
        <div className="terminal-capability-note">Maxx Browser is unavailable in this provider’s terminal mode.</div>
      )}
    </section>
  );
});
