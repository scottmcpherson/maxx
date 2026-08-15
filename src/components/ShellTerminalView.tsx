import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalStatus } from "../contract/types";
import { ipc } from "../ipc";
import { createTerminalEmulator, encodeTerminalInput } from "../terminalEmulator";
import { decodeBase64Chunks, writeTerminalBatch } from "../terminalStream";
import { Icons } from "./Icons";

export function ShellTerminalView({
  projectID,
  threadID,
  sessionID,
  hostID,
}: {
  projectID: string;
  threadID: string;
  sessionID: string;
  hostID?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cursorRef = useRef(0);
  const inputQueueRef = useRef(Promise.resolve());
  const startingRef = useRef(false);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openTerminal = useCallback(async (restart = false) => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      fit.fit();
      const existing = restart ? null : await ipc.shellTerminalStatus(sessionID, hostID);
      const next = existing?.state === "running" ? existing : await ipc.shellTerminalStart(
        projectID,
        threadID,
        sessionID,
        Math.max(2, terminal.rows),
        Math.max(2, terminal.cols),
        hostID,
      );
      cursorRef.current = 0;
      if (restart) terminal.write("\r\n\x1b[2m──────── Terminal restarted ────────\x1b[0m\r\n");
      setStatus(next);
      terminal.focus();
    } catch (cause) {
      setError(String(cause));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [hostID, projectID, sessionID, threadID]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { terminal, fit } = createTerminalEmulator(container);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const frame = requestAnimationFrame(() => fit.fit());
    const input = terminal.onData((data) => {
      const encoded = encodeTerminalInput(data);
      inputQueueRef.current = inputQueueRef.current
        .then(() => ipc.shellTerminalInput(sessionID, encoded, hostID))
        .catch((cause) => setError(String(cause)));
    });
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
        if (terminal.rows > 1 && terminal.cols > 1) {
          void ipc.shellTerminalResize(sessionID, terminal.rows, terminal.cols, hostID).catch(() => undefined);
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
  }, [hostID, sessionID]);

  useEffect(() => {
    if (status || starting || error) return;
    void openTerminal();
  }, [error, openTerminal, starting, status]);

  useEffect(() => {
    if (!status) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        try {
          const read = await ipc.shellTerminalRead(sessionID, cursorRef.current, hostID);
          if (cancelled) return;
          const encoded = read.chunks.map((chunk) => chunk.dataBase64);
          if (read.gap) encoded.unshift(btoa("\r\n\x1b[33m[Older terminal output was evicted.]\x1b[0m\r\n"));
          if (terminalRef.current) await writeTerminalBatch(terminalRef.current, decodeBase64Chunks(encoded));
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
  }, [hostID, sessionID, status?.startedAt]);

  return (
    <section className="panel-terminal" aria-label="Terminal">
      <div ref={containerRef} className="terminal-emulator" />
      {starting && (
        <div className="terminal-state-card" role="status">
          <span className="loading-orb" />
          <strong>Opening terminal</strong>
          <span>Starting a shell in this chat’s working directory.</span>
        </div>
      )}
      {!starting && status?.state === "exited" && (
        <div className="terminal-ended-bar" role="status">
          <Icons.terminal size={17} />
          <div className="terminal-ended-copy">
            <strong>Terminal session ended</strong>
            <span>{error || "The shell exited."}</span>
          </div>
          <button onClick={() => void openTerminal(true)}>Restart terminal</button>
        </div>
      )}
      {error && status?.state !== "exited" && (
        <div className="terminal-error" role="alert">
          <span>{error}</span>
          <button onClick={() => { setError(null); void openTerminal(); }}>Try again</button>
        </div>
      )}
    </section>
  );
}
