/**
 * Branche ANSWER du master T2 — variables et traduction de la sortie.
 * CDC 15 §24, T2-31, T2-35, T2-36.
 *
 *   · `t2MasterVariables` : un emplacement par variable du master, celles des
 *     autres branches à `null` (le rendu refuse un emplacement sans valeur) ;
 *   · {{INTENT}} = le CODE d'intention seul (T2-36) : aucune consigne en
 *     langue naturelle concaténée — la longueur est une règle serveur
 *     (`answer-format.ts`) ;
 *   · {{SOURCES}} = sources STRUCTURÉES (JSON) : id, type, titre, contenu
 *     borné, et pour une source de champ (`asset_field:<id>:<clé>`, X) sa
 *     valeur, son origine et son conflit ouvert — ce que B2/B3 exploitent ;
 *   · `t2AnswerLines` : les trois formats (`claims`, `comparison`,
 *     `timeline`) ramenés à des LIGNES sourcées, contrôlées ensuite comme les
 *     affirmations historiques ; la chronologie garde sa structure
 *     (`events[]`, T2-35) au lieu d'un `join` de phrases.
 */
import type { RetrievedSource } from '@/services/verebona-assistant/types/sources';
import { T2_MASTER_VARIABLES } from '@/services/ai/registry/operations';
import type { T2AnswerOutput, T2ClaimSupport, T2Mode } from './t2-contract';

export type T2Variable = (typeof T2_MASTER_VARIABLES)[number];

/** Variables complètes d'une branche : celles fournies, `null` pour les autres. */
export function t2MasterVariables(_mode: T2Mode, values: Partial<Record<T2Variable, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of T2_MASTER_VARIABLES) out[v] = values[v] ?? null;
  return out;
}

const esc = (t: unknown) => String(t ?? '').replace(/</g, '&lt;');

/** Métadonnées transmises au modèle (jamais d'identifiant technique inutile). */
const META_KEYS = ['value', 'display', 'unit', 'origin', 'updatedAt', 'openConflict', 'date', 'status', 'provenance'] as const;

/**
 * Sources structurées pour {{SOURCES}} — ordre CONSERVÉ (B10 : la
 * chronologie fournie n'est pas réordonnée). Le contenu est déjà masqué
 * (§29.4) et borné (§13.9) par l'appelant.
 */
export function formatT2Sources(sources: readonly RetrievedSource[]): string {
  return JSON.stringify(sources.map((s) => {
    const meta: Record<string, unknown> = {};
    for (const k of META_KEYS) {
      const v = s.meta?.[k];
      if (v !== undefined && v !== null && v !== '') meta[k] = typeof v === 'string' ? esc(v) : v;
    }
    return {
      sourceId: s.id, type: s.type, title: esc(s.title), content: esc(s.content),
      ...(Object.keys(meta).length ? { data: meta } : {}),
    };
  }), null, 1);
}

/** Cible(s) résolue(s) par le serveur (référence de la demande, biens des sources de champ). */
export function formatResolvedTargets(
  reference: { type: string; id: number; label?: string | null } | undefined,
  sources: readonly RetrievedSource[],
): string {
  const cibles: Array<{ type: string; id: string; label?: string }> = [];
  if (reference) cibles.push({ type: reference.type, id: `${reference.type}:${reference.id}`, ...(reference.label ? { label: esc(reference.label) } : {}) });
  const vus = new Set(cibles.map((c) => c.id));
  for (const s of sources) {
    const assetId = s.meta?.assetId;
    if (s.type === 'asset_field' && assetId !== undefined && assetId !== null) {
      const id = `asset:${assetId}`;
      if (!vus.has(id)) { vus.add(id); cibles.push({ type: 'asset', id }); }
    }
  }
  return cibles.length ? JSON.stringify(cibles) : '(aucune cible résolue par le serveur)';
}

/** Ligne sourcée issue de la sortie ANSWER, contrôlée ensuite par le serveur. */
export interface T2AnswerLine {
  text: string;
  sourceIds: string[];
  factual?: boolean;
  derivation?: 'direct' | 'calculated' | 'synthesized';
  support?: T2ClaimSupport;
  /** Événement d'origine (format `timeline`). */
  event?: { date: string | null; text: string };
}

export interface T2AnswerLines {
  lines: T2AnswerLine[];
  /** `\n` pour une liste (chronologie, comparaison), espace sinon. */
  separator: '\n' | ' ';
  status: 'answered' | 'insufficient_data';
}

const frDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Ramène les trois formats à des lignes sourcées. Pure. */
export function t2AnswerLines(out: T2AnswerOutput): T2AnswerLines {
  if (out.format === 'claims') {
    return {
      status: out.status, separator: ' ',
      lines: out.claims.map((c) => ({
        text: c.text, sourceIds: c.sourceIds, factual: c.factual, derivation: c.derivation, support: c.support,
      })),
    };
  }
  if (out.format === 'timeline') {
    // B10 : ordre du modèle conservé ; une date inconnue est dite, jamais devinée.
    return {
      status: out.status, separator: '\n',
      lines: out.events.map((e) => ({
        text: `${e.date ? frDate(e.date) : 'Date inconnue'} — ${e.text.trim()}`,
        sourceIds: e.sourceIds, factual: true, derivation: 'direct' as const,
        event: { date: e.date, text: e.text.trim() },
      })),
    };
  }
  // Comparaison (B9) : une absence reste une absence, jamais un zéro.
  return {
    status: out.status, separator: '\n',
    lines: [
      { text: `Critère comparé : ${out.criterion.trim()}`, sourceIds: [], factual: false },
      ...out.items.map((it) => (it.value === null
        ? { text: `• ${it.label.trim()} : valeur absente des données`, sourceIds: it.sourceIds, factual: false }
        : { text: `• ${it.label.trim()} : ${it.value.trim()}`, sourceIds: it.sourceIds, factual: true, derivation: 'direct' as const })),
    ],
  };
}
