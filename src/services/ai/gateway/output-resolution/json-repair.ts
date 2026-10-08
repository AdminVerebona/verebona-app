/**
 * Lecture d'une sortie modèle : parsing strict, puis extraction et
 * réparation JSON DÉTERMINISTES — lot 33D (ticket « réussite malgré les
 * désalignements », §6, §7 ; étapes 2 et 3 de la résolution progressive).
 *
 * Réparations permises (aucune n'invente une donnée) :
 *   · bloc Markdown ```json … ``` ;
 *   · texte avant / après la structure JSON ;
 *   · virgule finale avant `}` ou `]` ;
 *   · guillemets typographiques employés comme délimiteurs JSON (“ ” „) ;
 *   · commentaires `//` et `/* … *\/` hors chaînes ;
 *   · littéraux Python `True` / `False` / `None` hors chaînes ;
 *   · JSON encodé dans une chaîne (`"{\"task\": …}"`).
 * Interdit : refermer une structure incomplète (sortie tronquée) — ce
 * serait fabriquer une fin de document.
 */
import type { OutputRepairStep } from '../diagnostics/taxonomy';

export type ParseOutcome =
  | {
    ok: true;
    value: unknown;
    /** `JSON.parse` du texte brut a réussi tel quel. */
    strict: boolean;
    /** Texte JSON réellement parsé, s'il diffère de la réponse brute. */
    extracted: string | null;
    repairs: OutputRepairStep[];
  }
  | {
    ok: false;
    empty: boolean;
    /** Structure ouverte jamais refermée (sortie vraisemblablement coupée). */
    incomplete: boolean;
    error: string;
    extracted: string | null;
    repairs: OutputRepairStep[];
  };

const step = (stage: OutputRepairStep['stage'], rule: string, detail?: string): OutputRepairStep =>
  ({ stage, rule, path: '$', ...(detail ? { detail } : {}) });

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Première structure équilibrée à partir de `start` ; `null` si jamais refermée. */
export function balancedSlice(text: string, start: number): string | null {
  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return c === closing ? text.slice(start, i + 1) : null;
    }
  }
  return null;
}

/**
 * Réparations syntaxiques hors chaînes : virgules finales, commentaires,
 * littéraux Python. Rend le texte et les règles appliquées.
 */
export function repairJsonSyntax(text: string): { text: string; rules: string[] } {
  const rules = new Set<string>();
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    // Commentaires.
    if (c === '/' && text[i + 1] === '/') {
      const fin = text.indexOf('\n', i);
      i = fin === -1 ? text.length : fin - 1;
      rules.add('json_comment_removed');
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const fin = text.indexOf('*/', i + 2);
      i = fin === -1 ? text.length : fin + 1;
      rules.add('json_comment_removed');
      continue;
    }
    // Virgule finale.
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { rules.add('trailing_comma_removed'); continue; }
    }
    // Littéraux Python (mot entier, hors chaîne).
    const mot = /^(True|False|None)\b/.exec(text.slice(i, i + 6));
    if (mot && !/[\w$]/.test(text[i - 1] ?? '')) {
      out += mot[1] === 'True' ? 'true' : mot[1] === 'False' ? 'false' : 'null';
      i += mot[1].length - 1;
      rules.add('python_literal_converted');
      continue;
    }
    out += c;
  }
  return { text: out, rules: [...rules] };
}

/** Guillemets typographiques employés comme délimiteurs (aucun guillemet droit présent). */
function straightenQuotes(text: string): string | null {
  if (text.includes('"') || !/[“”„]/.test(text)) return null;
  return text.replace(/[“”„]/g, '"');
}

/**
 * Lit la sortie d'un modèle. Ordre : strict, bloc de code, structure
 * équilibrée dans le texte, réparations syntaxiques ; chaque étape franchie
 * est tracée dans `repairs`.
 */
export function parseModelOutput(raw: string): ParseOutcome {
  const repairs: OutputRepairStep[] = [];
  const brut = String(raw ?? '').replace(/^﻿/, '');
  if (brut.trim() === '') return { ok: false, empty: true, incomplete: false, error: 'Réponse vide', extracted: null, repairs };

  const strict = tryParse(brut.trim());
  if (strict.ok) return finish(strict.value, true, null, repairs);

  // Bloc de code Markdown.
  let candidate = brut.trim();
  const fenced = /```(?:json|JSON)?\s*([\s\S]+?)```/.exec(brut);
  if (fenced) {
    candidate = fenced[1].trim();
    repairs.push(step('json_extraction', 'markdown_fence_removed'));
    const p = tryParse(candidate);
    if (p.ok) return finish(p.value, false, candidate, repairs);
  }

  // Texte autour de la structure.
  const start = candidate.search(/[[{]/);
  if (start === -1) {
    return { ok: false, empty: false, incomplete: false, error: 'Aucune structure JSON détectée', extracted: null, repairs };
  }
  const slice = balancedSlice(candidate, start);
  if (slice === null) {
    // Peut-être réparable syntaxiquement (guillemets typographiques), jamais refermé artificiellement.
    const quotes = straightenQuotes(candidate.slice(start));
    const re = quotes ? balancedSlice(quotes, 0) : null;
    if (re) {
      const p = tryParse(repairJsonSyntax(re).text);
      if (p.ok) {
        repairs.push(step('json_repair', 'typographic_quotes_straightened'));
        return finish(p.value, false, re, repairs);
      }
    }
    return { ok: false, empty: false, incomplete: true, error: 'Structure JSON incomplète', extracted: candidate.slice(start), repairs };
  }
  if (start > 0 || slice.length < candidate.length) repairs.push(step('json_extraction', 'text_around_json_removed'));
  const direct = tryParse(slice);
  if (direct.ok) return finish(direct.value, false, slice, repairs);

  // Réparations syntaxiques déterministes.
  let texte = slice;
  const quotes = straightenQuotes(texte);
  if (quotes) { texte = quotes; repairs.push(step('json_repair', 'typographic_quotes_straightened')); }
  const syntax = repairJsonSyntax(texte);
  for (const r of syntax.rules) repairs.push(step('json_repair', r));
  const repaired = tryParse(syntax.text);
  if (repaired.ok) return finish(repaired.value, false, syntax.text, repairs);
  return { ok: false, empty: false, incomplete: false, error: repaired.error, extracted: slice, repairs };
}

/** JSON encodé dans une chaîne : décodé une fois. */
function finish(value: unknown, strict: boolean, extracted: string | null, repairs: OutputRepairStep[]): ParseOutcome {
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      const inner = tryParse(t);
      if (inner.ok) {
        repairs.push(step('json_repair', 'json_string_decoded'));
        return { ok: true, value: inner.value, strict: false, extracted: t, repairs };
      }
    }
  }
  return { ok: true, value, strict, extracted, repairs };
}
