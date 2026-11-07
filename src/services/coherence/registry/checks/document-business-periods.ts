/**
 * COH-DOC-BUSINESS-PERIODS — périodes métier d'un document qualifiées depuis
 * sa connaissance T1 persistée (lot 113W, Trello #724 « Gestion transversale
 * des périodes métier »). Ajouté EN FIN de registre, après
 * COH-SUPPLIER-IDENTITY (113G).
 *
 * C'est la REPRISE DE L'HISTORIQUE : la campagne quotidienne (comptes
 * éligibles) parcourt par lots tous les documents analysés ; chaque document
 * est requalifié dans SA transaction — une reprise interrompue reprend au
 * document suivant, une reprise rejouée ne change rien (faits identiques
 * conservés). Contrôle ciblé après chaque analyse ou modification.
 *
 * Objet : document visible du compte ayant une extraction T1.
 *   · inspection (lecture seule, sans IA, sans relecture du fichier) :
 *     périodes RECALCULÉES par le modèle (`documents/business-periods/model`)
 *     depuis les candidats, faits et run T1 persistés, comparées aux faits
 *     enregistrés ; une nature corrigée par l'utilisateur est hors champ ;
 *       REPAIRABLE BUSINESS_PERIODS_MISSING  aucune période enregistrée alors
 *                  que la connaissance T1 en établit (stock antérieur au lot) ;
 *       REPAIRABLE BUSINESS_PERIODS_STALE    périodes enregistrées différentes
 *                  de la connaissance T1 actuelle (analyse réparée, candidats
 *                  supersédés hors pipeline) ;
 *   · réparation : `refreshDocumentBusinessPeriods` (service unique).
 * Interdits : appeler l'IA, écrire une période absente des preuves, prolonger
 * une couverture (reconduction), toucher une correction de l'utilisateur, une
 * date contractuelle (`business_operation_*`), une dépense ou le TCO.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';
import { OPEN_DOCUMENT_SQL } from './document-links';

export const DOCUMENT_BUSINESS_PERIODS_CHECK_ID = 'COH-DOC-BUSINESS-PERIODS';

/** Document analysé (connaissance T1 persistée). */
const ANALYSED_SQL = `EXISTS (SELECT 1 FROM document_extractions x WHERE x.file_id = f.id AND x.account_id = f.account_id)`;

export const documentBusinessPeriodsCheck: CoherenceCheck = {
  id: DOCUMENT_BUSINESS_PERIODS_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Documents : périodes métier (couverture, facturation, validité…) qualifiées depuis les preuves T1',
  domain: 'documents',
  level: 'N2',
  objectType: 'document',
  scope: 'documents visibles du compte ayant une extraction T1',
  sources: ['asset_files', 'document_extractions', 'document_operation_candidates', 'document_facts', 'document_analysis_runs', 'document_business_periods'],
  applicability: 'compte éligible (actif et modifiable)',
  invariant: 'les périodes métier enregistrées d’un document sont celles qu’établit sa connaissance T1 persistée, sauf nature corrigée par l’utilisateur ; aucune période n’est inventée ni prolongée',
  anomalies: ['BUSINESS_PERIODS_MISSING', 'BUSINESS_PERIODS_STALE'],
  autoRepairWhen: 'les périodes recalculées par le modèle (lecture seule, sans IA) diffèrent des périodes enregistrées hors natures corrigées par l’utilisateur',
  forbiddenRepairs: [
    'appeler l’IA', 'relire le fichier', 'inventer ou prolonger une période (reconduction tacite)', 'modifier une période corrigée par l’utilisateur',
    'écrire une date contractuelle, une dépense ou le TCO', 'créer une carte « À traiter » ou une échéance Agenda',
  ],
  services: ['documents/business-periods/service#previewDocumentBusinessPeriods', 'documents/business-periods/service#refreshDocumentBusinessPeriods'],
  chain: ['T1', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED'],
  frequency: 'campagne exhaustive quotidienne (reprise par lots de l’historique) + contrôle ciblé après analyse ou modification du document',
  criticality: 'MEDIUM',
  tests: ['L113W-U-MODEL', 'L113W-U-COH', 'L113W-E2E-11'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f
       WHERE f.account_id = $1 AND f.id > $2 AND ${OPEN_DOCUMENT_SQL} AND ${ANALYSED_SQL}
       ORDER BY f.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = $2 AND ${OPEN_DOCUMENT_SQL} AND ${ANALYSED_SQL}`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivants = new Set(idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${OPEN_DOCUMENT_SQL}`, [accountId, intArray(ids)])));
    const { previewDocumentBusinessPeriods } = await import('@/services/documents/business-periods/service');
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      let p: Awaited<ReturnType<typeof previewDocumentBusinessPeriods>>;
      try {
        p = await previewDocumentBusinessPeriods(accountId, id, ctx.sql);
      } catch (e) {
        // Migration 1560 absente : constat technique, aucune écriture.
        if ((e as { code?: string })?.code === '42P01') { out.set(id, { verdict: 'FINDING', anomaly: 'BUSINESS_PERIODS_STALE', detail: { fileId: id, reason: 'TABLE_MISSING' } }); continue; }
        throw e;
      }
      if (p.gone || !p.plan) { out.set(id, { verdict: 'GONE' }); continue; }
      const { insert, supersede, keep } = p.plan;
      if (!insert.length && !supersede.length) { out.set(id, { verdict: 'CONSISTENT', detail: { fileId: id, periods: keep.length } }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: keep.length + supersede.length === 0 ? 'BUSINESS_PERIODS_MISSING' : 'BUSINESS_PERIODS_STALE', faultyLink: 'PERSISTENCE',
        expected: p.desired.map((d) => ({ kind: d.kind, segment: d.segment, start: d.start, end: d.end, basis: d.basis })),
        observed: { kept: keep.length, superseded: supersede.length },
        detail: { fileId: id, insert: insert.length, supersede: supersede.length },
        inputHash: hashOf({ id, desired: p.desired, supersede }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { refreshDocumentBusinessPeriods } = await import('@/services/documents/business-periods/service');
    for (const { id } of items) {
      const r = await refreshDocumentBusinessPeriods(accountId, id, { correlationId: ctx.correlationId });
      out.set(id, {
        called: true, service: 'refreshDocumentBusinessPeriods', aiCalls: 0,
        result: { outcome: r.outcome, inserted: r.inserted, superseded: r.superseded, kept: r.kept, protectedKinds: r.protectedKinds },
        rollbackRef: `document_business_periods:correlation_id=${ctx.correlationId}`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
