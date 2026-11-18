// Render's free plan sleeps after 15 minutes without incoming traffic, which also stops the Telegram bot.
// While the server is up, it requests its own public address so it never goes idle.
export function startKeepAwake(baseUrl, everyMs = 10 * 60 * 1000) {
  if (!baseUrl.startsWith('https://')) return null; // local development: nothing to keep awake
  const ping = async () => {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) console.error(`Keep-awake ping returned ${res.status}`);
    } catch (err) {
      console.error(`Keep-awake ping failed: ${err.message}`);
    }
  };
  const timer = setInterval(ping, everyMs);
  timer.unref();
  return timer;
}
