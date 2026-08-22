import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
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
import { createTerminalEmulator, encodeTerminalInput, terminalArchive } from "../terminalEmulator";
import { Icons } from "./Icons";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface TerminalViewHandle {
  archiveText: () => string;
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
    const { terminal, fit } = createTerminalEmulator(container);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const frame = requestAnimationFrame(() => fit.fit());
    const input = terminal.onData((data) => {
      const encoded = encodeTerminalInput(data);
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
    <section className="relative mx-3 mb-3 min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-background" aria-label={`${thread.provider} terminal chat`}>
      <div ref={containerRef} className="terminal-emulator" />
      {(waitingForFirstTurn || starting) && (
        <div className="absolute top-1/2 left-1/2 flex min-w-[min(21.875rem,calc(100%-2.75rem))] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 rounded-xl border border-border bg-card/95 p-4.5 text-center text-sm text-muted-foreground shadow-xl" role="status">
          <Spinner />
          <strong>{waitingForFirstTurn ? "Preparing terminal session" : "Opening terminal"}</strong>
          <span>
            {waitingForFirstTurn
              ? "Maxx is establishing the provider session from your first prompt."
              : `Resuming this ${thread.provider} conversation in its native CLI.`}
          </span>
        </div>
      )}
      {!waitingForFirstTurn && !starting && status?.state === "exited" && (
        <div className="absolute bottom-3.5 left-1/2 z-3 flex max-w-[calc(100%-1.75rem)] flex-wrap items-center justify-center gap-2.5 rounded-xl border border-border bg-card/95 p-2.5 text-sm text-muted-foreground shadow-xl" role="status">
          <Icons.terminal size={17} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-center sm:text-left">
            <strong>Terminal session ended</strong>
            <span>{error || `The ${thread.provider} CLI exited.`}</span>
          </div>
          <Button size="sm" onClick={() => void openTerminal(true)}>Restart terminal</Button>
          <Button size="sm" variant="secondary" onClick={onReturnToGUI}>Return to GUI</Button>
        </div>
      )}
      {error && status?.state !== "exited" && (
        <Alert className="absolute right-3 bottom-3 left-3 z-3" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
          {!waitingForFirstTurn && <AlertAction><Button size="sm" variant="outline" onClick={() => { setError(null); void openTerminal(); }}>Try again</Button></AlertAction>}
        </Alert>
      )}
      {status && !status.browserAvailable && (
        <div className="pointer-events-none absolute right-2.5 bottom-2 z-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground">Maxx Browser is unavailable in this provider’s terminal mode.</div>
      )}
    </section>
  );
});
