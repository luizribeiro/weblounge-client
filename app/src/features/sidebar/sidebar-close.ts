export function focusAfterClose(
  orderedIds: readonly number[],
  closingId: number,
): number | undefined {
  const index = orderedIds.indexOf(closingId);
  if (index < 0) return orderedIds[0];
  return orderedIds[index + 1] ?? orderedIds[index - 1];
}
