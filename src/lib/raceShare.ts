import type { CacheMode } from "../types";

export interface RaceShareState {
  leftId: string;
  rightId: string;
  scenarioId: string;
  speed: number;
  cacheMode?: CacheMode;
}

export function buildRaceShareUrl(state: RaceShareState, baseHref = window.location.href): string {
  const url = new URL(baseHref);
  const params = new URLSearchParams({
    a: state.leftId,
    b: state.rightId,
    s: state.scenarioId,
    speed: String(state.speed)
  });
  if (state.cacheMode && state.cacheMode !== "runtime") {
    params.set("cache", state.cacheMode);
  }

  url.search = "";
  url.hash = `race?${params.toString()}`;
  return url.toString();
}

export function parseRaceShareHash(hash: string): Partial<RaceShareState> {
  // Only the first "?" starts the query string; a naive split("?") would
  // silently drop everything after a second "?" if one ever showed up in a
  // param value.
  const queryStart = hash.indexOf("?");
  const query = queryStart === -1 ? "" : hash.substring(queryStart + 1);
  const params = new URLSearchParams(query);
  // params.has() first: an absent "speed" must resolve to undefined (per
  // RaceShareState's Partial<> contract), not Number(null) === 0.
  const speed = params.has("speed") ? Number(params.get("speed")) : undefined;
  const rawCacheMode = params.get("cache");
  const cacheMode =
    rawCacheMode === "on" || rawCacheMode === "off" || rawCacheMode === "runtime" ? rawCacheMode : undefined;

  return {
    leftId: params.get("a") ?? undefined,
    rightId: params.get("b") ?? undefined,
    scenarioId: params.get("s") ?? undefined,
    speed: speed !== undefined && Number.isFinite(speed) ? speed : undefined,
    ...(cacheMode ? { cacheMode } : {})
  };
}
