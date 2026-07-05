export interface RaceOutputIndexedEvent {
  id: string;
  index: number;
}

export function raceOutputWindow<T extends RaceOutputIndexedEvent>(
  events: T[],
  activeIndex: number,
  maxEvents = 4,
  hasStarted = true
): T[] {
  if (!hasStarted || events.length === 0 || maxEvents <= 0) return [];

  const boundedIndex = Math.max(0, Math.min(activeIndex, events.length - 1));
  const startIndex = Math.max(0, boundedIndex - maxEvents + 1);
  return events.slice(startIndex, boundedIndex + 1);
}
