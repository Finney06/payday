# Payday

**Send an invoice from a chat. Get paid in dollars on Bitcoin Cash.**

Payday is a Telegram bot + web pay page for freelancers. You type
`invoice Sarah $50 logo design` in Telegram, get a pay link, and forward it to your client on WhatsApp or anywhere.
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

## What if something goes wrong?

Payday is a direct payment, like a bank transfer: the client's wallet pays the freelancer's wallet.
Payday never holds the money, so most "what ifs" come down to that. Each answer below is what the code does today.

| What happens | What Payday does |
|---|---|
| **The client pays less than the invoice** | The server checks the signed payment before it is sent. If it pays the freelancer less than the invoice (ParyonUSD to the cent; BCH within 1% of the locked quote), it is refused and never broadcast. The client keeps their money. |
| **The payment isn't for this invoice** | Every Payday payment carries an `OP_RETURN` tag, `PAYDAY <invoice id>`. A transaction without the tag for *this* invoice is refused. |
| **The same payment is used twice, or the invoice is paid twice** | A transaction id can only mark one invoice paid, and a paid invoice refuses new payments. |
| **The BCH price moves while the client pays** | The BCH amount is locked for 20 minutes. ParyonUSD is a dollar stablecoin, so a $50 invoice is always 50.00 PUSD. |
| **The client's wallet doesn't have enough** | The pay page checks the balance first. If there's enough of the other currency (BCH or PUSD), it offers to switch. If the wallet is empty, it says so, and nothing is sent. |
| **The client cancels in their wallet** | "Payment cancelled in the wallet. Nothing was sent." They can try again. |
| **The network rejects the transaction** | The invoice stays Unpaid, the client sees the reason, and the money never left their wallet. |
| **The client pays from another phone** | An open pay page checks every 10 seconds and switches to the Paid receipt by itself. |
| **Payday's website or server goes down** | Money that was already paid is in the freelancer's own wallet, and each payment is public on the blockchain with its `PAYDAY` tag. Nobody needs Payday to get their money out. |
| **The freelancer loses their phone** | The money is in their own wallet (for example Paytaca), recovered with their 12 words. Payday has no keys and no balance. |
| **The client wants a refund** | Blockchain payments can't be reversed by anyone, Payday included. The freelancer refunds from their own wallet, as with cash or a bank transfer. |
| **The work isn't delivered** | Payday doesn't hold money in the middle (no escrow), so it's the same trust as an ordinary invoice. Escrow with a fair way to settle disputes is on the roadmap, not in this version. |

**Honest limits**
- The client needs a WizardConnect wallet (Paytaca, Selene…) with BCH or ParyonUSD. Paying by card or bank isn't supported.
- If the server stops in the second between broadcasting a payment and saving it, the money still arrives, but the invoice can show Unpaid. The transaction (with its `PAYDAY` tag) on the explorer is the proof.
- Paytaca shows a payment in its balance once it confirms, so the bot may say "paid" a few minutes before the wallet balance changes.

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
