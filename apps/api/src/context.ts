import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Keys } from './security.ts';
import type { AiProvider } from './ai/provider.ts';
import type { PaymentProvider } from './billing/provider.ts';
import type { IntegrationStore } from './integrations/store.ts';
import type { Delivery } from './services/delivery.ts';
import type { ChannelStore } from './channels/store.ts';

export interface Context {
  config: Config;
  db: Db;
  keys: Keys;
  ai: AiProvider;
  payments: PaymentProvider;
  integrations: IntegrationStore;
  delivery: Delivery;
  channels: ChannelStore;
  /** Zeitquelle, in Tests überschreibbar */
  now: () => Date;
  log: (msg: string, extra?: unknown) => void;
}
