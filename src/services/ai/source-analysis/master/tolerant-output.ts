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
 *   · libellés tronqués aux bornes du contrat ;
 *   · une VALEUR trop longue n'est jamais tronquée (elle deviendrait fausse) :
 *     le fait est écarté ; un fait invalide est écarté seul, pas le document ;
 *   · une date de document non ISO est normalisée par le registre, sinon
 *     retirée ; un montant documentaire non entier est retiré.
 * Travaille sur une COPIE de la sortie brute.
 *
 * Lot 34F (ticket T1 « extraction exhaustive ») — PLUS AUCUNE LIMITE
 * DÉFINITIVE : les bornes du contrat (300 faits, 20 / 10 entités, 30
 * tableaux, 1000 lignes, 50 observations, 200 000 caractères de
 * transcription) sont des bornes PAR LOT. Ce qui les dépasse n'est plus
 * tronqué mais déplacé dans `_normalisation.overflow` (lot suivant, validé
 * élément par élément), que l'étape réintègre AVANT tout traitement. Ce qui
 * est écarté (fait invalide, valeur trop longue, observation sans
 * description, tableau vide) est conservé tel quel dans
 * `_normalisation.dropped` → `document_unresolved_facts`. Les index de
 * tableaux cités par les faits sont recalés sur la liste conservée.
 *
 * Les pertes et lots sont comptés dans `_normalisation`, lu puis retiré par
 * l'étape. Le contrat lui-même n'est pas modifié : ce schéma en DÉRIVE
 * (`z.preprocess`) ; les ajouts de `_normalisation` sont ADDITIFS.
 */
import { z } from 'zod';
import { normalizeDateValue } from '@/services/canonical/registry';
import { T1AnalyzeDocumentOutput, t1Fact, t1Table, type T1Fact } from './t1-contract';

/** Bornes PAR LOT du contrat (lot 34F : jamais des bornes du document). */
export const T1_MAX_FACTS = 300;
export const T1_MAX_TABLES = 30;
export const T1_MAX_TABLE_ROWS = 1000;
export const T1_MAX_OBSERVATIONS = 50;
export const T1_MAX_TRANSCRIPTION = 200_000;
export const T1_MAX_ENTITIES = { assets: 20, rooms: 20, equipments: 20, suppliers: 10 } as const;
const MAX_CODE = 60;
const MAX_VALUE = 2000;
const MAX_OBSERVATION_DESCRIPTION = 500;

type RawTable = T1AnalyzeDocumentOutput['tables'][number];
type RawObservation = NonNullable<T1AnalyzeDocumentOutput['visual']>['observations'][number];
type RawEntities = T1AnalyzeDocumentOutput['entities'];

/** Élément écarté par la lecture tolérante, conservé intégralement (lot 34F). */
export interface T1DroppedItem {
  reason: 'INVALID_SCHEMA' | 'VALUE_TOO_LONG' | 'OBSERVATION_WITHOUT_DESCRIPTION' | 'EMPTY_TABLE';
  /** `facts[12]`, `tables[3]`, `visual.observations[4]`. */
  path: string;
  payload: unknown;
}

/** Éléments au-delà des bornes du lot : réintégrés par l'étape (jamais perdus). */
export interface T1Overflow {
  facts: T1Fact[];
  /** Tous les tableaux (ordre d'origine), quand une borne de tableau est dépassée ; `out.tables` est alors vide. */
  tables: RawTable[] | null;
  observations: RawObservation[];
  /** Descriptions complètes des observations du lot principal dépassant 500 caractères (index → texte). */
  fullDescriptions: Record<number, string>;
  entities: Pick<RawEntities, 'assets' | 'rooms' | 'equipments' | 'suppliers'>;
  transcriptionTail: string;
}

export interface T1NormalisationReport {
  /** Faits au-delà de 300 : déplacés dans le lot suivant (`overflow.facts`), jamais perdus (lot 34F). */
  truncatedFacts: number;
  /** Faits invalides au regard du contrat, écartés (conservés dans `dropped`). */
  droppedFacts: number;
  /** Faits dont la valeur (brute ou normalisée) dépasse 2000 caractères : écartés, jamais tronqués (conservés dans `dropped`). */
  tooLongFacts: number;
  /** Tableaux vides ou invalides, écartés (conservés dans `dropped`). */
  droppedTables: number;
  /** Observations visuelles sans description, écartées (conservées dans `dropped`). */
  droppedObservations: number;
  /** Chaînes tronquées à leur borne (libellés, extraits — jamais une valeur). */
  truncatedStrings: number;
  /** Lot 34F — tableaux passés en lot de débordement (au-delà de 30, ou de 1000 lignes). */
  overflowTables?: number;
  /** Lot 34F — observations au-delà de 50. */
  overflowObservations?: number;
  /** Lot 34F — entités au-delà des bornes. */
  overflowEntities?: number;
  /** Lot 34F — caractères de transcription au-delà de 200 000. */
  transcriptionTailChars?: number;
  /** Lot 34F — lots de débordement (sans perte). */
  overflow?: T1Overflow;
  /** Lot 34F — éléments écartés, conservés tels quels. */
  dropped?: T1DroppedItem[];
}

/** Tableau validé SANS borne de lignes (lot de débordement). */
const t1TableSansBorne = t1Table.extend({ rows: z.array(t1Table.shape.rows.element) });

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
    overflowTables: 0, overflowObservations: 0, overflowEntities: 0, transcriptionTailChars: 0,
  };
  const overflow: T1Overflow = {
    facts: [], tables: null, observations: [], fullDescriptions: {},
    entities: { assets: [], rooms: [], equipments: [], suppliers: [] }, transcriptionTail: '',
  };
  const dropped: T1DroppedItem[] = [];

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
    for (const k of ['assets', 'rooms', 'equipments', 'suppliers'] as const) {
      if (!Array.isArray(ent[k])) continue;
      for (const c of ent[k] as unknown[]) {
        if (!isObj(c)) continue;
        cut(c, 'rawLabel', 200); cut(c, 'reason', 400);
        if (Array.isArray(c.evidenceSignals)) c.evidenceSignals = strings(c.evidenceSignals.slice(0, 10), 200);
      }
      // Au-delà de la borne : lot suivant (validé à l'unité), jamais coupé.
      const max = T1_MAX_ENTITIES[k];
      const liste = ent[k] as unknown[];
      if (liste.length > max) {
        const schema = T1AnalyzeDocumentOutput.shape.entities.unwrap().shape[k].unwrap().element;
        for (const c of liste.slice(max)) {
          const r = schema.safeParse(c);
          if (r.success) { (overflow.entities[k] as unknown[]).push(r.data); report.overflowEntities!++; }
        }
        ent[k] = liste.slice(0, max);
      }
    }
  }

  // ── Transcription, visuel, tableaux ─────────────────────────────────────
  // Transcription : au-delà de 200 000 caractères, la suite part en lot de
  // débordement (coupe sur une fin de ligne si possible) — jamais perdue.
  if (typeof out.transcription === 'string' && out.transcription.length > T1_MAX_TRANSCRIPTION) {
    const t = out.transcription;
    let at = t.lastIndexOf('\n', T1_MAX_TRANSCRIPTION);
    if (at < T1_MAX_TRANSCRIPTION * 0.9) at = T1_MAX_TRANSCRIPTION;
    out.transcription = t.slice(0, at);
    overflow.transcriptionTail = t.slice(at);
    report.transcriptionTailChars = overflow.transcriptionTail.length;
  }
  if (isObj(out.visual)) {
    cut(out.visual, 'summary', 2000);
    if (Array.isArray(out.visual.observations)) {
      const obs = (out.visual.observations as unknown[]).filter((o, i) => {
        const ok = isObj(o) && !vide(o.description);
        if (!ok) {
          report.droppedObservations++;
          dropped.push({ reason: 'OBSERVATION_WITHOUT_DESCRIPTION', path: `visual.observations[${i}]`, payload: o });
        }
        return ok;
      }) as Obj[];
      const schema = T1AnalyzeDocumentOutput.shape.visual.unwrap().shape.observations.unwrap().element;
      obs.forEach((o, i) => {
        cut(o, 'subject', 120);
        if (typeof o.description === 'string' && o.description.length > MAX_OBSERVATION_DESCRIPTION) {
          if (i < T1_MAX_OBSERVATIONS) {
            overflow.fullDescriptions[i] = o.description;
            o.description = o.description.slice(0, MAX_OBSERVATION_DESCRIPTION);
          }
        }
      });
      for (const [k, o] of obs.slice(T1_MAX_OBSERVATIONS).entries()) {
        const full = typeof o.description === 'string' ? o.description : '';
        const r = schema.safeParse({ ...o, description: full.slice(0, MAX_OBSERVATION_DESCRIPTION) });
        if (r.success) { overflow.observations.push({ ...r.data, description: full }); report.overflowObservations!++; }
        else dropped.push({ reason: 'INVALID_SCHEMA', path: `visual.observations[${T1_MAX_OBSERVATIONS + k}]`, payload: o });
      }
      out.visual.observations = obs.slice(0, T1_MAX_OBSERVATIONS);
    }
  }
  // Tableaux : un tableau sans en-têtes mais avec des cellules reçoit des
  // colonnes sans libellé (structure marquée incertaine) ; un tableau VIDE est
  // écarté (conservé dans `dropped`). Les index cités par les faits suivent.
  const indexTables = new Map<number, number>();
  if (Array.isArray(out.tables)) {
    const gardes: Obj[] = [];
    (out.tables as unknown[]).forEach((t, i) => {
      if (isObj(t) && (!Array.isArray(t.columns) || t.columns.length === 0) && Array.isArray(t.rows)) {
        const maxCol = Math.max(-1, ...(t.rows as unknown[]).flatMap((r) => (isObj(r) && Array.isArray(r.cells)
          ? (r.cells as unknown[]).map((c) => (isObj(c) && typeof c.column === 'number' ? c.column : -1)) : [])));
        if (maxCol >= 0) {
          t.columns = Array.from({ length: maxCol + 1 }, () => ({ header: '' }));
          t.uncertain = true;
          t.uncertaintyNote = typeof t.uncertaintyNote === 'string' ? t.uncertaintyNote : 'en-têtes de colonnes absents';
        }
      }
      const ok = isObj(t) && Array.isArray(t.columns) && t.columns.length > 0;
      if (!ok) {
        report.droppedTables++;
        dropped.push({ reason: 'EMPTY_TABLE', path: `tables[${i}]`, payload: t });
        return;
      }
      indexTables.set(i, gardes.length);
      gardes.push(t as Obj);
    });
    const deborde = gardes.length > T1_MAX_TABLES
      || gardes.some((t) => Array.isArray(t.rows) && t.rows.length > T1_MAX_TABLE_ROWS);
    if (deborde) {
      // Tous les tableaux passent au lot de débordement, DANS L'ORDRE : les
      // références de cellule des faits restent valides.
      overflow.tables = [];
      gardes.forEach((t, k) => {
        const r = t1TableSansBorne.safeParse(t);
        if (r.success) { overflow.tables!.push(r.data as RawTable); report.overflowTables!++; }
        else {
          report.droppedTables++;
          dropped.push({ reason: 'INVALID_SCHEMA', path: `tables[${k}]`, payload: t });
          // Index décalés : un tableau invalide disparaît de la liste.
          for (const [orig, cur] of indexTables) {
            if (cur === k) indexTables.delete(orig);
            else if (cur > k) indexTables.set(orig, cur - 1);
          }
        }
      });
      out.tables = [];
    } else {
      out.tables = gardes;
    }
  }

  // ── Faits : lots de 300 ; valeur trop longue ou fait invalide écarté seul (conservé) ─
  if (Array.isArray(out.facts)) {
    const facts = out.facts as unknown[];
    const valides: unknown[] = [];
    facts.forEach((f, i) => {
      const original = isObj(f) ? structuredClone(f) : f;
      if (isObj(f)) {
        // Une valeur tronquée serait une valeur FAUSSE : le fait est écarté.
        if (['rawValue', 'normalizedValue'].some((k) => typeof f[k] === 'string' && (f[k] as string).length > MAX_VALUE)) {
          report.tooLongFacts++;
          dropped.push({ reason: 'VALUE_TOO_LONG', path: `facts[${i}]`, payload: original });
          return;
        }
        // Référence de cellule recalée sur les tableaux conservés.
        const e = f.evidence;
        if (isObj(e) && isObj(e.table) && typeof e.table.index === 'number') {
          const idx = indexTables.get(e.table.index);
          if (idx === undefined) delete e.table; else e.table.index = idx;
        }
        for (const [k, max] of [['rawKey', 200], ['label', 200], ['subject', 200], ['attribute', 200], ['canonicalKey', 120]] as const) cut(f, k, max);
        if (isObj(f.target)) {
          cut(f.target, 'rawLabel', 200);
          if (Array.isArray(f.target.evidenceSignals)) f.target.evidenceSignals = strings(f.target.evidenceSignals.slice(0, 10), 200);
        }
        if (isObj(f.visualEvidence)) cut(f.visualEvidence, 'description', 500);
        if (isObj(f.recurrence)) cut(f.recurrence, 'excerpt', 500);
      }
      const r = t1Fact.safeParse(f);
      if (!r.success) {
        report.droppedFacts++;
        dropped.push({ reason: 'INVALID_SCHEMA', path: `facts[${i}]`, payload: original });
        return;
      }
      // Lot principal : la forme d'origine (le contrat strict la valide) ;
      // au-delà de 300 : lot suivant, sous sa forme validée.
      if (valides.length < T1_MAX_FACTS) valides.push(f);
      else { overflow.facts.push(r.data); report.truncatedFacts++; }
    });
    out.facts = valides;
  }

  if (overflow.facts.length || overflow.tables || overflow.observations.length || overflow.transcriptionTail
    || Object.keys(overflow.fullDescriptions).length || Object.values(overflow.entities).some((l) => l.length)) {
    report.overflow = overflow;
  }
  if (dropped.length) report.dropped = dropped;
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
      // Lot 34F (additif) : lots de débordement et éléments écartés conservés.
      overflowTables: z.number().optional(), overflowObservations: z.number().optional(),
      overflowEntities: z.number().optional(), transcriptionTailChars: z.number().optional(),
      overflow: z.any().optional(), dropped: z.array(z.any()).optional(),
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
