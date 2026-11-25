import { expect, type Locator, type Page } from "@playwright/test";
import { oauthIssuer } from "./fake-oauth-route";
import {
  endedHostedSessions,
  fulfillSessionPreflight,
  fulfillSessionToken,
  installFakeEngine,
  installHostedConfig,
} from "./hosted-fixture";
import { installNativeFeelInstrumentation } from "./native-feel-audit";

const lastViewedKey = "weblounge.navigation.last-viewed";

export interface SignedInMember {
  /** How many times the page asked the members' site for a session token. */
  readonly sessionTokenRequests: () => number;
}

export async function signInMember(page: Page): Promise<SignedInMember> {
  await installNativeFeelInstrumentation(page);
  await installFakeEngine(page);
  const redirectUri = await installHostedConfig(page);
  let sessionTokenRequests = 0;
  await page.route(`${oauthIssuer}/oauth/session-token`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillSessionPreflight(route, new URL(redirectUri()).origin);
      return;
    }
    sessionTokenRequests += 1;
    await fulfillSessionToken(route, redirectUri(), "member-session-token");
  });
  await page.goto("/");
  await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
  return { sessionTokenRequests: () => sessionTokenRequests };
}

export function signedOutScreen(page: Page): Locator {
  return page.locator("[data-initial-splash]");
}

export async function expectSignedOut(
  page: Page,
  member: SignedInMember,
  requestsBefore: number,
): Promise<void> {
  const splash = signedOutScreen(page);
  await expect(splash.getByRole("alert")).toHaveText("You're signed out.");
  await expect(splash.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "#lounge" })).toHaveCount(0);
  expect(member.sessionTokenRequests()).toBe(requestsBefore);
}

export async function expectDeviceForgotTheMember(page: Page): Promise<void> {
  expect(await endedHostedSessions(page)).toEqual([
    { type: "expire_hosted_authentication", network_id: 1 },
  ]);
  expect(
    await page.evaluate(
      (key) => ({
        lastViewed: localStorage.getItem(key),
        drafts: Object.keys(sessionStorage).filter((name) =>
          name.startsWith("weblounge:draft:"),
        ),
      }),
      lastViewedKey,
    ),
  ).toEqual({ lastViewed: null, drafts: [] });
}

export async function signInAgain(page: Page): Promise<void> {
  await signedOutScreen(page).getByRole("button", { name: "Sign in" }).click();
  await expect(signedOutScreen(page)).toHaveCount(0);
}
