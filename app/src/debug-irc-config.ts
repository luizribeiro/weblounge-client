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
): DebugIrcConfig | null {
  if (
    mode === "production" &&
    environment.WEBLOUNGE_IRC_PASSWORD !== undefined
  ) {
    throw new Error(
      "WEBLOUNGE_IRC_PASSWORD must not be set for production builds",
    );
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
