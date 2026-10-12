/**
 * Fournisseurs T3 de la COUCHE EXHAUSTIVE T1 (lot 49B — ticket « T3 :
 * exploiter la couche exhaustive T1 (document_source_units) dans la
 * réconciliation »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX FOURNISSEURS, BASE SEULEMENT (jamais le fichier, jamais T1, jamais S3)
 *
 *   SOURCE_UNITS      `document_source_units` — unités utiles au
 *                     rapprochement, SÉLECTION CIBLÉE :
 *                       · états COVERED, UNRESOLVED, UNCERTAIN (FAILED n'est
 *                         jamais une information connue ; NON_INFORMATIONAL
 *                         est ignoré ; une lacune de pages n'a pas de texte) ;
 *                       · unités de TEXTE (bloc, libellé : valeur, formulaire)
 *                         COUVERTES déjà présentes dans la tranche de
 *                         transcription lue par T3 (`fullText.slice(0, 200 000)`)
 *                         écartées : elles n'apporteraient rien ; au-delà, ou
 *                         non comprises / incertaines : retenues (AC8) ;
 *                       · métadonnées couvertes écartées (déjà dans
 *                         l'extraction) ; lignes de tableau et observations
 *                         visuelles retenues (absentes de la transcription) ;
 *                       · bornes : `SOURCE_UNITS_MAX` unités,
 *                         `SOURCE_UNITS_MAX_CHARS` caractères.
 *   UNRESOLVED_FACTS  `document_unresolved_facts` UNRESOLVED / RETAINED : la
 *                     CHARGE BRUTE (clé lue, valeur lue) d'un fait que T1 n'a
 *                     pas su intégrer — matière de réconciliation, jamais une
 *                     donnée canonique (aucun fait n'est créé ni modifié).
 *
 * Ces textes n'alimentent QUE le Candidate Builder serveur (rapprochement
 * exact, aucune valeur transmise au modèle : le prompt T3 ne reçoit que les
 * candidats et leurs signaux sans valeur).
 *
 * INCERTITUDE (ticket §9) : une unité UNCERTAIN, ou un fait mal formé
 * (schéma invalide, sans preuve, valeur non normalisable), est marqué
 * `uncertain` : il ne produit qu'un INDICE DE CONTEXTE (jamais une preuve,
 * jamais un rattachement déterministe) — le modèle ou l'utilisateur tranche.
 *
 * EMPREINTE : ces textes n'entrent pas tels quels dans le digest documentaire
 * (la sélection ne dépend que du document) ; ce qui entre dans l'empreinte du
 * contexte, ce sont les unités EFFECTIVEMENT CONSIDÉRÉES — celles qui
 * correspondent à un candidat (`context.ts`, `matchedSourceUnits`). Une unité
 * sans rapport ne change rien (AC5, AC6) ; une unité qui désigne un bien
 * nouvellement créé change l'empreinte (AC1, AC2, AC3).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { registerDocumentSourceProvider, type DocumentSourceProvider, type DocumentSourceText } from './document-sources';

/** Tranche de la transcription lue par T3 (marge sous les 200 000 caractères de `persistedKnowledgeProvider`). */
export const TRANSCRIPTION_COVERED_PREFIX = 190_000;
/** Unités lues au plus par document. */
export const SOURCE_UNITS_MAX = 2_000;
/** Caractères retenus au plus (unités + faits non résolus) par document. */
export const SOURCE_UNITS_MAX_CHARS = 400_000;
/** Faits non résolus lus au plus par document. */
export const UNRESOLVED_FACTS_MAX = 500;
const UNIT_MAX_CHARS = 4_000;
const FACT_MAX_CHARS = 2_000;

/**
 * Motifs de conservation d'un fait non intégré dont la valeur lue reste
 * FIABLE (le fait était bien formé : cible / clé inconnue, valeur longue,
 * original d'une valeur réduite) — utilisable comme preuve. Les autres
 * (schéma invalide, sans preuve, non normalisable…) ne sont qu'un indice.
 */
export const RELIABLE_UNRESOLVED_REASONS: readonly string[] = [
  'UNKNOWN_TARGET', 'UNKNOWN_CANONICAL_KEY', 'KEY_NOT_APPLICABLE', 'VALUE_TOO_LONG', 'VALUE_TRUNCATED',
];

export interface ReconciliationSourceUnit {
  sourceUnitId: string;
  kind: string;
  coverageStatus: string;
  text: string | null;
  label: string | null;
  value: string | null;
}

/** Texte d'une unité pour le rapprochement (pure) : contenu, sinon « libellé : valeur ». */
export function unitText(u: Pick<ReconciliationSourceUnit, 'text' | 'label' | 'value'>): string {
  const t = (u.text ?? '').trim() || [u.label, u.value].filter((x) => x && String(x).trim()).join(' : ');
  return t.slice(0, UNIT_MAX_CHARS);
}

/** Unités → textes de connaissance documentaire (pure, bornée). */
export function sourceUnitTexts(units: readonly ReconciliationSourceUnit[], maxChars = SOURCE_UNITS_MAX_CHARS): DocumentSourceText[] {
  const out: DocumentSourceText[] = [];
  let chars = 0;
  for (const u of units) {
    if (u.coverageStatus !== 'COVERED' && u.coverageStatus !== 'UNRESOLVED' && u.coverageStatus !== 'UNCERTAIN') continue;
    if (u.kind === 'PAGE_GAP') continue;
    const text = unitText(u);
    if (!text) continue;
    if (chars + text.length > maxChars) break;
    chars += text.length;
    out.push({
      origin: 'SOURCE_UNITS', zone: 'BODY', text, unitIds: [u.sourceUnitId],
      ...(u.coverageStatus === 'UNCERTAIN' ? { uncertain: true } : {}),
    });
  }
  return out;
}

export interface ReconciliationUnresolvedFact {
  id: number;
  reason: string;
  status: string;
  sourceUnitIds: string[];
  rawKey: string | null;
  canonicalKey: string | null;
  rawValue: string | null;
  originalPayload: unknown;
}

/** Valeurs textuelles d'une charge brute (bornée, sans clés techniques). */
function payloadText(v: unknown, depth = 0): string[] {
  if (v === null || v === undefined || depth > 3) return [];
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  if (Array.isArray(v)) return v.slice(0, 20).flatMap((x) => payloadText(x, depth + 1));
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !['confidence', 'score', 'provenance', 'page', 'index', 'row', 'column', 'pass'].includes(k))
      .slice(0, 30)
      .flatMap(([, x]) => payloadText(x, depth + 1));
  }
  return [];
}

/** Faits non résolus → textes (pure, bornée). Charge brute : jamais une donnée canonique. */
export function unresolvedFactTexts(facts: readonly ReconciliationUnresolvedFact[], maxChars = SOURCE_UNITS_MAX_CHARS): DocumentSourceText[] {
  const out: DocumentSourceText[] = [];
  let chars = 0;
  for (const f of facts) {
    if (f.status !== 'UNRESOLVED' && f.status !== 'RETAINED') continue;
    const valeur = f.rawValue?.trim() || [...new Set(payloadText(f.originalPayload))].join(' — ');
    if (!valeur) continue;
    const text = [f.rawKey ?? f.canonicalKey, valeur].filter(Boolean).join(' : ').slice(0, FACT_MAX_CHARS);
    if (chars + text.length > maxChars) break;
    chars += text.length;
    out.push({
      origin: 'UNRESOLVED_FACTS', zone: 'BODY', text,
      unitIds: f.sourceUnitIds.length > 0 ? [...f.sourceUnitIds] : [`unresolved:${f.id}`],
      ...(RELIABLE_UNRESOLVED_REASONS.includes(f.reason) ? {} : { uncertain: true }),
    });
  }
  return out;
}

/** Unités utiles au rapprochement (SQL borné, ordre de lecture). */
export async function loadReconciliationSourceUnits(accountId: number, fileId: number): Promise<ReconciliationSourceUnit[]> {
  const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
  if (!(await sourceLayerReady())) return [];
  const { pgClient } = await import('@/db');
  return (await pgClient.unsafe(
    `SELECT s.source_unit_id AS "sourceUnitId", s.kind, s.coverage_status AS "coverageStatus",
            s.content_text AS text, s.label, s.value_text AS value
       FROM (
         SELECT u.*, sum(CASE WHEN u.kind IN ('TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD') THEN length(coalesce(u.content_text, '')) + 1 ELSE 0 END)
                       OVER (ORDER BY u.ordinal) AS cum
           FROM document_source_units u
          WHERE u.file_id = $1 AND u.account_id = $2
            AND u.coverage_status IN ('COVERED', 'UNRESOLVED', 'UNCERTAIN') AND u.kind <> 'PAGE_GAP'
       ) s
      WHERE NOT (s.kind IN ('TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD') AND s.coverage_status = 'COVERED' AND s.cum <= $3)
        AND NOT (s.kind = 'DOCUMENT_METADATA' AND s.coverage_status = 'COVERED')
      ORDER BY s.ordinal
      LIMIT $4`,
    [fileId, accountId, TRANSCRIPTION_COVERED_PREFIX, SOURCE_UNITS_MAX] as never[],
  )) as unknown as ReconciliationSourceUnit[];
}

/** Faits non résolus utiles (UNRESOLVED, RETAINED), bornés. */
export async function loadReconciliationUnresolvedFacts(accountId: number, fileId: number): Promise<ReconciliationUnresolvedFact[]> {
  const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
  if (!(await sourceLayerReady())) return [];
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT id::float8 AS id, reason, status, source_unit_ids AS "sourceUnitIds", raw_key AS "rawKey",
            canonical_key AS "canonicalKey", raw_value AS "rawValue", original_payload AS "originalPayload"
       FROM document_unresolved_facts
      WHERE file_id = $1 AND account_id = $2 AND status IN ('UNRESOLVED', 'RETAINED') AND reason <> 'FIELD_PRUNED'
      ORDER BY id LIMIT $3`,
    [fileId, accountId, UNRESOLVED_FACTS_MAX] as never[],
  )) as unknown as ReconciliationUnresolvedFact[];
  return rows.map((r) => ({ ...r, id: Number(r.id), sourceUnitIds: r.sourceUnitIds ?? [] }));
}

export const sourceUnitsProvider: DocumentSourceProvider = {
  name: 'SOURCE_UNITS',
  async load({ accountId, fileId }) {
    const texts = sourceUnitTexts(await loadReconciliationSourceUnits(accountId, fileId));
    return texts.length ? { texts } : null;
  },
};

export const unresolvedFactsProvider: DocumentSourceProvider = {
  name: 'UNRESOLVED_FACTS',
  async load({ accountId, fileId }) {
    const texts = unresolvedFactTexts(await loadReconciliationUnresolvedFacts(accountId, fileId));
    return texts.length ? { texts } : null;
  },
};

let enregistres = false;

/**
 * Enregistre les deux fournisseurs (idempotent) — initialisation normale de
 * T3 (`registerReconciliationHandlers`) et chargement du contexte T3.
 */
export function registerSourceUnitProviders(): void {
  if (enregistres) return;
  enregistres = true;
  registerDocumentSourceProvider(sourceUnitsProvider);
  registerDocumentSourceProvider(unresolvedFactsProvider);
}
