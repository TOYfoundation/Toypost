import type { AiProvider, AnalyzeInput, AnalyzeResult, AskSource, ComposeInput, DraftInput, TranslateInput } from './provider.ts';
import { mergeDeadlines } from './merge.ts';
import {
  ANALYSIS_SCHEMA,
  ANALYSIS_SYSTEM,
  ASK_SYSTEM,
  DRAFT_SYSTEM,
  analysisUserPrompt,
  askUserPrompt,
  COMPOSE_SYSTEM,
  composeUserPrompt,
  draftUserPrompt,
  parseJsonObject,
  TRANSLATE_SYSTEM,
  translateUserPrompt,
} from './prompts.ts';

/**
 * Claude über die Messages API, ohne SDK.
 * Schnelles Modell (Haiku) für Auswertung und Fragen, stärkeres (Sonnet) für Entwürfe.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly modelFast: string;
  private readonly modelSmart: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, modelFast: string, modelSmart: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.modelFast = modelFast;
    this.modelSmart = modelSmart;
    this.fetchImpl = fetchImpl;
  }

  private async call(body: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Claude API antwortete mit ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.json();
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const data = await this.call({
      model: this.modelFast,
      max_tokens: 1500,
      system: ANALYSIS_SYSTEM,
      tools: [{ name: 'record_analysis', description: 'Speichert die Auswertung des Dokuments.', input_schema: ANALYSIS_SCHEMA }],
      tool_choice: { type: 'tool', name: 'record_analysis' },
      messages: [{ role: 'user', content: analysisUserPrompt(input) }],
    });
    const tool = (data.content as any[]).find((c) => c.type === 'tool_use');
    if (!tool) throw new Error('Claude hat keine Auswertung geliefert.');
    const out = tool.input as AnalyzeResult;
    const knownIds = new Set(input.candidates.map((c) => c.id));
    return {
      ...input.baseline,
      ...out,
      deadlines: mergeDeadlines(input.baseline.deadlines, out.deadlines ?? []),
      payment: out.payment ?? input.baseline.payment,
      caseId: out.caseId && knownIds.has(out.caseId) ? out.caseId : undefined,
      confidence: Math.max(0, Math.min(1, out.confidence ?? 0.7)),
    };
  }

  async draft(input: DraftInput): Promise<{ subject: string; body: string }> {
    const data = await this.call({
      model: this.modelSmart,
      max_tokens: 1500,
      system: DRAFT_SYSTEM,
      messages: [{ role: 'user', content: draftUserPrompt(input) }],
    });
    const text = (data.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return parseJsonObject<{ subject: string; body: string }>(text);
  }

  async answer(question: string, sources: AskSource[]): Promise<{ answer: string; sourceIds: string[] }> {
    const data = await this.call({
      // Fragen laufen auf dem schnellen Modell: 3 Credits müssen auch im günstigsten Paket die KI-Kosten decken.
      model: this.modelFast,
      max_tokens: 600,
      system: ASK_SYSTEM,
      messages: [{ role: 'user', content: askUserPrompt(question, sources) }],
    });
    const text = (data.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const parsed = parseJsonObject<{ answer: string; sourceIds: string[] }>(text);
    const ids = new Set(sources.map((s) => s.id));
    return { answer: parsed.answer, sourceIds: (parsed.sourceIds ?? []).filter((id) => ids.has(id)) };
  }

  private async text(model: string, system: string, user: string, maxTokens: number): Promise<string> {
    const data = await this.call({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
    return (data.content as any[]).filter((c) => c.type === 'text').map((c) => c.text).join('');
  }

  /** Translations run on the fast model: one call per language and message. */
  async translate(input: TranslateInput): Promise<{ subject?: string; text: string }> {
    const out = parseJsonObject<{ subject?: string | null; text: string }>(await this.text(this.modelFast, TRANSLATE_SYSTEM, translateUserPrompt(input), 2000));
    return { subject: out.subject ?? undefined, text: out.text };
  }

  async compose(input: ComposeInput): Promise<{ subject: string; body: string }> {
    return parseJsonObject(await this.text(this.modelSmart, COMPOSE_SYSTEM, composeUserPrompt(input), 1000));
  }
}
