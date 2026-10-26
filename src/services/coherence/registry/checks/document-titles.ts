/**
 * COH-DOC-TITLES — titres automatiques conformes à la convention, données de
 * nommage propagées, même libellé dans la recherche et la fiche (lot 87D,
 * ticket P1 « Documents — Uniformiser les titres des factures périodiques et
 * fiabiliser leur affichage dans toute l'application » §3.5, §3.6 ;
 * arbitrages C-Q1, C-Q2, C-Q9, C-Q11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL SERVICE DE NOMMAGE, UN SEUL FILET DE CONVERGENCE
 *
 * Le contrôle LIT (sans IA, mode à blanc compris) le titre enregistré, sa
 * source, ses données de nommage persistées (`title_basis`,
 * `title_convention`, `title_canonical_key`, 0760) et le plan que le service
 * de nommage construirait AUJOURD'HUI depuis les données persistées
 * (`planTitleForDocument` : connaissance T1, mois principal IA, période
 * facturée, groupe canonique). Il ne compose rien lui-même ; toute réparation
 * passe par `ensureBusinessTitle` (origine COHERENCE), qui protège le titre
 * utilisateur (compare-and-set) et journalise (`document_title_events`).
 *
 *   · AUTO_TITLE_NOT_CANONICAL  titre SYSTÈME d'une facture périodique ≠ titre
 *       canonique (« Facture Homiris _ Février à mars 2026 », nom harmonisé
 *       par T3 « … n° 94741358 – Mars à avril 2026 »), ou ancienne
 *       typographie du moteur (« _ ») ;
 *   · AUTO_TITLE_TECHNICAL  titre SYSTÈME technique (« <uuid>.pdf », nom de
 *       stockage) alors qu'un titre métier est constructible depuis les
 *       données persistées (rôle de l'ancien balayage horaire, lot 33C) ;
 *   · TITLE_MONTH_MISMATCH  le mois principal décidé par l'IA ne figure pas
 *       dans le titre automatique ;
 *   · TITLE_RULES_OUTDATED / TITLE_CONTEXT_CHANGED  titre SYSTÈME contrôlé
 *       avec des règles antérieures (v3) ou un contexte de titre modifié
 *       (rattachement, bien, équipement, nouvelle analyse) — remplace le
 *       balayage horaire paginé retiré au lot 87D ;
 *   · SEARCH_REFERENCE_NOT_INDEXED  numéro de facture connu (T1) absent des
 *       données indexées par la recherche (« réindexation ») ;
 *   · TITLE_METADATA_NOT_PROPAGATED  données de nommage, convention ou clé du
 *       groupe canonique absentes ou périmées (titre utilisateur compris :
 *       seules ses métadonnées sont réparées, jamais son titre) ;
 *   · SEARCH_LABEL_DIVERGENT  le libellé servi par la recherche diffère du
 *       titre de la fiche : défaut de code (FINDING, jamais « réparé » par une
 *       écriture de données).
 *
 * Jamais modifiés : titre utilisateur, documents sources, dates, montants,
 * rattachements (biens, équipements, Opérations, Agenda). Idempotent : une
 * réparation enregistre la version des règles, l'empreinte du contexte et
 * les données de nommage — un second passage est CONSISTENT.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';
import { OPEN_DOCUMENT_SQL } from './document-links';
import { DOCUMENT_TITLE_RULE_VERSION, isValidBusinessTitle } from '@/lib/documents/document-title-rules';
import { formatTitleMonth, hasLegacyTitleTypography } from '@/lib/documents/document-title-convention';
import { documentTitleColumnsSql, documentTitleFromRecord } from '@/lib/documents/document-title-source';

const DOCUMENT_TITLES_CHECK_ID = 'COH-DOC-TITLES';

type DocumentTitleAnomaly =
  | 'SEARCH_LABEL_DIVERGENT' | 'AUTO_TITLE_TECHNICAL' | 'AUTO_TITLE_NOT_CANONICAL' | 'TITLE_MONTH_MISMATCH' | 'TITLE_RULES_OUTDATED'
  | 'TITLE_CONTEXT_CHANGED' | 'SEARCH_REFERENCE_NOT_INDEXED' | 'TITLE_METADATA_NOT_PROPAGATED';

/** État d'un document pour le diagnostic (lecture seule, testé sans base). */
export interface DocumentTitleState {
  fileId: number;
  title: string | null;
  titleSource: 'SYSTEM' | 'USER';
  titleValid: boolean;
  ruleVersion: number | null;
  contextFingerprint: string | null;
  /** Données persistées (0760). */
  persisted: { basis: Record<string, unknown> | null; convention: string | null; key: string | null };
  /** Ce que le service de nommage produirait aujourd'hui (null : aucune donnée d'analyse). */
  expected: {
    title: string | null;
    convention: string | null;
    key: string | null;
    fingerprint: string;
    record: Record<string, unknown>;
    principalMonth: string | null;
    invoiceReferences: string[];
    /** Le service remplacerait-il une ancienne typographie (aucune perte d'information) ? */
    typographyReplaceable: boolean;
  } | null;
  /** Le titre en place est un nom harmonisé par T3 (protégé hors convention). */
  harmonized: boolean;
  searchLabel: string;
  sheetLabel: string;
}

interface DocumentTitleDiagnosis {
  verdict: Inspection['verdict'];
  anomaly?: DocumentTitleAnomaly;
}

const stable = (v: unknown): string => {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    return x ?? null;
  };
  return JSON.stringify(norm(v));
};

/** Diagnostic PUR d'un document (ordre : défaut de code, titre, règles, recherche, métadonnées). */
export function diagnoseDocumentTitle(s: DocumentTitleState): DocumentTitleDiagnosis {
  if (s.searchLabel !== s.sheetLabel) return { verdict: 'FINDING', anomaly: 'SEARCH_LABEL_DIVERGENT' };
  const e = s.expected;
  if (!e) return { verdict: 'CONSISTENT' };
  if (s.titleSource === 'SYSTEM') {
    const canonique = e.convention !== null && !!e.title;
    if (canonique && (s.title ?? '').trim() !== e.title) {
      const mois = e.principalMonth ? formatTitleMonth(e.principalMonth) : null;
      return { verdict: 'REPAIRABLE', anomaly: mois && !(s.title ?? '').includes(mois) ? 'TITLE_MONTH_MISMATCH' : 'AUTO_TITLE_NOT_CANONICAL' };
    }
    if (!s.titleValid && e.title) return { verdict: 'REPAIRABLE', anomaly: 'AUTO_TITLE_TECHNICAL' };
    if (!canonique && s.titleValid && !s.harmonized && hasLegacyTitleTypography(s.title) && e.title && e.typographyReplaceable) {
      return { verdict: 'REPAIRABLE', anomaly: 'AUTO_TITLE_NOT_CANONICAL' };
    }
    if (s.ruleVersion !== DOCUMENT_TITLE_RULE_VERSION) return { verdict: 'REPAIRABLE', anomaly: 'TITLE_RULES_OUTDATED' };
    if (s.contextFingerprint !== null && s.contextFingerprint !== 'NO_ANALYSIS_DATA' && s.contextFingerprint !== e.fingerprint) {
      return { verdict: 'REPAIRABLE', anomaly: 'TITLE_CONTEXT_CHANGED' };
    }
  }
  const refsIndexees = Array.isArray(s.persisted.basis?.invoiceReferences) ? (s.persisted.basis!.invoiceReferences as unknown[]).map(String) : [];
  if (e.invoiceReferences.some((r) => !refsIndexees.includes(r))) return { verdict: 'REPAIRABLE', anomaly: 'SEARCH_REFERENCE_NOT_INDEXED' };
  if (s.persisted.convention !== e.convention || s.persisted.key !== e.key || stable(s.persisted.basis) !== stable(e.record)) {
    return { verdict: 'REPAIRABLE', anomaly: 'TITLE_METADATA_NOT_PROPAGATED' };
  }
  return { verdict: 'CONSISTENT' };
}

const ETAT_SQL = `
  SELECT f.id, f.retained_title, f.title_source, f.title_rule_version, f.title_context_fingerprint,
         f.title_basis, f.title_convention, f.title_canonical_key, f.web_link_title, f.original_filename, f.filename,
         f.s3_key, f.public_id::text AS public_id, ${documentTitleColumnsSql('f')}
    FROM asset_files f
   WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${OPEN_DOCUMENT_SQL}`;

/** Documents du périmètre : visibles, analysés (connaissance persistée), hors liens web. */
const PERIMETRE_SQL = `${OPEN_DOCUMENT_SQL} AND COALESCE(f.is_web_link, false) = false AND COALESCE(f.is_draft, false) = false
  AND (f.last_analysis_at IS NOT NULL OR EXISTS (SELECT 1 FROM document_extractions e WHERE e.file_id = f.id AND e.account_id = f.account_id))`;

const asObject = (v: unknown): Record<string, unknown> | null => {
  const x = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  return x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
};

/** État courant d'un lot de documents (lecture seule : aucune écriture, aucun appel IA). */
async function charger(ctx: Pick<CheckContext, 'sql'>, accountId: number, ids: readonly number[]): Promise<Map<number, DocumentTitleState>> {
  const svc = await import('@/services/documents/document-title.service');
  const { documentSearchLabel } = await import('@/services/search/global-search.service');
  const out = new Map<number, DocumentTitleState>();
  for (const r of await rows(ctx.sql, ETAT_SQL, [accountId, intArray(ids)])) {
    const id = Number(r.id);
    const title = (r.retained_title as string | null) ?? null;
    const ids2 = { s3Key: (r.s3_key as string | null) ?? null, publicId: (r.public_id as string | null) ?? null };
    const inputs = await svc.loadPersistedTitleInputs(id, accountId);
    let expected: DocumentTitleState['expected'] = null;
    if (inputs) {
      const { plan, fingerprint, basis } = await svc.planTitleForDocument(id, accountId, inputs);
      const candidat = plan.title && isValidBusinessTitle(plan.title, ids2) ? plan.title.trim() : null;
      expected = {
        title: candidat, convention: plan.convention, key: plan.canonicalKey, fingerprint,
        record: svc.titleBasisRecord(plan, basis, inputs.ctx.supplier ?? null),
        principalMonth: basis.principalMonth?.value ?? null,
        invoiceReferences: basis.invoiceReferences,
        typographyReplaceable: !!candidat && !svc.titleLosesInformation(title ?? '', candidat, plan),
      };
    }
    out.set(id, {
      fileId: id, title,
      titleSource: r.title_source === 'USER' ? 'USER' : 'SYSTEM',
      titleValid: isValidBusinessTitle(title, ids2),
      ruleVersion: r.title_rule_version == null ? null : Number(r.title_rule_version),
      contextFingerprint: (r.title_context_fingerprint as string | null) ?? null,
      persisted: { basis: asObject(r.title_basis), convention: (r.title_convention as string | null) ?? null, key: (r.title_canonical_key as string | null) ?? null },
      expected,
      harmonized: r.title_source !== 'USER' && hasLegacyTitleTypography(title) ? await svc.isHarmonizedDocumentTitle(id, accountId, title) : false,
      searchLabel: documentSearchLabel(r),
      sheetLabel: documentTitleFromRecord({
        retainedTitle: title, webLinkTitle: (r.web_link_title as string | null) ?? null, originalFilename: (r.original_filename as string | null) ?? null,
        filename: (r.filename as string | null) ?? null, s3Key: ids2.s3Key, publicId: ids2.publicId,
      }, 'Document'),
    });
  }
  return out;
}

export const documentTitlesCheck: CoherenceCheck = {
  id: DOCUMENT_TITLES_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Titres des documents : convention unique, données de nommage propagées, même libellé partout',
  domain: 'documents',
  level: 'N2',
  objectType: 'document',
  scope: 'documents visibles et analysés du compte (hors liens web et brouillons)',
  sources: ['asset_files', 'document_extractions', 'document_operation_candidates', 'document_facts', 'document_analysis_runs', 'document_title_events'],
  applicability: 'compte éligible',
  invariant: 'un titre automatique est le titre que le service de nommage compose aujourd’hui (convention périodique « Facture {Fournisseur} — {Période} », séparateur unique) ; les données de nommage (période facturée, mois principal IA, émission, références de facture) sont persistées et indexées ; la recherche et la fiche affichent le même libellé',
  anomalies: ['AUTO_TITLE_TECHNICAL', 'AUTO_TITLE_NOT_CANONICAL', 'TITLE_MONTH_MISMATCH', 'TITLE_RULES_OUTDATED', 'TITLE_CONTEXT_CHANGED', 'SEARCH_REFERENCE_NOT_INDEXED', 'TITLE_METADATA_NOT_PROPAGATED', 'SEARCH_LABEL_DIVERGENT'],
  autoRepairWhen: 'données persistées suffisantes : le service de nommage recompose et persiste (compare-and-set) ; titre utilisateur : données de nommage seulement',
  forbiddenRepairs: [
    'réécrire un titre utilisateur', 'inventer un mois ou une période (mois principal : décision IA seulement)',
    'écrire hors du service de nommage (ensureBusinessTitle)', 'modifier dates, montants, rattachements, Opérations ou éléments d’Agenda',
    'fusionner deux documents de même titre', 'appeler l’IA ou relancer T1',
  ],
  services: ['documents/document-title.service#ensureBusinessTitle'],
  chain: ['T1', 'PERSISTENCE', 'PROJECTION'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne (lecture seule, sans IA) + contrôle ciblé après analyse ou modification du document ou de son bien',
  criticality: 'MEDIUM',
  tests: ['L87D-U-COH', 'L87D-E2E-03', 'L87D-E2E-04', 'L87D-E2E-05'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id > $2 AND ${PERIMETRE_SQL} ORDER BY f.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    // Bien modifié (nom…) : ses documents ; sinon le document lui-même.
    if (e.type === 'ASSET_UPDATED') {
      return idsOf(await rows(ctx.sql, `
        SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND (f.asset_id = $2 OR f.linked_asset_id = $2) AND ${PERIMETRE_SQL}
         ORDER BY f.id LIMIT 500`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = $2 AND ${PERIMETRE_SQL}`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const etats = await charger(ctx, accountId, ids);
    for (const id of ids) {
      const s = etats.get(id);
      if (!s) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = diagnoseDocumentTitle(s);
      if (d.verdict === 'CONSISTENT') { out.set(id, { verdict: 'CONSISTENT', detail: { fileId: id } }); continue; }
      const observed = { title: s.title, source: s.titleSource, ruleVersion: s.ruleVersion, convention: s.persisted.convention, key: s.persisted.key, searchLabel: s.searchLabel };
      const expected = s.expected ? { title: s.titleSource === 'SYSTEM' ? s.expected.title : s.title, convention: s.expected.convention, key: s.expected.key, sheetLabel: s.sheetLabel } : null;
      out.set(id, {
        verdict: d.verdict, anomaly: d.anomaly,
        faultyLink: d.anomaly === 'SEARCH_LABEL_DIVERGENT' ? 'PROJECTION' : 'PERSISTENCE',
        expected, observed,
        detail: { fileId: id, anomaly: d.anomaly ?? null },
        inputHash: hashOf({ id, a: d.anomaly, o: observed, e: expected, f: s.expected?.fingerprint ?? null, r: s.expected?.record ?? null }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    const etats = await charger(ctx, accountId, items.map((x) => x.id));
    for (const { id, inspection } of items) {
      const s = etats.get(id);
      if (!s) { out.set(id, { called: false, service: 'none', result: { skipped: 'DOCUMENT_GONE' } }); continue; }
      // Diagnostic recalculé sur l'état courant : jamais d'écriture sur une donnée qui a bougé.
      const d = diagnoseDocumentTitle(s);
      if (d.verdict !== 'REPAIRABLE' || d.anomaly !== inspection.anomaly) {
        out.set(id, { called: false, service: 'none', result: { skipped: 'STATE_CHANGED' } });
        continue;
      }
      const r = await ensureBusinessTitle({ fileId: id, accountId, origin: 'COHERENCE', mode: 'repair' });
      if (r.outcome === 'FAILED') throw new Error(`service de nommage : ${r.reason ?? 'échec'}`);
      out.set(id, {
        called: true, service: 'ensureBusinessTitle', aiCalls: 0,
        result: { anomaly: d.anomaly, outcome: r.outcome, reason: r.reason, before: s.title, after: r.newTitle ?? s.title },
        rollbackRef: `asset_files:id=${id}:retained_title=${(s.title ?? '').slice(0, 120)}`,
      });
    }
    return out;
  },
};
