export interface Config {
  port: number;
  publicUrl: string;
  appOrigins: string[];
  secret: string;
  databasePath: string;
  filesPath: string;
  aiProvider: 'mock' | 'anthropic' | 'ollama';
  anthropicApiKey: string;
  modelFast: string;
  modelSmart: string;
  ollamaUrl: string;
  ollamaModel: string;
  paymentProvider: string;
  production: boolean;
  /** Eigene Installation: neue Konten erhalten alle Funktionen (Enterprise), kein Bezahlvorgang nötig */
  selfHosted: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const selfHosted = ['1', 'true', 'ja'].includes(String(env.SELF_HOSTED ?? '').toLowerCase());
  const secret = env.DOKUFY_SECRET ?? (production ? '' : 'nur-fuer-die-entwicklung-nicht-produktiv-nutzen');
  if (secret.length < 32) {
    throw new Error('DOKUFY_SECRET fehlt oder ist kürzer als 32 Zeichen.');
  }
  const aiProvider = (env.AI_PROVIDER ?? 'mock') as Config['aiProvider'];
  if (!['mock', 'anthropic', 'ollama'].includes(aiProvider)) {
    throw new Error(`AI_PROVIDER "${aiProvider}" ist unbekannt. Erlaubt: mock, anthropic, ollama.`);
  }
  if (aiProvider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new Error('AI_PROVIDER=anthropic braucht ANTHROPIC_API_KEY.');
  }
  return {
    port: Number(env.PORT ?? 8787),
    publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`,
    appOrigins: (env.APP_ORIGIN ?? '*').split(',').map((s) => s.trim()),
    secret,
    databasePath: env.DATABASE_PATH ?? './data/dokufy.sqlite',
    filesPath: env.FILES_PATH ?? './data/files',
    aiProvider,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    modelFast: env.AI_MODEL_FAST ?? 'claude-haiku-5-5',
    modelSmart: env.AI_MODEL_SMART ?? 'claude-sonnet-5-5',
    ollamaUrl: env.OLLAMA_URL ?? 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL ?? 'qwen3:8b',
    paymentProvider: env.PAYMENT_PROVIDER ?? (selfHosted ? 'none' : 'dev'),
    production,
    selfHosted,
  };
}
