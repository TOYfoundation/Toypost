import type { Analysis } from '../shared.ts';
import { matchCaseByRules } from './merge.ts';
export { matchCaseByRules, mergeDeadlines } from './merge.ts';
import type { Config } from '../config.ts';
import { heuristicAnalysis } from './heuristics.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OllamaProvider } from './ollama.ts';

export interface CaseCandidate {
  id: string;
  title: string;
  correspondent: string;
  reference?: string;
}

export interface AnalyzeInput {
  text: string;
  letterDate: string;
  receivedDate?: string;
  /** offene Vorgänge, denen das Dokument zugeordnet werden könnte */
  candidates: CaseCandidate[];
  /** Ergebnis der kostenlosen Regel-Auswertung, als Ausgangspunkt für die KI */
  baseline: Analysis;
}

export interface AnalyzeResult extends Analysis {
  /** Vorgang, dem das Dokument zugeordnet wird, oder undefined für einen neuen Vorgang */
  caseId?: string;
}

export interface DraftInput {
  senderName: string;
  correspondent: string;
  caseTitle: string;
  reference?: string;
  /** neueste Dokumente des Vorgangs, gekürzt */
  documents: { title: string; date: string; text: string }[];
  /** Absicht in Stichworten, z. B. "Fristverlängerung um 4 Wochen erbitten" */
  intent?: string;
  tone: 'sachlich' | 'freundlich' | 'bestimmt';
}

export interface AskSource {
  id: string;
  title: string;
  date: string;
  text: string;
}

export interface TranslateInput {
  subject?: string;
  text: string;
  /** language code from the shared Toy list, e.g. "sw" */
  targetLang: string;
  /** native name, e.g. "Kiswahili" */
  targetLangName: string;
  /** fixed terms of the Toy projects (glossaryHint), may be empty */
  glossary: string;
}

/** Facts for an announcement or notice that ToyPost writes itself (milestone, release, incident, report). */
export interface ComposeInput {
  purpose: 'milestone' | 'release' | 'incident' | 'report' | 'payment_thanks' | 'security_reply';
  /** plain facts, one per line; the model must not add anything */
  facts: string[];
  senderName: string;
  tone: 'sachlich' | 'freundlich' | 'bestimmt';
}

export interface AiProvider {
  readonly name: string;
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
  draft(input: DraftInput): Promise<{ subject: string; body: string }>;
  answer(question: string, sources: AskSource[]): Promise<{ answer: string; sourceIds: string[] }>;
  translate(input: TranslateInput): Promise<{ subject?: string; text: string }>;
  compose(input: ComposeInput): Promise<{ subject: string; body: string }>;
}

const COMPOSE_SUBJECT: Record<ComposeInput['purpose'], (first: string) => string> = {
  milestone: (f) => `Fortschritt: ${f}`,
  release: (f) => `Neue Version: ${f}`,
  incident: (f) => `Wichtig: ${f}`,
  report: (f) => `Bericht: ${f}`,
  payment_thanks: () => 'Zahlung eingegangen – danke!',
  security_reply: () => 'Danke für deine Sicherheitsmeldung',
};

export class MockProvider implements AiProvider {
  readonly name = 'mock';

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    return { ...input.baseline, caseId: matchCaseByRules(input.baseline, input.candidates) };
  }

  async draft(input: DraftInput): Promise<{ subject: string; body: string }> {
    const ref = input.reference ? `\n${input.reference}` : '';
    const intent = input.intent ?? 'Rückmeldung zu Ihrem Schreiben';
    return {
      subject: `${intent} – ${input.caseTitle}${ref ? ` (${input.reference})` : ''}`,
      body: `Sehr geehrte Damen und Herren,${ref}\n\nbezugnehmend auf Ihr Schreiben vom ${input.documents[0]?.date ?? '…'} möchte ich Folgendes mitteilen: ${intent}.\n\nBitte bestätigen Sie mir den Eingang dieses Schreibens.\n\nMit freundlichen Grüßen\n${input.senderName}`,
    };
  }

  /** Without a model nothing is translated; the language tag shows readers and tests what was requested. */
  async translate(input: TranslateInput): Promise<{ subject?: string; text: string }> {
    if (input.targetLang === 'de') return { subject: input.subject, text: input.text };
    return { subject: input.subject ? `[${input.targetLang}] ${input.subject}` : undefined, text: `[${input.targetLang}] ${input.text}` };
  }

  async compose(input: ComposeInput): Promise<{ subject: string; body: string }> {
    return { subject: COMPOSE_SUBJECT[input.purpose](input.facts[0] ?? ''), body: `${input.facts.join('\n')}\n\n${input.senderName}` };
  }

  async answer(question: string, sources: AskSource[]): Promise<{ answer: string; sourceIds: string[] }> {
    if (!sources.length) return { answer: 'Dazu habe ich in deinen Dokumenten nichts gefunden.', sourceIds: [] };
    const top = sources[0];
    return {
      answer: `Am ehesten passt „${top.title}“ vom ${top.date}. Öffne das Dokument für die Details.`,
      sourceIds: [top.id],
    };
  }
}

export function createAiProvider(config: Config): AiProvider {
  switch (config.aiProvider) {
    case 'anthropic':
      return new AnthropicProvider(config.anthropicApiKey, config.modelFast, config.modelSmart);
    case 'ollama':
      return new OllamaProvider(config.ollamaUrl, config.ollamaModel);
    default:
      return new MockProvider();
  }
}

export { heuristicAnalysis };
