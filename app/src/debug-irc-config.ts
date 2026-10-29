export interface DebugIrcConfig {
  endpoint: string;
  nickname: string;
  account: string;
  channel: string;
  allowInsecure: boolean;
}

type DebugEnvironment = Readonly<Record<string, string | undefined>>;

export function buildDebugIrcConfig(
  mode: string,
  environment: DebugEnvironment,
  allowProductionTestHarness = false,
): DebugIrcConfig | null {
  if (
    mode === "production" &&
    !allowProductionTestHarness &&
    hasDebugValue(environment)
  ) {
    throw new Error("WEBLOUNGE_IRC_* is unavailable in production builds");
  }
  const endpoint = environment.WEBLOUNGE_IRC_ENDPOINT;
  if (endpoint === undefined) return null;
  return {
    endpoint,
    nickname: environment.WEBLOUNGE_IRC_NICKNAME ?? "weblounge",
    account: environment.WEBLOUNGE_IRC_ACCOUNT ?? "weblounge",
    channel: environment.WEBLOUNGE_IRC_CHANNEL ?? "#weblounge-test",
    allowInsecure: endpoint.startsWith("ws://127.0.0.1"),
  };
}

function hasDebugValue(environment: DebugEnvironment): boolean {
  return Object.entries(environment).some(
    ([key, value]) => key.startsWith("WEBLOUNGE_IRC_") && value !== undefined,
  );
}

export function consumeDebugPassword(
  url: URL,
  replace: (path: string) => void,
): string | null {
  const password = url.searchParams.get("irc-password");
  if (password === null) return null;
  url.searchParams.delete("irc-password");
  replace(`${url.pathname}${url.search}${url.hash}`);
  return password;
}
