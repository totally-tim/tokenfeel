export interface RaceSetupResetState {
  leftStarted: boolean;
  rightStarted: boolean;
}

export function raceNeedsSetupReset({ leftStarted, rightStarted }: RaceSetupResetState): boolean {
  return leftStarted || rightStarted;
}

// The pickers collapse at Start and stay collapsed after the finish, so the
// result keeps the height the race had. Edit setup, Stop or a setup change
// brings them back.
export function raceSetupCollapsed({ started, setupOpen }: { started: boolean; setupOpen: boolean }): boolean {
  return started && !setupOpen;
}
