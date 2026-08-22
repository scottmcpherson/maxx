import { useEffect, useState } from "react";
import { ipc, mediaURL } from "../ipc";
import { isLocalHost } from "../host/session";
import { mediaDataUrl } from "../host/mediaUpload";
import { MessageMedia as MessageMediaValue, MessageMediaKind } from "../media";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { cn } from "../lib/utils";
import { attachmentKind } from "../attachmentFormats";

interface RenderSource {
  url: string;
  kind: MessageMediaKind;
  displayName: string;
}

export function MessageMedia({
  media,
  projectID,
  threadID,
  hostID,
}: {
  media: MessageMediaValue;
  projectID: string;
  threadID: string;
  hostID?: string;
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
    const load = destination.startsWith("attachment:")
      ? ipc.readMedia(destination.slice("attachment:".length), hostID)
        .then((media) => {
          const resolvedKind = attachmentKind(media.mimeType);
          if (resolvedKind === "file") throw new Error("The attachment is not playable media");
          return {
            url: mediaDataUrl(media.mimeType, media.dataBase64),
            kind: resolvedKind,
            displayName: media.displayName,
          };
        })
      : isLocalHost(hostID)
        ? ipc.resolveMediaSource(projectID, threadID, destination, hostID)
          .then((resolved) => ({
            url: mediaURL(resolved.path),
            kind: resolved.kind,
            displayName: resolved.displayName,
          }))
        : ipc.loadMedia(projectID, threadID, destination, hostID)
          .then((media) => ({
            url: mediaDataUrl(media.mimeType, media.dataBase64),
            kind: media.kind ?? "image",
            displayName: media.displayName,
          }));
    void load
      .then((resolved) => {
        if (!cancelled) setSource(resolved);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(typeof reason === "string" ? reason : "Could not load media");
      });
    return () => {
      cancelled = true;
    };
  }, [altText, destination, hostID, kind, projectID, threadID]);

  if (error) {
    return (
      <Alert variant="destructive" role="status" className="max-w-full">
        <AlertTitle>Could not load {kind}</AlertTitle>
        <AlertDescription title={error}>{destination}</AlertDescription>
      </Alert>
    );
  }
  if (!source) return <Skeleton className="h-45 w-full max-w-[45rem] rounded-xl" aria-label={`Loading ${kind}`} />;

  const label = altText || source.displayName;
  if (source.kind === "video") {
    return (
      <figure className="flex w-full max-w-[45rem] flex-col items-start gap-1.5">
        <video className="block max-h-[32.5rem] w-full rounded-xl border border-border bg-muted object-contain" controls preload="metadata" aria-label={label} onError={() => setError("The video could not be decoded") }>
          <source src={source.url} />
        </video>
        {altText && <figcaption className="text-xs leading-snug text-muted-foreground">{altText}</figcaption>}
      </figure>
    );
  }
  if (source.kind === "audio") {
    return (
      <figure className="flex w-full max-w-[35rem] flex-col items-start gap-1.5">
        {altText && <figcaption className="text-xs leading-snug text-muted-foreground">{altText}</figcaption>}
        <audio className="w-full" controls preload="metadata" aria-label={label} onError={() => setError("The audio could not be decoded") }>
          <source src={source.url} />
        </audio>
      </figure>
    );
  }
  return (
    <figure className="flex w-full max-w-[45rem] flex-col items-start gap-1.5">
      <img className={cn("block max-h-[32.5rem] max-w-full rounded-xl border border-border bg-muted object-contain", source.kind === "image" && "h-auto w-auto")} src={source.url} alt={label} onError={() => setError("The image could not be decoded")} />
      {altText && altText !== source.displayName && <figcaption className="text-xs leading-snug text-muted-foreground">{altText}</figcaption>}
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
