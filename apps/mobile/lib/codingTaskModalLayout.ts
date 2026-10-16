/** Backdrop padding around Code Factory task modals (matches CodingTasksTab styles). */
export const CODING_TASK_MODAL_BACKDROP_PADDING = 12;

export type CodingTaskSheetMaxHeightOptions = {
  padding?: number;
  topInset?: number;
  bottomInset?: number;
};

/**
 * Pixel max height so a Code Factory modal sheet fits inside the window after
 * backdrop padding and safe-area insets. Percentage maxHeight + flex:1 overflows
 * on narrow Android cover screens (e.g. Galaxy Z Fold 3 ~340×926 dp).
 */
export function codingTaskSheetMaxHeight(
  windowHeight: number,
  options: CodingTaskSheetMaxHeightOptions = {},
): number {
  const padding = options.padding ?? CODING_TASK_MODAL_BACKDROP_PADDING;
  const topInset = options.topInset ?? 0;
  const bottomInset = options.bottomInset ?? 0;
  return Math.max(0, Math.floor(windowHeight - padding * 2 - topInset - bottomInset));
}
