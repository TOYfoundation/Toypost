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

export interface AiProvider {
  readonly name: string;
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
  draft(input: DraftInput): Promise<{ subject: string; body: string }>;
  answer(question: string, sources: AskSource[]): Promise<{ answer: string; sourceIds: string[] }>;
}

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
