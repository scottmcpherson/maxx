export function hostErrorMessage(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error:\s*/i, "")
    .trim();
}

export function isHostConnectionError(reason: unknown): boolean {
  return /environment .+ is offline|remote maxx disconnected|disconnected|not connected|connection (?:closed|lost)/i
    .test(hostErrorMessage(reason));
}
