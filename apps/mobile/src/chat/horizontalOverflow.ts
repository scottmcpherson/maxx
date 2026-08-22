export type HorizontalOverflow = { left: boolean; right: boolean };

export function horizontalOverflow(
  offsetX: number,
  viewportWidth: number,
  contentWidth: number,
): HorizontalOverflow {
  const maxOffset = Math.max(0, contentWidth - viewportWidth);
  return {
    left: offsetX > 2,
    right: offsetX < maxOffset - 2,
  };
}
