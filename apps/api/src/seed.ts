/**
 * Legt ein Demo-Konto mit Beispiel-Post an: demo@toypost.app / toypost-demo-2026
 * Die Briefe laufen durch dieselbe Verarbeitung wie echte Post.
 */
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { createAccountWithOwner, getAccountRow } from './services/accounts.ts';
import { ingestDocument } from './services/pipeline.ts';
import { addDays, DEMO_LETTERS, todayIso } from './shared.ts';
import { addPurchasedCredits } from './services/credits.ts';

const config = loadConfig();
const { ctx } = createApp(config);
const { db } = ctx;

const email = 'demo@toypost.app';
const existing = db.prepare('SELECT account_id FROM users WHERE email = ?').get(email) as { account_id: string } | undefined;
if (existing) {
  console.log(`Demo-Konto gibt es schon (${email}).`);
  process.exit(0);
}

const { accountId } = createAccountWithOwner(db, { name: 'Alex Beispiel', email, password: 'toypost-demo-2026', accountName: 'Haushalt Beispiel' });
db.prepare(`UPDATE accounts SET plan = 'pro' WHERE id = ?`).run(accountId);
addPurchasedCredits(db, accountId, 100, 'seed');

const today = todayIso();
for (const letter of DEMO_LETTERS) {
  const letterDate = addDays(today, -letter.daysAgo);
  const result = await ingestDocument(ctx, getAccountRow(db, accountId), null, {
    text: letter.text(letterDate),
    title: letter.title,
    letterDate,
    channel: letter.channel,
    pages: 1,
    sizeBytes: 180_000,
  });
  db.prepare('UPDATE cases SET title = ?, correspondent = ?, summary = ?, next_action = ?, status = ?, follow_up_on = ? WHERE id = ?').run(
    letter.title,
    letter.correspondent,
    letter.summary,
    letter.nextAction ?? null,
    letter.status,
    letter.followUpInDays !== undefined ? addDays(today, letter.followUpInDays) : null,
    result.caseId,
  );
}
await ctx.delivery.settle();
console.log(`Demo-Konto angelegt: ${email} / toypost-demo-2026 (${DEMO_LETTERS.length} Vorgänge)`);
