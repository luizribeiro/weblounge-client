export const scopeCookieName = "weblounge-e2e-scope";

const headerEnding = Buffer.from("\r\n\r\n");

export function upgradeRequestScope(head) {
  const end = head.indexOf(headerEnding);
  if (end < 0) return undefined;
  for (const line of head.subarray(0, end).toString().split("\r\n")) {
    const separator = line.indexOf(":");
    if (line.slice(0, separator).trim().toLowerCase() !== "cookie") continue;
    for (const cookie of line.slice(separator + 1).split(";")) {
      const [name, ...value] = cookie.trim().split("=");
      if (name === scopeCookieName) return value.join("=");
    }
  }
  return null;
}

export function inScope(connectionScope, requestedScope) {
  return requestedScope === null || connectionScope === requestedScope;
}

export class ScopedFlag {
  #everywhere = false;
  #scopes = new Set();

  set(scope, enabled) {
    if (scope === null) this.#everywhere = enabled;
    else if (enabled) this.#scopes.add(scope);
    else this.#scopes.delete(scope);
  }

  has(scope) {
    return this.#everywhere || (scope !== null && this.#scopes.has(scope));
  }
}
