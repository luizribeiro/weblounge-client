interface PolicySources {
  readonly connect: readonly string[];
  readonly images: readonly string[];
}

function contentSecurityPolicy(sources: PolicySources): string {
  return [
    "base-uri 'none'",
    ["connect-src 'self'", ...sources.connect].join(" "),
    "default-src 'none'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ["img-src 'self'", ...sources.images].join(" "),
    "manifest-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "worker-src 'self'",
  ].join("; ");
}

const betaFilehost = "https://files.weblounge.org";

// Mirrors the hosted beta's server-side policy; the e2e preview serves it with
// the fake file host added so browser specs catch policy violations.
const betaSources: PolicySources = {
  connect: [
    "wss://beta.weblounge.org/socket",
    "https://members.weblounge.org",
    `${betaFilehost}/upload`,
    "https://push.weblounge.org",
  ],
  images: ["blob:", betaFilehost],
};

// Local Ergo advertises this as FILEHOST (nix/ergo.nix), and
// e2e/fake-filehost-server.mjs serves it.
export const E2E_FILEHOST_ORIGIN = "https://127.0.0.1:4175";
// The same fake host under a name that is not the IRC endpoint's site, for the specs that
// rewrite the advertised FILEHOST to it.
export const E2E_FOREIGN_FILEHOST_ORIGIN = "https://localhost:4175";

const e2eFilehosts = [E2E_FILEHOST_ORIGIN, E2E_FOREIGN_FILEHOST_ORIGIN];

export const E2E_CONTENT_SECURITY_POLICY = contentSecurityPolicy({
  connect: [
    ...betaSources.connect,
    ...e2eFilehosts.map((origin) => `${origin}/upload`),
  ],
  images: [...betaSources.images, ...e2eFilehosts],
});
