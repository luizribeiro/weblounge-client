import { expect, it } from "vitest";
import { migrateDraft, readDraft, writeDraft } from "./draft-storage";

it("guards unavailable session storage", () => {
  const unavailable = {
    get length(): number {
      throw new DOMException("blocked");
    },
    getItem: () => {
      throw new DOMException("blocked");
    },
    key: () => null,
    removeItem: () => {
      throw new DOMException("blocked");
    },
    setItem: () => {
      throw new DOMException("blocked");
    },
    clear: () => undefined,
  } satisfies Storage;

  expect(readDraft("blocked", unavailable)).toBe("");
  expect(() => writeDraft("blocked", "text", unavailable)).not.toThrow();
});

it("caps individual drafts and total draft storage", () => {
  writeDraft("too-large", "x".repeat(32_769));
  expect(readDraft("too-large")).toBe("");

  sessionStorage.setItem("weblounge:draft:existing", "x".repeat(250_000));
  writeDraft("over-total", "x".repeat(20_000));
  expect(readDraft("over-total")).toBe("");
});

it("moves a nick-keyed draft to an account identity without overwriting", () => {
  writeDraft("nick:alice", "hello");
  migrateDraft("nick:alice", "account:alice");
  expect(readDraft("nick:alice")).toBe("");
  expect(readDraft("account:alice")).toBe("hello");

  writeDraft("nick:alice-phone", "from phone");
  writeDraft("account:alice", "existing");
  migrateDraft("nick:alice-phone", "account:alice");
  expect(readDraft("nick:alice-phone")).toBe("");
  expect(readDraft("account:alice")).toBe("existing");
});
