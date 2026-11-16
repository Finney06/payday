import { config } from './config.js';
import { createBot } from './bot.js';
import { createWeb } from './web.js';

const bot = createBot();
let botUsername = config.botUsername;

const app = createWeb({ getBotUsername: () => botUsername, bot });
app.listen(config.port, () => console.log(`Payday web running on ${config.baseUrl} (port ${config.port}, ${config.network})`));

if (bot) {
  const me = await bot.api.getMe();
  botUsername = me.username;
  bot.api.setMyCommands([
    { command: 'new', description: 'Create a new invoice' },
    { command: 'invoices', description: 'See who has paid' },
    { command: 'address', description: 'Change your wallet address' },
    { command: 'name', description: 'Change the name clients see' },
    { command: 'help', description: 'How to use Payday' },
  ]).catch(() => {});
  bot.start({ drop_pending_updates: true, onStart: () => console.log(`Telegram bot @${botUsername} is live`) });
}

export { bot };
