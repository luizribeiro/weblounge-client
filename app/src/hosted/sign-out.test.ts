import { expect, it, vi } from "vitest";
import { readDraft, writeDraft } from "../features/composer/draft-storage";
import {
  readLastViewedPath,
  writeLastViewedPath,
} from "../navigation/initial-buffer";
import type { NotificationCenter } from "../platform/push/app-badge";
import { signOutDeadlineMs, signOutDevice } from "./sign-out";
import { isSignedOut } from "./signed-out";

function notificationCenter() {
  const close = vi.fn();
  const writeCounts = vi.fn(async () => undefined);
  const clearAppBadge = vi.fn(async () => undefined);
  const center: NotificationCenter = {
    badge: { clearAppBadge },
    registrations: {
      getRegistration: async () => ({
        getNotifications: async () => [
          { data: { conversationTag: "weblounge/#lounge" }, close },
        ],
      }),
    },
    writeCounts,
  };
  return { center, close, writeCounts, clearAppBadge };
}

it("forgets the member's chats, withdraws notifications and stays signed out", async () => {
  writeLastViewedPath("/weblounge/%23lounge");
  writeDraft("channel:#lounge", "see you all at 5");
  localStorage.setItem("weblounge.inline-image-sizes", "{}");
  const notifications = notificationCenter();
  const endSession = vi.fn(async () => undefined);

  await signOutDevice({
    endSession,
    notifications: notifications.center,
    deviceStorage: localStorage,
    sessionStorage,
  });

  expect(endSession).toHaveBeenCalledOnce();
  expect(isSignedOut(localStorage)).toBe(true);
  expect(readLastViewedPath()).toBeUndefined();
  expect(readDraft("channel:#lounge")).toBe("");
  expect(localStorage.getItem("weblounge.inline-image-sizes")).toBeNull();
  expect(notifications.close).toHaveBeenCalledOnce();
  expect(notifications.writeCounts).toHaveBeenCalledWith([]);
  expect(notifications.clearAppBadge).toHaveBeenCalledOnce();
});

it("marks the device signed out before the session ends", async () => {
  let signedOutWhenEnding: boolean | undefined;

  await signOutDevice({
    endSession: async () => {
      signedOutWhenEnding = isSignedOut(localStorage);
    },
    notifications: notificationCenter().center,
    deviceStorage: localStorage,
    sessionStorage,
  });

  expect(signedOutWhenEnding).toBe(true);
});

it("finishes signing out when the session and the notifications fail", async () => {
  const failing: NotificationCenter = {
    badge: {},
    registrations: {
      getRegistration: async () => {
        throw new Error("service worker gone");
      },
    },
    writeCounts: async () => {
      throw new Error("database closed");
    },
  };

  await expect(
    signOutDevice({
      endSession: async () => {
        throw new Error("engine closed");
      },
      notifications: failing,
      deviceStorage: localStorage,
      sessionStorage,
    }),
  ).resolves.toBeUndefined();
  expect(isSignedOut(localStorage)).toBe(true);
});

it("signs out on time when the session never ends", async () => {
  vi.useFakeTimers();
  try {
    localStorage.setItem("weblounge.inline-image-sizes", "{}");
    const signingOut = signOutDevice({
      endSession: () => new Promise<void>(() => {}),
      notifications: notificationCenter().center,
      deviceStorage: localStorage,
      sessionStorage,
    });

    await vi.advanceTimersByTimeAsync(signOutDeadlineMs);

    await expect(signingOut).resolves.toBeUndefined();
    expect(isSignedOut(localStorage)).toBe(true);
    expect(localStorage.getItem("weblounge.inline-image-sizes")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("forgets what the page wrote while the session was ending", async () => {
  await signOutDevice({
    endSession: async () => {
      writeDraft("channel:#lounge", "typed during sign-out");
    },
    notifications: notificationCenter().center,
    deviceStorage: localStorage,
    sessionStorage,
  });

  expect(readDraft("channel:#lounge")).toBe("");
  expect(isSignedOut(localStorage)).toBe(true);
});
