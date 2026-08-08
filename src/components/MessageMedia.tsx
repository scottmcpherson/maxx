import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import { MessageMedia as MessageMediaValue, MessageMediaKind } from "../media";

interface RenderSource {
  url: string;
  kind: MessageMediaKind;
  displayName: string;
}

export function MessageMedia({
  media,
  projectID,
  threadID,
}: {
  media: MessageMediaValue;
  projectID: string;
  threadID: string;
}) {
  const { altText, destination, kind } = media;
  const [source, setSource] = useState<RenderSource | null>(() => remoteSource(destination, kind, altText));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const remote = remoteSource(destination, kind, altText);
    if (remote) {
      setSource(remote);
      setError(null);
      return;
    }

    let cancelled = false;
    setSource(null);
    setError(null);
    void ipc.resolveMediaSource(projectID, threadID, destination)
      .then((resolved) => {
        if (cancelled) return;
        setSource({
          url: convertFileSrc(resolved.path),
          kind: resolved.kind,
          displayName: resolved.displayName,
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(typeof reason === "string" ? reason : "Could not load media");
      });
    return () => {
      cancelled = true;
    };
  }, [altText, destination, kind, projectID, threadID]);

  if (error) {
    return (
      <div className="message-media-unavailable" role="status">
        <strong>Could not load {kind}</strong>
        <span title={error}>{destination}</span>
      </div>
    );
  }
  if (!source) return <div className="message-media-placeholder" aria-label={`Loading ${kind}`} />;

  const label = altText || source.displayName;
  if (source.kind === "video") {
    return (
      <figure className="message-media message-media-video">
        <video controls preload="metadata" aria-label={label} onError={() => setError("The video could not be decoded") }>
          <source src={source.url} />
        </video>
        {altText && <figcaption>{altText}</figcaption>}
      </figure>
    );
  }
  if (source.kind === "audio") {
    return (
      <figure className="message-media message-media-audio">
        {altText && <figcaption>{altText}</figcaption>}
        <audio controls preload="metadata" aria-label={label} onError={() => setError("The audio could not be decoded") }>
          <source src={source.url} />
        </audio>
      </figure>
    );
  }
  return (
    <figure className="message-media message-media-image">
      <img src={source.url} alt={label} onError={() => setError("The image could not be decoded")} />
      {altText && altText !== source.displayName && <figcaption>{altText}</figcaption>}
    </figure>
  );
}

function remoteSource(destination: string, kind: MessageMediaKind, altText: string): RenderSource | null {
  // Remote and embedded sources stay inside the WebView. Local filesystem
  // destinations always go through the scoped Rust resolver below.
  if (!/^(?:https?:|blob:|data:(?:image|video|audio)\/)/i.test(destination)) return null;
  return {
    url: destination,
    kind,
    displayName: altText || "Media",
  };
}
