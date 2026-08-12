import { CSSProperties, useState } from "react";
import { mediaURL } from "../ipc";

/** Palette for freshly created agents; the editor can shuffle through it. */
export const AGENT_COLORS = [
  "#7657ee",
  "#5b8def",
  "#4fb0a5",
  "#6fc58b",
  "#d7ae5c",
  "#e08d5a",
  "#e47370",
  "#d76fa8",
  "#9d6fd7",
  "#8a93a5",
];

export function agentColorForName(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

export function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "?";
  const second = words.length > 1 ? [...words[words.length - 1]][0] ?? "" : "";
  return (first + second).toUpperCase();
}

/**
 * Agent profile image: an imported image when configured, then an emoji,
 * otherwise initials on a deterministic gradient derived from the agent's
 * color. A broken image file falls back to the emoji/initials rendering.
 */
export function AgentAvatar({
  name,
  colorHex,
  emoji,
  imagePath,
  size = 20,
}: {
  name: string;
  colorHex?: string | null;
  emoji?: string | null;
  imagePath?: string | null;
  size?: number;
}) {
  // Remember which path failed to load so a replaced image retries.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const showImage = !!imagePath && imagePath !== failedPath;
  const base = colorHex || agentColorForName(name);
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: emoji ? size * 0.58 : size * 0.42,
    background: showImage || emoji
      ? "var(--bg-active)"
      : `linear-gradient(135deg, color-mix(in oklab, ${base} 88%, white), color-mix(in oklab, ${base} 72%, black))`,
  };
  return (
    <span className="agent-avatar" style={style} role="img" aria-label={`${name} avatar`}>
      {showImage ? (
        <img
          src={mediaURL(imagePath)}
          alt=""
          draggable={false}
          onError={() => setFailedPath(imagePath)}
        />
      ) : (
        emoji || agentInitials(name)
      )}
    </span>
  );
}
