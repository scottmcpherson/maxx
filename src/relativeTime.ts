const APPLE_EPOCH_OFFSET = 978_307_200;

export function relativeTime(appleSeconds: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - (appleSeconds + APPLE_EPOCH_OFFSET));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}
