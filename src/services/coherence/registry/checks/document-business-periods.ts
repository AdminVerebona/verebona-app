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
 *
 * CARTE #812 (lot 116F, version 2) — DATE DU DOCUMENT RECOPIÉE EN VALIDITÉ. Une période de validité
 * dont la seule borne est une date ponctuelle du document (commande, facture, émission…) n'est plus
 * qualifiée (`documents/business-periods/point-date`). Ce contrôle est la DÉTECTION RÉCURRENTE et la
 * REPRISE DU STOCK de ce défaut :
 *       REPAIRABLE BUSINESS_PERIODS_POINT_DATE_COPY       une période enregistrée n'est que la date du
 *                  document, copie PROUVÉE par l'extrait du fait (détail : période, jour, rôle de la
 *                  date, motif) — réparation : retrait (SUPERSEDED, motif tracé, jamais supprimée) ;
 *       AMBIGUOUS  BUSINESS_PERIODS_POINT_DATE_TO_REVIEW  même jour qu'une date du document mais
 *                  mention propre : indéterminé — AUCUNE écriture, la période est conservée « à
 *                  réexaminer » (elle n'est simplement plus créée par une nouvelle analyse).
 * Version nouvelle : la première campagne quotidienne l'exécute À BLANC (rapport), la suivante corrige
 * (règle A6 du moteur). Une période corrigée par l'utilisateur reste hors champ.
 *
 * REPRISE APRÈS LA RECETTE KO DU 21/11/2026 (version inchangée : 2, pour ne pas requalifier le contrôle) :
 *   · la règle A6 reste VOULUE ici (décision du PO du lot 100E, non modifiée) — elle implique que ce contrôle
 *     ne retire rien avant qu'une campagne QUOTIDIENNE l'ait exécuté à blanc JUSQU'À SON TERME (COMPLETE) :
 *     au mieux la campagne du surlendemain du déploiement, jamais si les campagnes restent partielles ou si
 *     `COHERENCE_CAMPAIGN_MODE` vaut `dry_run` ; les contrôles ciblés suivent la même qualification ;
 *   · ce délai ne décide donc plus de ce que l'utilisateur voit : la règle vaut À LA LECTURE
 *     (`service#pointDateCopyIds`, aucune écriture) et l'exploitant dispose d'une reprise immédiate
 *     (`scripts/reprise-812-validites-artificielles.ts`, même service de réparation que ce contrôle) ;
 *   · règle resserrée (`point-date`, motif `DOCUMENT_DATE_RESTATED`) : un DÉBUT égal à la date du document,
 *     sans rien d'autre, est une copie quelle que soit sa mention ; `BUSINESS_PERIODS_POINT_DATE_TO_REVIEW`
 *     ne vaut plus que pour une FIN SEULE le jour du document portée par une mention propre.
 *
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
  // Carte #812 : version 2 — une date ponctuelle du document n'est jamais, à elle seule, une borne de validité (stock réexaminé).
  version: 2,
  status: 'ACTIVE',
  title: 'Documents : périodes métier (couverture, facturation, validité…) qualifiées depuis les preuves T1',
  domain: 'documents',
  level: 'N2',
  objectType: 'document',
  scope: 'documents visibles du compte ayant une extraction T1',
  sources: ['asset_files', 'document_extractions', 'document_operation_candidates', 'document_facts', 'document_analysis_runs', 'document_business_periods'],
  applicability: 'compte éligible (actif et modifiable)',
  invariant: 'les périodes métier enregistrées d’un document sont celles qu’établit sa connaissance T1 persistée, sauf nature corrigée par l’utilisateur ; aucune période n’est inventée ni prolongée ; une date ponctuelle du document (commande, facture, émission) n’est jamais, à elle seule, une borne de validité',
  anomalies: ['BUSINESS_PERIODS_MISSING', 'BUSINESS_PERIODS_STALE', 'BUSINESS_PERIODS_POINT_DATE_COPY', 'BUSINESS_PERIODS_POINT_DATE_TO_REVIEW'],
  autoRepairWhen: 'les périodes recalculées par le modèle (lecture seule, sans IA) diffèrent des périodes enregistrées hors natures corrigées par l’utilisateur',
  forbiddenRepairs: [
    'appeler l’IA', 'relire le fichier', 'inventer ou prolonger une période (reconduction tacite)', 'modifier une période corrigée par l’utilisateur',
    'écrire une date contractuelle, une dépense ou le TCO', 'créer une carte « À traiter » ou une échéance Agenda',
    'supprimer une période (un retrait est un passage à SUPERSEDED, tracé)', 'retirer une période « à réexaminer » (copie non prouvée de la date du document)',
  ],
  services: ['documents/business-periods/service#previewDocumentBusinessPeriods', 'documents/business-periods/service#refreshDocumentBusinessPeriods'],
  chain: ['T1', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED'],
  frequency: 'campagne exhaustive quotidienne (reprise par lots de l’historique) + contrôle ciblé après analyse ou modification du document',
  criticality: 'MEDIUM',
  tests: ['L113W-U-MODEL', 'L113W-U-COH', 'L113W-E2E-11', 'L116F-U-COH', 'L116F-E2E-05', 'L116F-E2E-06', 'L116F-E2E-DECATHLON', 'L116F-E2E-11'],

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
      // Carte #812 : rapport « avant / après » des périodes qui ne sont que la date du document.
      const copies = p.pointDate?.copies ?? [];
      const aRevoir = p.pointDate?.toReview ?? [];
      if (!insert.length && !supersede.length) {
        // Indéterminé : la période est conservée, signalée « à réexaminer » — aucune écriture.
        if (aRevoir.length) {
          out.set(id, {
            verdict: 'AMBIGUOUS', anomaly: 'BUSINESS_PERIODS_POINT_DATE_TO_REVIEW', faultyLink: 'T1',
            observed: { toReview: aRevoir }, detail: { fileId: id, periods: keep.length, toReview: aRevoir.length },
          });
          continue;
        }
        out.set(id, { verdict: 'CONSISTENT', detail: { fileId: id, periods: keep.length } });
        continue;
      }
      out.set(id, {
        verdict: 'REPAIRABLE',
        anomaly: copies.length ? 'BUSINESS_PERIODS_POINT_DATE_COPY' : keep.length + supersede.length === 0 ? 'BUSINESS_PERIODS_MISSING' : 'BUSINESS_PERIODS_STALE',
        faultyLink: copies.length ? 'T1' : 'PERSISTENCE',
        expected: p.desired.map((d) => ({ kind: d.kind, segment: d.segment, start: d.start, end: d.end, basis: d.basis })),
        observed: { kept: keep.length, superseded: supersede.length, ...(copies.length ? { pointDateCopies: copies } : {}), ...(aRevoir.length ? { toReview: aRevoir } : {}) },
        detail: { fileId: id, insert: insert.length, supersede: supersede.length, ...(copies.length ? { pointDateCopies: copies.length } : {}), ...(aRevoir.length ? { toReview: aRevoir.length } : {}) },
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
        result: {
          outcome: r.outcome, inserted: r.inserted, superseded: r.superseded, kept: r.kept, protectedKinds: r.protectedKinds,
          ...(r.pointDateCopies ? { pointDateCopies: r.pointDateCopies } : {}), ...(r.pointDateToReview ? { pointDateToReview: r.pointDateToReview } : {}),
        },
        rollbackRef: `document_business_periods:correlation_id=${ctx.correlationId}`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
