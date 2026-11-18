import { config } from './config.js';
import { createBot, setBotProfile, notifyPaid } from './bot.js';
import { createWeb } from './web.js';
import { startKeepAwake } from './keep-awake.js';

const bot = createBot();
let botUsername = config.botUsername;

const app = createWeb({ getBotUsername: () => botUsername, onPaid: (inv) => notifyPaid(bot, inv) });
const server = app.listen(config.port, () => console.log(`Payday web running on ${config.baseUrl} (port ${config.port}, ${config.network})`));
startKeepAwake(config.baseUrl);

// Long polling. During a redeploy the old and new servers overlap for a moment and Telegram
// answers "409 Conflict" to one of them, so keep retrying instead of giving up.
async function startBot() {
  for (;;) {
    try {
      await bot.start({ drop_pending_updates: true, onStart: () => console.log(`Telegram bot @${botUsername} is live`) });
      return; // stopped on purpose
    } catch (err) {
      console.error(`Bot polling stopped (${err.description || err.message}); retrying in 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

if (bot) {
  try {
    const me = await bot.api.getMe();
    botUsername = me.username;
    setBotProfile(bot);
  } catch (err) {
    console.error('Telegram getMe failed:', err.message);
  }
  startBot();
}

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  try { await bot?.stop(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
