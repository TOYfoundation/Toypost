import type { AiProvider, AnalyzeInput, AnalyzeResult, AskSource, DraftInput } from './provider.ts';
import { mergeDeadlines } from './merge.ts';
import {
  ANALYSIS_SCHEMA,
  ANALYSIS_SYSTEM,
  ASK_SYSTEM,
  DRAFT_SYSTEM,
  analysisUserPrompt,
  askUserPrompt,
  draftUserPrompt,
  parseJsonObject,
} from './prompts.ts';

/** Lokales Modell über Ollama: keine Daten verlassen den eigenen Server. */
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  private async chat(system: string, user: string, format: unknown): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format,
        options: { temperature: 0.1 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`Ollama antwortete mit ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const text = await this.chat(ANALYSIS_SYSTEM.replace('über das Werkzeug record_analysis', 'nur mit JSON nach Schema'), analysisUserPrompt(input), ANALYSIS_SCHEMA);
    const out = parseJsonObject<AnalyzeResult>(text);
    const knownIds = new Set(input.candidates.map((c) => c.id));
    return {
      ...input.baseline,
      ...out,
      deadlines: mergeDeadlines(input.baseline.deadlines, out.deadlines ?? []),
      payment: out.payment ?? input.baseline.payment,
      caseId: out.caseId && knownIds.has(out.caseId) ? out.caseId : undefined,
      confidence: Math.max(0, Math.min(1, out.confidence ?? 0.6)),
    };
  }

  async draft(input: DraftInput): Promise<{ subject: string; body: string }> {
    return parseJsonObject(await this.chat(DRAFT_SYSTEM, draftUserPrompt(input), 'json'));
  }

  async answer(question: string, sources: AskSource[]): Promise<{ answer: string; sourceIds: string[] }> {
    const parsed = parseJsonObject<{ answer: string; sourceIds: string[] }>(await this.chat(ASK_SYSTEM, askUserPrompt(question, sources), 'json'));
    const ids = new Set(sources.map((s) => s.id));
    return { answer: parsed.answer, sourceIds: (parsed.sourceIds ?? []).filter((id) => ids.has(id)) };
  }
}
