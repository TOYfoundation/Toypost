import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const { server, ctx } = createApp(config);

server.listen(config.port, () => {
  ctx.log(`API läuft auf ${config.publicUrl} (KI: ${ctx.ai.name}, Zahlung: ${ctx.payments.id})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      ctx.db.close();
      process.exit(0);
    });
  });
}
