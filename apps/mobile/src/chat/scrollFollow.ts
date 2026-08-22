const DEFAULT_BOTTOM_THRESHOLD = 72;

export type ScrollMetrics = {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
  reservedBottomHeight?: number;
};

export function isNearScrollBottom(
  metrics: ScrollMetrics,
  threshold = DEFAULT_BOTTOM_THRESHOLD,
): boolean {
  const effectiveContentHeight = Math.max(
    0,
    metrics.contentHeight - Math.max(0, metrics.reservedBottomHeight ?? 0),
  );
  const distance = effectiveContentHeight - metrics.viewportHeight - metrics.offsetY;
  return distance <= threshold;
}
