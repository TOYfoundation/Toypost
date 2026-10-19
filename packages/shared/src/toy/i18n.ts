import { TOY_GLOSSARY, TOY_LANGUAGES, type ToyLanguage } from './i18n-data.ts';

/** Language of the reader, falling back to English like the Toy apps (decision 103). */
export function toyLanguage(code: string | undefined): ToyLanguage {
  const c = (code ?? '').toLowerCase().split(/[-_]/)[0];
  return TOY_LANGUAGES.find((l) => l.code === c) ?? TOY_LANGUAGES.find((l) => l.code === 'en')!;
}

export function isRtl(code: string | undefined): boolean {
  return toyLanguage(code).dir === 'rtl';
}

/**
 * Glossary lines for an AI prompt, so that texts use the same words as wallet, TOYPAY app and ToyScan
 * (e.g. "Aktivierungs-Pfand" / "activation deposit"). Only terms that occur in the source text are included.
 */
export function glossaryHint(sourceText: string): string {
  const lower = sourceText.toLowerCase();
  const used = TOY_GLOSSARY.filter((g) => lower.includes(g.de.toLowerCase()) || lower.includes(g.en.toLowerCase()));
  if (!used.length) return '';
  return (
    'Feste Begriffe der Toy-Projekte (immer so übersetzen, Erklärung in Klammern nur für dich):\n' +
    used.map((g) => `- ${g.de} = ${g.en} (${g.explanationDe})`).join('\n')
  );
}
