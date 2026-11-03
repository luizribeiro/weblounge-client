export const BETA_CONTENT_SECURITY_POLICY = [
  "base-uri 'none'",
  "connect-src 'self' wss://beta.weblounge.org/socket https://members.weblounge.org https://files.weblounge.org/upload https://push.weblounge.org",
  "default-src 'none'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "manifest-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "worker-src 'self'",
].join("; ");
