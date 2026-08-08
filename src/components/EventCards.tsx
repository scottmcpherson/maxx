// Port of MessageContentView's runtime cards: commands, tools, file changes,
// plans, diffs, usage, warnings, errors, and interactive approval/question
// cards with resolution controls.

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

// Routine activity (commands, tools, file changes, diffs) renders as compact
// one-line disclosure rows: collapsed by default with a right-pointing
// chevron, expanding to the command/input and output on demand.
const ROW_KINDS = new Set<string>([
  EventKind.command,
  EventKind.tool,
  EventKind.fileChange,
  EventKind.diff,
]);

export function ActivityCard({ event, threadID }: { event: ProviderRuntimeEvent; threadID: string }) {
  const payload = event.payload;
  if (event.kind === EventKind.usage) return null; // summarized below the composer
  if (event.kind === EventKind.plan && payload.plan) {
    return (
      <div className="event-card kind-plan">
        <div className="card-title-row">
          <span className="card-title">Plan</span>
        </div>
        <ul className="plan-list">
          {payload.plan.map((step) => (
            <li key={step.id} className={`plan-step state-${step.state}`}>
              <span className="plan-marker">{step.state === "completed" ? "✓" : "○"}</span>
              {step.title}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (ROW_KINDS.has(event.kind)) return <ActivityRow event={event} threadID={threadID} />;

  // Warnings, errors, and unknown kinds stay prominent cards.
  const title =
    event.kind === EventKind.error
      ? payload.error?.message ?? "Error"
      : payload.title ?? (event.kind === EventKind.warning ? "Warning" : event.kind);
  const detail = payload.detail ?? payload.error?.detail;
  return (
    <div className={`event-card kind-${event.kind.replace(/\./g, "-")}`}>
      <div className="card-title-row">
        <span className="card-title">{title}</span>
      </div>
      {detail && <pre className="card-detail">{detail}</pre>}
      {payload.error?.suggestedAction && (
        <p className="suggested-action">{payload.error.suggestedAction}</p>
      )}
    </div>
  );
}

function ActivityRow({ event, threadID }: { event: ProviderRuntimeEvent; threadID: string }) {
  const payload = event.payload;
  const verb =
    event.kind === EventKind.command
      ? "Run"
      : event.kind === EventKind.fileChange
        ? "Edit"
        : event.kind === EventKind.diff
          ? "Diff"
          : payload.tool?.name ?? "Tool";
  const rawTitle =
    event.kind === EventKind.command
      ? payload.title ?? payload.command
      : event.kind === EventKind.tool
        ? payload.title ?? payload.tool?.input
        : payload.title ?? payload.files?.map((file) => file.path).join(", ");
  const summaryTitle = firstLine(rawTitle);
  const title = summaryTitle && summaryTitle !== verb ? summaryTitle : undefined;
  const detail = payload.command ?? payload.tool?.input ?? payload.detail;
  const output = payload.output ?? payload.tool?.output ?? payload.diff;
  const files = payload.files;
  const imageArtifacts = (payload.artifacts ?? []).filter((artifact) =>
    artifact.mimeType.startsWith("image/"),
  );
  const state = payload.state;
  const hasBody = !!(detail || output || (files && files.length > 0));

  const summary = (
    <>
      <span className="activity-verb">{verb}</span>
      {title && <span className="activity-title">{title}</span>}
      {state === "running" && <span className="mini-spinner" />}
      {state === "failed" && <span className="activity-state failed">failed</span>}
      {state === "waiting" && <span className="activity-state">waiting</span>}
    </>
  );

  const row = !hasBody ? (
    <div className="activity-row static">{summary}</div>
  ) : (
    <details className="activity-row">
      <summary>{summary}</summary>
      <div className="activity-body">
        {detail && (
          <pre className={`card-detail${event.kind === EventKind.command ? " command" : ""}`}>
            {detail}
          </pre>
        )}
        {files && files.length > 0 && (
          <ul className="file-list">
            {files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code> <span className="file-kind">{file.changeType}</span>
              </li>
            ))}
          </ul>
        )}
        {output && <pre className="card-output">{output}</pre>}
      </div>
    </details>
  );

  if (imageArtifacts.length === 0) return row;
  return (
    <div className="activity-result">
      {row}
      <div className="tool-artifact-grid">
        {imageArtifacts.map((artifact) => (
          <BrowserArtifactImage key={artifact.id} artifact={artifact} threadID={threadID} />
        ))}
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
      .then((content) => {
        if (!cancelled) setSource(browserArtifactDataURL(content));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, threadID]);

  if (error) {
    return <div className="message-media-unavailable" role="status">Screenshot unavailable</div>;
  }
  if (!source) {
    return <div className="message-media-placeholder" aria-label="Loading browser screenshot" />;
  }
  return (
    <figure className="message-media message-media-image browser-artifact-image">
      <img src={source} alt={artifact.title ?? "Browser screenshot"} />
      {artifact.title ? <figcaption>{artifact.title}</figcaption> : null}
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
      <div className="event-card interaction">
        <div className="card-title-row">
          <span className="card-title">{approval.title}</span>
          <span className="state-pill state-waiting">approval</span>
        </div>
        {approval.command && <pre className="card-detail">{approval.command}</pre>}
        {approval.detail && <pre className="card-detail">{approval.detail}</pre>}
        {resolved ? (
          <p className="resolved-note">Resolved: {resolved}</p>
        ) : (
          <div className="decision-row">
            {approval.options.map((option) => (
              <button
                key={option.id}
                className={`decision-button kind-${option.kind}`}
                onClick={() =>
                  onResolve({
                    kind: option.kind,
                    selectedOptionIDs: option.nativeValue ? [option.nativeValue] : [],
                    textAnswers: {},
                  })
                }
              >
                {option.title}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (event.kind === EventKind.userInputRequest && event.payload.userInput) {
    return (
      <QuestionCard
        questions={event.payload.userInput.questions}
        resolved={resolved}
        onResolve={onResolve}
      />
    );
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

  const toggle = (question: RuntimeQuestion, optionID: string) => {
    setSelected((current) => {
      const existing = current[question.id] ?? [];
      if (question.answerKind === "multiSelect") {
        return {
          ...current,
          [question.id]: existing.includes(optionID)
            ? existing.filter((o) => o !== optionID)
            : [...existing, optionID],
        };
      }
      return { ...current, [question.id]: [optionID] };
    });
  };

  const submit = () => {
    const selectedOptionIDs: string[] = [];
    for (const [questionID, options] of Object.entries(selected)) {
      for (const option of options) selectedOptionIDs.push(`${questionID}:${option}`);
    }
    const textAnswers: Record<string, string> = {};
    for (const [questionID, answer] of Object.entries(text)) {
      if (answer.trim()) textAnswers[questionID] = answer;
    }
    onResolve({ selectedOptionIDs, textAnswers });
  };

  return (
    <div className="event-card interaction">
      <div className="card-title-row">
        <span className="card-title">Provider question</span>
        <span className="state-pill state-waiting">input</span>
      </div>
      {questions.map((question) => (
        <div key={question.id} className="question-block">
          {question.header && <p className="question-header">{question.header}</p>}
          <p className="question-prompt">{question.prompt}</p>
          {question.options.length > 0 ? (
            <div className="decision-row wrap">
              {question.options.map((option) => (
                <button
                  key={option.id}
                  className={`decision-button ${
                    (selected[question.id] ?? []).includes(option.id) ? "picked" : ""
                  }`}
                  disabled={!!resolved}
                  title={option.description}
                  onClick={() => toggle(question, option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : (
            <input
              className="question-input"
              disabled={!!resolved}
              placeholder="Type an answer…"
              value={text[question.id] ?? ""}
              onChange={(e) =>
                setText((current) => ({ ...current, [question.id]: e.target.value }))
              }
            />
          )}
        </div>
      ))}
      {resolved ? (
        <p className="resolved-note">Resolved: {resolved}</p>
      ) : (
        <div className="decision-row">
          <button className="decision-button kind-approve" onClick={submit}>
            Submit
          </button>
          <button
            className="decision-button kind-cancel"
            onClick={() => onResolve({ kind: "cancel", selectedOptionIDs: [], textAnswers: {} })}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
