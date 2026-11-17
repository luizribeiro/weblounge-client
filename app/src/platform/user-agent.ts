// Reported for debugging only; platform decisions use the platform environment.
export function userAgent(scope: Pick<Window, "navigator"> = window): string {
  return scope.navigator.userAgent;
}
