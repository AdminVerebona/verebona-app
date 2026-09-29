/**
 * Lecture tolérante de la sortie ANALYZE_DOCUMENT — CDC 15 §23, D-06.
 *
 * Le contrat (`t1-contract.ts`) est strict, et c'est voulu : il protège la
 * persistance. Mais une seule entorse bénigne (extrait vide, libellé trop
 * long, 301e fait, un fait mal formé parmi 80) invaliderait TOUTE la sortie,
 * sur toute la chaîne de modèles (coût ×3, aucun résultat). Ce module
 * normalise la sortie brute AVANT validation, sans rien inventer :
 *
 *   · `excerpt: ""` → absent (un extrait vide n'est pas une preuve) ;
 *   · page nulle ou ≤ 0 → absente ; confiance ou score en pourcentage → /100 ;
 *   · titre ou fournisseur vide → absent ; code de classification > 60 → null ;
 *   · libellés tronqués aux bornes du contrat ; listes tronquées (faits : 300) ;
 *   · une VALEUR trop longue n'est jamais tronquée (elle deviendrait fausse) :
 *     le fait est écarté ; un fait invalide est écarté seul, pas le document ;
 *   · tableau sans colonne ou de plus de 1000 lignes, observation sans
 *     description : écartés ;
 *   · une date de document non ISO est normalisée par le registre, sinon
 *     retirée ; un montant documentaire non entier est retiré.
 * Travaille sur une COPIE de la sortie brute.
 *
 * Les pertes sont comptées dans `_normalisation`, lu puis retiré par l'étape
 * qui les rend en avertissements. Le contrat lui-même n'est pas modifié : ce
 * schéma en DÉRIVE (`z.preprocess`).
 */
import { z } from 'zod';
import { normalizeDateValue } from '@/services/canonical/registry';
import { T1AnalyzeDocumentOutput, t1Fact } from './t1-contract';

export const T1_MAX_FACTS = 300;
const MAX_TABLE_ROWS = 1000;
const MAX_CODE = 60;
const MAX_VALUE = 2000;

export interface T1NormalisationReport {
  /** Faits au-delà de 300, tronqués. */
  truncatedFacts: number;
  /** Faits invalides au regard du contrat, écartés. */
  droppedFacts: number;
  /** Faits dont la valeur (brute ou normalisée) dépasse 2000 caractères : écartés, jamais tronqués. */
  tooLongFacts: number;
  /** Tableaux sans colonne ou de plus de 1000 lignes, écartés. */
  droppedTables: number;
  /** Observations visuelles sans description, écartées. */
  droppedObservations: number;
  /** Chaînes tronquées à leur borne. */
  truncatedStrings: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const vide = (v: unknown) => typeof v !== 'string' || v.trim() === '';
/** Pourcentage rendu à la place d'une proportion (94 au lieu de 0,94). */
const proportion = (v: unknown) => (typeof v === 'number' && v > 1 && v <= 100 ? v / 100 : v);

function prepare(brut: unknown): unknown {
  if (!isObj(brut)) return brut;
  // Copie : la sortie brute n'est jamais modifiée (journalisation, repli).
  const out = structuredClone(brut);
  const report: T1NormalisationReport = {
    truncatedFacts: 0, droppedFacts: 0, tooLongFacts: 0, droppedTables: 0, droppedObservations: 0, truncatedStrings: 0,
  };

  const cut = (o: Obj | undefined, key: string, max: number) => {
    if (!o) return;
    const v = o[key];
    if (typeof v === 'string' && v.length > max) { o[key] = v.slice(0, max); report.truncatedStrings++; }
  };
  const strings = (items: unknown[], max: number) =>
    items.map((s) => (typeof s === 'string' && s.length > max ? (report.truncatedStrings++, s.slice(0, max)) : s));

  // ── Parcours générique : preuves, pages, scores ──────────────────────────
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isObj(node)) return;
    for (const k of ['page', 'pageStart', 'pageEnd']) {
      if (k in node && (node[k] === null || (typeof node[k] === 'number' && (node[k] as number) <= 0))) delete node[k];
    }
    if ('score' in node) node.score = proportion(node.score);
    const e = node.evidence;
    if (isObj(e)) {
      if (vide(e.excerpt)) delete e.excerpt;
      cut(e, 'excerpt', 2000);
      cut(e, 'section', 200);
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(out);

  // ── Document ─────────────────────────────────────────────────────────────
  const doc = isObj(out.document) ? out.document : undefined;
  if (doc) {
    if (isObj(doc.title) && vide(doc.title.value)) delete doc.title;
    for (const [k, max] of [['title', 300], ['description', 2000]] as const) if (isObj(doc[k])) cut(doc[k] as Obj, 'value', max);
    const d = doc.documentDate;
    if (isObj(d)) {
      const iso = normalizeDateValue(d.value);
      if (iso) d.value = iso; else delete doc.documentDate;
    }
    if (isObj(doc.amountCents) && !Number.isInteger(doc.amountCents.value)) delete doc.amountCents;
    const s = doc.supplier;
    if (isObj(s)) {
      if (vide(s.name)) delete doc.supplier;
      else {
        cut(s, 'name', 200);
        const siret = typeof s.siret === 'string' ? s.siret.replace(/\s/g, '') : s.siret;
        s.siret = typeof siret === 'string' && !/^\d{14}$/.test(siret) ? null : siret;
      }
    }
    const c = doc.classification;
    if (isObj(c)) {
      c.confidence = proportion(c.confidence);
      for (const k of ['canonicalType', 'rubricCode', 'documentTypeCode']) {
        if (typeof c[k] === 'string' && (c[k] as string).length > MAX_CODE) c[k] = null;
      }
    }
  }

  // ── Entités ──────────────────────────────────────────────────────────────
  if (isObj(out.entities)) {
    const ent = out.entities;
    for (const [k, max] of [['assets', 20], ['rooms', 20], ['equipments', 20], ['suppliers', 10]] as const) {
      if (!Array.isArray(ent[k])) continue;
      ent[k] = (ent[k] as unknown[]).slice(0, max);
      for (const c of ent[k] as unknown[]) {
        if (!isObj(c)) continue;
        cut(c, 'rawLabel', 200); cut(c, 'reason', 400);
        if (Array.isArray(c.evidenceSignals)) c.evidenceSignals = strings(c.evidenceSignals.slice(0, 10), 200);
      }
    }
  }

  // ── Transcription, visuel, tableaux ─────────────────────────────────────
  cut(out, 'transcription', 200_000);
  if (isObj(out.visual)) {
    cut(out.visual, 'summary', 2000);
    if (Array.isArray(out.visual.observations)) {
      const obs = (out.visual.observations as unknown[]).filter((o) => {
        const ok = isObj(o) && !vide(o.description);
        if (!ok) report.droppedObservations++;
        return ok;
      }).slice(0, 50) as Obj[];
      for (const o of obs) { cut(o, 'description', 500); cut(o, 'subject', 120); }
      out.visual.observations = obs;
    }
  }
  if (Array.isArray(out.tables)) {
    out.tables = (out.tables as unknown[]).filter((t) => {
      const ok = isObj(t) && Array.isArray(t.columns) && t.columns.length > 0
        && (!Array.isArray(t.rows) || t.rows.length <= MAX_TABLE_ROWS);
      if (!ok) report.droppedTables++;
      return ok;
    }).slice(0, 30);
  }

  // ── Faits : 300 au plus ; valeur trop longue ou fait invalide écarté seul ─
  if (Array.isArray(out.facts)) {
    let facts = out.facts as unknown[];
    if (facts.length > T1_MAX_FACTS) { report.truncatedFacts = facts.length - T1_MAX_FACTS; facts = facts.slice(0, T1_MAX_FACTS); }
    out.facts = facts.filter((f) => {
      if (isObj(f)) {
        // Une valeur tronquée serait une valeur FAUSSE : le fait est écarté.
        if (['rawValue', 'normalizedValue'].some((k) => typeof f[k] === 'string' && (f[k] as string).length > MAX_VALUE)) {
          report.tooLongFacts++;
          return false;
        }
        for (const [k, max] of [['rawKey', 200], ['label', 200], ['subject', 200], ['attribute', 200], ['canonicalKey', 120]] as const) cut(f, k, max);
        if (isObj(f.target)) {
          cut(f.target, 'rawLabel', 200);
          if (Array.isArray(f.target.evidenceSignals)) f.target.evidenceSignals = strings(f.target.evidenceSignals.slice(0, 10), 200);
        }
        if (isObj(f.visualEvidence)) cut(f.visualEvidence, 'description', 500);
        if (isObj(f.recurrence)) cut(f.recurrence, 'excerpt', 500);
      }
      const ok = t1Fact.safeParse(f).success;
      if (!ok) report.droppedFacts++;
      return ok;
    });
  }

  out._normalisation = report;
  return out;
}

/** Schéma passé à la passerelle : normalisation tolérante, puis contrat strict. */
export const T1AnalyzeDocumentTolerantOutput = z.preprocess(
  prepare,
  T1AnalyzeDocumentOutput.extend({
    _normalisation: z.object({
      truncatedFacts: z.number(), droppedFacts: z.number(), tooLongFacts: z.number(),
      droppedTables: z.number(), droppedObservations: z.number(), truncatedStrings: z.number(),
    }).optional(),
  }),
);
export type T1AnalyzeDocumentTolerantOutput = z.infer<typeof T1AnalyzeDocumentTolerantOutput>;

/** Sépare la sortie contractuelle du rapport de normalisation. */
export function splitNormalisation(v: T1AnalyzeDocumentTolerantOutput): {
  output: T1AnalyzeDocumentOutput; report: T1NormalisationReport | null;
} {
  const { _normalisation, ...output } = v;
  return { output, report: _normalisation ?? null };
}
