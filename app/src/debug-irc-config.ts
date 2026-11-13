export interface DebugIrcConfig {
  endpoint: string;
  nickname: string;
  account: string;
  channel: string;
  allowInsecure: boolean;
}

export interface DebugConnection {
  readonly password: string;
  readonly additionalAutojoin: readonly string[];
  readonly account?: string;
  readonly nickname?: string;
  readonly channel?: string;
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

export function consumeDebugConnection(
  url: URL,
  replace: (path: string) => void,
): DebugConnection | null {
  const password = url.searchParams.get("irc-password");
  if (password === null) return null;
  const additionalAutojoin = url.searchParams
    .getAll("irc-autojoin")
    .filter((channel) => channel !== "");
  const account = nonempty(url.searchParams.get("irc-account"));
  const nickname = nonempty(url.searchParams.get("irc-nickname"));
  const channel = nonempty(url.searchParams.get("irc-channel"));
  for (const name of [
    "irc-password",
    "irc-autojoin",
    "irc-account",
    "irc-nickname",
    "irc-channel",
  ])
    url.searchParams.delete(name);
  replace(`${url.pathname}${url.search}${url.hash}`);
  return {
    password,
    additionalAutojoin,
    ...(account === undefined ? {} : { account }),
    ...(nickname === undefined ? {} : { nickname }),
    ...(channel === undefined ? {} : { channel }),
  };
}

function nonempty(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

export function debugAutojoin(
  connection: DebugConnection,
  defaultChannel: string,
): string[] {
  const channel = connection.channel ?? defaultChannel;
  return [
    channel,
    ...connection.additionalAutojoin.filter((joined) => joined !== channel),
  ];
}
