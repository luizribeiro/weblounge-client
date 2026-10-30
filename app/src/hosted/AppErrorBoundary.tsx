import { ErrorBoundary, type JSX } from "solid-js";
import { HostedStatus } from "./HostedStatus";

export const renderFailureMessage = "Something went wrong. Reload to continue.";

export function AppErrorBoundary(props: { children: JSX.Element }) {
  return (
    <ErrorBoundary
      fallback={(error: unknown) => {
        console.error(error);
        return <HostedStatus message={renderFailureMessage} error />;
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}
