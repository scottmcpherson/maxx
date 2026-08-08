export type MessageMediaKind = "image" | "video" | "audio";

export interface MessageMedia {
  destination: string;
  altText: string;
  kind: MessageMediaKind;
}

export type MessageContentSegment =
  | { id: number; kind: "markdown"; text: string }
  | { id: number; kind: "media"; media: MessageMedia };

const IMAGE_EXTENSIONS = new Set([
  "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp",
]);
const VIDEO_EXTENSIONS = new Set([
  "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm",
]);
const AUDIO_EXTENSIONS = new Set([
  "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav",
]);

const MEDIA_EXPRESSION = /(!?)\[([^\]]*)\]\(([^\n)]+)\)/g;
const FENCE_EXPRESSION = /^\s*(?:```|~~~)/gm;

/**
 * Splits assistant markdown into ordinary Streamdown content and inline media.
 * Providers use both image markdown and ordinary links to generated artifacts,
 * so a link with a known media extension is intentionally treated as media too.
 */
export function parseMessageContent(source: string): MessageContentSegment[] {
  const protectedRanges = fencedCodeRanges(source);
  const matches = Array.from(source.matchAll(MEDIA_EXPRESSION)).filter((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return !protectedRanges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
  });

  if (matches.length === 0) return [{ id: 0, kind: "markdown", text: source }];

  const segments: MessageContentSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    const explicitImage = match[1] === "!";
    const destination = normalizeDestination(match[3]);
    const mediaKind = destination ? mediaKindForDestination(destination, explicitImage) : null;
    if (!destination || !mediaKind || match.index === undefined) continue;

    let matchStart = match.index;
    let matchEnd = match.index + match[0].length;
    // Grok commonly bolds generated artifact links. Consume the wrapper so it
    // does not become a pair of orphaned `**` markdown fragments.
    if (source.slice(matchStart - 2, matchStart) === "**" && source.slice(matchEnd, matchEnd + 2) === "**") {
      matchStart -= 2;
      matchEnd += 2;
    }

    appendMarkdown(source.slice(cursor, matchStart), segments);
    segments.push({
      id: segments.length,
      kind: "media",
      media: {
        destination,
        altText: match[2] || fileName(destination),
        kind: mediaKind,
      },
    });
    cursor = matchEnd;
  }

  appendMarkdown(source.slice(cursor), segments);
  return segments.length > 0 ? segments : [{ id: 0, kind: "markdown", text: source }];
}

function appendMarkdown(text: string, segments: MessageContentSegment[]) {
  const trimmed = text.replace(/^\n+|\n+$/g, "");
  if (trimmed) segments.push({ id: segments.length, kind: "markdown", text: trimmed });
}

function normalizeDestination(raw: string): string | null {
  let destination = raw.trim();
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1);
  } else {
    destination = destination.replace(/\s+["'][^"']*["']\s*$/, "");
  }
  return destination || null;
}

function mediaKindForDestination(destination: string, explicitImage: boolean): MessageMediaKind | null {
  if (/^data:image\//i.test(destination)) return "image";
  if (/^data:video\//i.test(destination)) return "video";
  if (/^data:audio\//i.test(destination)) return "audio";

  const extension = destination
    .split(/[?#]/, 1)[0]
    .split("/")
    .pop()
    ?.split(".")
    .pop()
    ?.toLowerCase();
  if (extension && IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension && VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension && AUDIO_EXTENSIONS.has(extension)) return "audio";
  return explicitImage ? "image" : null;
}

function fileName(destination: string): string {
  const withoutQuery = destination.split(/[?#]/, 1)[0];
  return withoutQuery.split("/").pop() || "Media";
}

function fencedCodeRanges(source: string): Array<[number, number]> {
  const fences = Array.from(source.matchAll(FENCE_EXPRESSION));
  const ranges: Array<[number, number]> = [];
  let opening: number | null = null;
  for (const fence of fences) {
    const location = fence.index ?? 0;
    if (opening === null) opening = location;
    else {
      ranges.push([opening, location + fence[0].length]);
      opening = null;
    }
  }
  if (opening !== null) ranges.push([opening, source.length]);
  return ranges;
}
