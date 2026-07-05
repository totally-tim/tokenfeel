import type { MatrixOption } from "./configMatrix";

function matchesQuery(option: MatrixOption, normalizedQuery: string): boolean {
  const haystack = `${option.label} ${option.sub ?? ""} ${option.value}`.toLowerCase();
  return haystack.includes(normalizedQuery);
}

export function filterPickerOptions(
  options: MatrixOption[],
  query: string,
  selectedValue: string | undefined,
  limit = 40
): MatrixOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const source = normalizedQuery ? options.filter((option) => matchesQuery(option, normalizedQuery)) : options;
  const visible = source.slice(0, Math.max(1, limit));

  if (!selectedValue || normalizedQuery || visible.some((option) => option.value === selectedValue)) {
    return visible;
  }

  const selected = options.find((option) => option.value === selectedValue);
  return selected ? [selected, ...visible.slice(0, Math.max(0, limit - 1))] : visible;
}
