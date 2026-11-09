export async function armMessageTime(
  text: string,
  time: number,
): Promise<void> {
  const control =
    process.env.WEBLOUNGE_E2E_FORWARDER_URL ?? "http://127.0.0.1:8091";
  const url = new URL("/rewrite-time", control);
  url.searchParams.set("contains", ` :${text}`);
  url.searchParams.set("time", new Date(time).toISOString());
  const response = await fetch(url, { method: "POST" });
  if (!response.ok)
    throw new Error(`could not arm time rewrite: ${response.status}`);
}
