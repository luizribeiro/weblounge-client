export function failedStartupRetryCount(
  previous: number,
  retryWasPending: boolean,
): number {
  return retryWasPending ? previous + 1 : 0;
}

export function shouldOfferAppReset(failedRetries: number): boolean {
  return failedRetries >= 2;
}
