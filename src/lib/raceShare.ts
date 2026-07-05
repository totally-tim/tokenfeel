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
  const [, query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const speed = Number(params.get("speed"));
  const rawCacheMode = params.get("cache");
  const cacheMode = rawCacheMode === "on" || rawCacheMode === "off" || rawCacheMode === "runtime" ? rawCacheMode : undefined;

  return {
    leftId: params.get("a") ?? undefined,
    rightId: params.get("b") ?? undefined,
    scenarioId: params.get("s") ?? undefined,
    speed: Number.isFinite(speed) ? speed : undefined,
    ...(cacheMode ? { cacheMode } : {})
  };
}
