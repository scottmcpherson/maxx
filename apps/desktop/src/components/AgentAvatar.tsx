import { CSSProperties, useState } from "react";
import { mediaURL } from "../ipc";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/** Purple-free palette available to freshly created agents and the avatar editor. */
export const AGENT_COLORS = [
  "#75a7e8",
  "#3974d9",
  "#6fc8c8",
  "#2f8f83",
  "#43a86b",
  "#87b94e",
  "#f2c94c",
  "#e08d5a",
  "#c84f4f",
  "#e47370",
  "#e28aa1",
  "#a97b5b",
  "#d7c5a9",
  "#b8b8b8",
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
  const style = { "--avatar-size": `${size}px` } as CSSProperties;
  const fallbackStyle: CSSProperties = {
    fontSize: emoji ? size * 0.58 : size * 0.42,
    background: emoji
      ? "var(--accent)"
      : `linear-gradient(135deg, color-mix(in oklab, ${base} 88%, white), color-mix(in oklab, ${base} 72%, black))`,
  };
  return (
    <Avatar className="size-[var(--avatar-size)]" style={style} aria-label={`${name} avatar`}>
      {showImage && (
        <AvatarImage
          src={mediaURL(imagePath)}
          alt={`${name} avatar`}
          draggable={false}
          onError={() => setFailedPath(imagePath)}
        />
      )}
      <AvatarFallback style={fallbackStyle}>{emoji || agentInitials(name)}</AvatarFallback>
    </Avatar>
  );
}
