import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { startScheduler } from './toy/watchers.ts';

const config = loadConfig();
const { server, ctx } = createApp(config);

const stopScheduler = config.scheduler ? startScheduler(ctx) : () => {};

server.listen(config.port, () => {
  ctx.log(`API läuft auf ${config.publicUrl} (KI: ${ctx.ai.name}, Zahlung: ${ctx.payments.id})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopScheduler();
    server.close(() => {
      ctx.db.close();
      process.exit(0);
    });
  });
}
