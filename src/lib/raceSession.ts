export interface RaceSetupResetState {
  leftStarted: boolean;
  rightStarted: boolean;
}

export function raceNeedsSetupReset({ leftStarted, rightStarted }: RaceSetupResetState): boolean {
  return leftStarted || rightStarted;
}
