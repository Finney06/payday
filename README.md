# Payday

**Send an invoice from a chat. Get paid in dollars on Bitcoin Cash.**

Payday is a Telegram bot + web pay page for freelancers. You type
`invoice Ayo $50 logo design` in Telegram, get a pay link, and forward it to your client on WhatsApp or anywhere.
Your client opens the link, connects their wallet, and pays in **ParyonUSD** (a BCH dollar stablecoin) or **BCH**,
straight into your own wallet. The bot tells you the moment you're paid.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/bchblaze2026/detail).

## Why
Freelancers in places like Nigeria lose money and time getting paid by overseas clients.
Payday makes an invoice as easy as sending a chat message, and payment as easy as one tap.
It's **non-custodial**: Payday never holds anyone's money.

## Features
- Telegram bot: create invoices in one line or by answering 3 questions, priced in $, £ or ₦
- Share buttons for WhatsApp and Telegram
- `/invoices`: see who has paid and what you're still owed, with one-tap polite reminders
- Pay page: clean, mobile-first, pay in ParyonUSD or BCH via WizardConnect
- Instant "✅ paid" notification in Telegram with blockchain proof
- Web invoice creator for people without Telegram

## Run locally
```bash
npm install
cp .env.example .env   # add your BOT_TOKEN from @BotFather
npm start
```
Requires Node.js 22+ (uses the built-in `node:sqlite`).

## Tech
Node.js, [grammY](https://grammy.dev) (Telegram), Express, SQLite, [Libauth](https://libauth.org),
[WizardConnect](https://gitlab.com/riftenlabs/lib/wizardconnect) for wallet connection.

## License
MIT
