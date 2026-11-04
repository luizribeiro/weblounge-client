import { ErrorBoundary, type JSX } from "solid-js";
import { t } from "../strings";
import { HostedStatus } from "./HostedStatus";

export const renderFailureMessage = t("shell.unexpected_failure");

export function AppErrorBoundary(props: { children: JSX.Element }) {
  return (
    <ErrorBoundary
      fallback={(error: unknown, reset) => {
        console.error(error);
        return (
          <HostedStatus message={renderFailureMessage} error onRetry={reset} />
        );
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}
