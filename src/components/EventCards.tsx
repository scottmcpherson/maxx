// Runtime cards: commands, tools, file changes, plans, diffs, usage, warnings,
// errors, and interactive approval/question cards.

import { useEffect, useState } from "react";
import {
  EventKind,
  ProviderRuntimeEvent,
  RuntimeArtifact,
  RuntimeInteractionDecision,
  RuntimeQuestion,
} from "../contract/types";
import { ipc } from "../ipc";
import { browserArtifactDataURL } from "../browser";
import { cn } from "../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const ROW_KINDS = new Set<string>([
  EventKind.command,
  EventKind.tool,
  EventKind.fileChange,
  EventKind.diff,
]);

export function ActivityCard({ event, threadID }: { event: ProviderRuntimeEvent; threadID: string }) {
  const payload = event.payload;
  if (event.kind === EventKind.usage) return null;
  if (event.kind === EventKind.plan && payload.plan) {
    return (
      <Card size="sm" className="gap-3 border-border/70 bg-card/80">
        <CardHeader className="px-3 py-0"><CardTitle className="text-sm">Plan</CardTitle></CardHeader>
        <CardContent className="px-3">
          <ul className="flex list-none flex-col gap-1.5 p-0 text-sm">
            {payload.plan.map((step) => (
              <li key={step.id} className={cn("flex items-start gap-2", step.state === "completed" && "text-muted-foreground line-through")}>
                <span className={cn("shrink-0 text-primary", step.state === "completed" && "text-muted-foreground")} aria-hidden="true">{step.state === "completed" ? "✓" : "○"}</span>
                <span>{step.title}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  }
  if (ROW_KINDS.has(event.kind)) return <ActivityRow event={event} threadID={threadID} />;

  const title = event.kind === EventKind.error
    ? payload.error?.message ?? "Error"
    : payload.title ?? (event.kind === EventKind.warning ? "Warning" : event.kind);
  const detail = payload.detail ?? payload.error?.detail;
  const isError = event.kind === EventKind.error;
  return (
    <Alert variant={isError ? "destructive" : "default"} className="gap-2 bg-card/80">
      <AlertTitle>{title}</AlertTitle>
      {detail && <AlertDescription><pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs text-foreground">{detail}</pre></AlertDescription>}
      {payload.error?.suggestedAction && <AlertDescription>{payload.error.suggestedAction}</AlertDescription>}
    </Alert>
  );
}

function ActivityRow({ event, threadID }: { event: ProviderRuntimeEvent; threadID: string }) {
  const payload = event.payload;
  const verb = event.kind === EventKind.command
    ? "Run"
    : event.kind === EventKind.fileChange
      ? "Edit"
      : event.kind === EventKind.diff
        ? "Diff"
        : payload.tool?.name ?? "Tool";
  const rawTitle = event.kind === EventKind.command
    ? payload.title ?? payload.command
    : event.kind === EventKind.tool
      ? payload.title ?? payload.tool?.input
      : payload.title ?? payload.files?.map((file) => file.path).join(", ");
  const summaryTitle = firstLine(rawTitle);
  const title = summaryTitle && summaryTitle !== verb ? summaryTitle : undefined;
  const detail = payload.command ?? payload.tool?.input ?? payload.detail;
  const output = payload.output ?? payload.tool?.output ?? payload.diff;
  const files = payload.files;
  const imageArtifacts = (payload.artifacts ?? []).filter((artifact) => artifact.mimeType.startsWith("image/"));
  const state = payload.state;
  const hasBody = !!(detail || output || (files && files.length > 0));

  const summary = (
    <>
      <span className="shrink-0 font-medium text-foreground">{verb}</span>
      {title && <span className="min-w-0 truncate text-muted-foreground">{title}</span>}
      {state === "running" && <Spinner className="size-3 shrink-0" />}
      {state === "failed" && <Badge variant="destructive">failed</Badge>}
      {state === "waiting" && <Badge variant="secondary">waiting</Badge>}
    </>
  );

  const row = !hasBody ? (
    <div className="flex min-w-0 items-center gap-1.5 px-2 text-sm text-muted-foreground">{summary}</div>
  ) : (
    <details className="group min-w-0 overflow-hidden px-2 text-sm text-muted-foreground">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 outline-none marker:hidden [&::-webkit-details-marker]:hidden">{summary}</summary>
      <div className="flex min-w-0 max-w-full flex-col gap-1.5 overflow-hidden py-1.5 ps-4">
        {detail && <pre className={cn("max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs text-foreground", event.kind === EventKind.command && "before:content-['$ ']")}>{detail}</pre>}
        {files && files.length > 0 && (
          <ul className="flex list-none flex-col gap-1 p-0 text-xs">
            {files.map((file) => <li key={file.path} className="flex justify-between gap-2"><code className="min-w-0 truncate">{file.path}</code><span className="shrink-0 text-primary">{file.changeType}</span></li>)}
          </ul>
        )}
        {output && <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{output}</pre>}
      </div>
    </details>
  );

  if (imageArtifacts.length === 0) return row;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {row}
      <div className="flex min-w-0 flex-col gap-2 px-2">
        {imageArtifacts.map((artifact) => <BrowserArtifactImage key={artifact.id} artifact={artifact} threadID={threadID} />)}
      </div>
    </div>
  );
}

function BrowserArtifactImage({ artifact, threadID }: { artifact: RuntimeArtifact; threadID: string }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setError(false);
    void ipc.browserUiArtifact(threadID, artifact.id)
      .then((content) => { if (!cancelled) setSource(browserArtifactDataURL(content)); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [artifact.id, threadID]);

  if (error) return <Alert variant="destructive" role="status"><AlertDescription>Screenshot unavailable</AlertDescription></Alert>;
  if (!source) return <Skeleton className="h-45 w-full rounded-xl" aria-label="Loading browser screenshot" />;
  return (
    <figure className="flex w-full flex-col items-start gap-1.5">
      <img className="block max-h-[28.75rem] max-w-full rounded-xl border border-border bg-muted object-contain" src={source} alt={artifact.title ?? "Browser screenshot"} />
      {artifact.title ? <figcaption className="text-xs text-muted-foreground">{artifact.title}</figcaption> : null}
    </figure>
  );
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split("\n")[0]?.trim();
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

export function InteractionCard({
  event,
  resolved,
  onResolve,
}: {
  event: ProviderRuntimeEvent;
  resolved: string | null;
  onResolve: (decision: RuntimeInteractionDecision) => void;
}) {
  if (event.kind === EventKind.approvalRequest && event.payload.approval) {
    const approval = event.payload.approval;
    return (
      <Card size="sm" className="border-border bg-card">
        <CardHeader className="flex-row items-center justify-between px-3 py-0">
          <CardTitle className="truncate text-sm">{approval.title}</CardTitle>
          <Badge variant="secondary">approval</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-3">
          {approval.command && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{approval.command}</pre>}
          {approval.detail && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">{approval.detail}</pre>}
          {resolved ? <p className="text-xs text-muted-foreground">Resolved: {resolved}</p> : (
            <div className="flex flex-wrap gap-1.5">
              {approval.options.map((option) => (
                <Button key={option.id} variant={option.kind === "approve" ? "default" : option.kind === "deny" ? "destructive" : "secondary"} size="sm" onClick={() => onResolve({ kind: option.kind, selectedOptionIDs: option.nativeValue ? [option.nativeValue] : [], textAnswers: {} })}>{option.title}</Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }
  if (event.kind === EventKind.userInputRequest && event.payload.userInput) {
    return <QuestionCard questions={event.payload.userInput.questions} resolved={resolved} onResolve={onResolve} />;
  }
  return null;
}

function QuestionCard({
  questions,
  resolved,
  onResolve,
}: {
  questions: RuntimeQuestion[];
  resolved: string | null;
  onResolve: (decision: RuntimeInteractionDecision) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [text, setText] = useState<Record<string, string>>({});

  const submit = () => {
    const selectedOptionIDs = Object.entries(selected).flatMap(([questionID, options]) => options.map((option) => `${questionID}:${option}`));
    const textAnswers: Record<string, string> = {};
    for (const [questionID, answer] of Object.entries(text)) if (answer.trim()) textAnswers[questionID] = answer;
    onResolve({ selectedOptionIDs, textAnswers });
  };

  return (
    <Card size="sm" className="border-border bg-card">
      <CardHeader className="flex-row items-center justify-between px-3 py-0"><CardTitle className="text-sm">Provider question</CardTitle><Badge variant="secondary">input</Badge></CardHeader>
      <CardContent className="flex flex-col gap-3 px-3">
        {questions.map((question) => (
          <div key={question.id} className="flex flex-col gap-1.5">
            {question.header && <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{question.header}</p>}
            <p className="text-sm leading-snug">{question.prompt}</p>
            {question.options.length > 0 ? (
              <ToggleGroup
                multiple={question.answerKind === "multiSelect"}
                value={selected[question.id] ?? []}
                onValueChange={(value) => setSelected((current) => ({ ...current, [question.id]: value }))}
                disabled={!!resolved}
                className="flex flex-wrap"
              >
                {question.options.map((option) => <ToggleGroupItem key={option.id} value={option.id} variant="outline" size="sm" title={option.description}>{option.label}</ToggleGroupItem>)}
              </ToggleGroup>
            ) : (
              <Input disabled={!!resolved} placeholder="Type an answer…" value={text[question.id] ?? ""} onChange={(event) => setText((current) => ({ ...current, [question.id]: event.target.value }))} />
            )}
          </div>
        ))}
        {resolved ? <p className="text-xs text-muted-foreground">Resolved: {resolved}</p> : (
          <div className="flex gap-1.5">
            <Button variant="default" size="sm" onClick={submit}>Submit</Button>
            <Button variant="destructive" size="sm" onClick={() => onResolve({ kind: "cancel", selectedOptionIDs: [], textAnswers: {} })}>Cancel</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
