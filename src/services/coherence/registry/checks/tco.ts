/**
 * COH-TCO-EXTRACTED-EXPENSES — dépense déjà extraite mais absente du TCO sans
 * décision explicable (lot 82B ; arbitrages C-Q1, C-Q6, C-Q7 ; CDC §4.4).
 *
 * Le TCO n'a pas d'état persisté : il est recalculé par `readAssetTco` (même
 * code que le sous-tiroir et T2 — aucun second moteur). Le contrôle relit ce
 * calcul pour CHAQUE bien du compte et retient les lignes économiques dont
 * le MONTANT est connu (extrait par T1 ou porté par le document) mais dont
 * l'inclusion n'a reçu AUCUNE décision : statut `NOT_QUALIFIED`, motif
 * `THEME_UNKNOWN` (« nature non établie : montant non compté »). Une ligne
 * retenue, consolidée ailleurs, doublon, exclue avec motif (dont un retrait
 * par l'utilisateur), prévision ou règlement n'est PAS un écart.
 *
 * Aucune règle par type de document (ni « taxe foncière », ni catégorie
 * « Impôts et taxes ») : C-Q6 confie à T3 la décision SÉMANTIQUE d'inclusion
 * (coût de possession ou d'usage du bien). Le contrat T3 correspondant
 * n'existe pas encore : demande formalisée à l'équipe IA
 * (`demandes-ia/82B-t3-decision-tco.md`). En attendant, le contrôle est un
 * CONSTAT (verdict FINDING, maillon T3) — sans relance de T1, sans appel IA,
 * sans écriture ; un constat persistant remonte UNE fois par contrôle dans
 * la Supervision existante. Dès que le contrat est livré, la réparation
 * (réévaluation T3 ciblée par la file existante, puis recontrôle) se
 * branche ici sans changer l'orchestration.
 *
 * Lot 85B (version 2, CDC §4.4 « l'absence de ligne et l'absence de
 * justification constituent une anomalie d'exhaustivité » ; CA-15) : un
 * document du bien dont l'EXTRACT porte un montant (repérage déterministe
 * `significantValues`, le même que la chaîne C-Q7) mais qui ne produit
 * AUCUNE ligne économique (ni retenue, ni exclue avec motif : le moteur TCO
 * l'écarte sans trace faute de montant ou d'indice financier T1) est un
 * CONSTAT `SOURCE_AMOUNT_NOT_EXPLOITED` (maillon T1 : l'indice financier
 * attendu relève du contrat `82B-t1-omissions-extract`, la décision
 * d'inclusion de `82B-t3-decision-tco`). Les documents que la barrière du
 * moteur déclare non financiers (notice, photo, annonce…) en sont exclus :
 * leur exclusion est motivée par le moteur lui-même. Aucune valeur écrite,
 * aucun montant repris de l'extract, aucune règle par type de document.
 *
 * Lot 111V (ticket « TCO — anomalies corrigeables », chaînon fermé) : le
 * contrat `82B-t3-decision-tco` n'a toujours AUCUN champ de sortie dans le T3
 * livré (guide PO §12) — aucune réparation T3 n'est donc annoncée ni
 * déclenchée (jamais d'IA à l'ouverture de l'écran ni ici). Le chaînon est
 * fermé sur l'architecture existante :
 *   · la cause racine des exclusions à tort est corrigée dans le moteur (repli
 *     de stockage « AUTRE » ignoré pour un type V2 connu, `expense-classes`) :
 *     le recalcul à la lecture reprend l'historique sans écriture ;
 *   · chaque ligne constatée porte sur la fiche le geste « Nature à confirmer »
 *     (`tcoLineDecisionOptions` : ajouter, confirmer la nature, confirmer
 *     l'exclusion) — `resolution: 'USER_DECISION'` dans le constat ;
 *   · une ligne ARBITRÉE par l'utilisateur (décision 80A ou 111V) n'est plus un
 *     écart : sa décision est l'issue explicable exigée par l'invariant (C-Q6
 *     reste ouvert pour une décision T3 automatique, contrat en attente).
 *
 * Lot 113AL (Trello #737, version 3 — chaînon sémantique LIVRÉ) : le contrat
 * `t3-economic-qualification-v1` (branche ECONOMIC_QUALIFICATION du T3,
 * bloc 31 du guide, demande `82B-t3-decision-tco`) est branché :
 *   · montant à arbitrer jamais examiné dans son contexte (empreinte) et
 *     contrat présent dans le prompt T3 actif → REPAIRABLE
 *     `EXTRACTED_EXPENSE_T3_REVIEW_MISSING` : la réparation POSE la demande
 *     (`requestQualificationReviews`, aucun appel IA ici) ; issue
 *     REPAIR_PENDING (jamais un faux REPAIRED) jusqu'à la décision du passage
 *     T3 de fond (`runQualificationPhase`), puis recontrôle : REPAIRED si le
 *     moteur a retenu, rattaché ou exclu le montant ;
 *   · examen demandé ou en cours → même diagnostic réparable, même empreinte
 *     (`EXTRACTED_EXPENSE_T3_PENDING`) : la réparation en attente n'est pas
 *     rejouée ;
 *   · contrat absent (bloc 31 non collé, coupure) → constat d'origine avec
 *     `t3Contract: CONTRACT_PENDING` (Supervision des constats persistants ;
 *     BO › Conformité des prompts : contrat « absent ») ; l'issue reste la
 *     décision de l'utilisateur (lot 111V) ;
 *   · examen conclu sans décision appliquée (abstention, confiance
 *     insuffisante, sortie refusée) → constat d'origine, `resolution:
 *     USER_DECISION` (seul ce reliquat légitime un arbitrage de l'utilisateur).
 * Jamais d'IA à l'ouverture de la fiche ni dans ce contrôle ; aucune règle par
 * type de document, fournisseur, mot-clé ou montant.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

/** Lot 113AL : contrat IA livré dont dépend la réparation automatique… */
const TCO_T3_DECISION_CONTRACT = 't3-economic-qualification-v1';
/** … qui répond à la demande d'origine (lot 82B, C-Q6), toujours citée dans les constats. */
const TCO_T3_DECISION_REQUEST = '82B-t3-decision-tco';
/** Lot 85B : contrat IA de l'indice financier attendu d'un montant lu dans l'extract. */
const T1_FINANCIAL_HINT_CONTRACT = '82B-t1-omissions-extract';

interface DemandeT3 { fileId: number; fingerprint: string; amounts: Array<{ fileId: number; amountMinor: number; currency: string; origin: 'LINE' | 'EXTRACT'; lineId: string | null; quote: string | null }> }

export const tcoExtractedExpensesCheck: CoherenceCheck = {
  id: 'COH-TCO-EXTRACTED-EXPENSES',
  // Lot 85B : version 2 — sources dont l'extract porte un montant sans aucune ligne économique (stock réexaminé, §6.4).
  // Lot 113AL : version 3 — arbitrage sémantique T3 demandé (réparation), suivi jusqu'à la décision, contrat supervisé.
  version: 3,
  status: 'ACTIVE',
  title: 'TCO : dépense extraite sans décision d’inclusion',
  domain: 'tco',
  level: 'N3',
  objectType: 'asset',
  scope: 'tous les biens vivants du compte (lignes économiques recalculées par le moteur TCO)',
  sources: ['asset_files', 'document_operation_candidates', 'business_operations', 'business_operation_financial_components', 'asset_cost_line_decisions', 'document_asset_links', 'document_source_units', 'economic_qualification_reviews'],
  applicability: 'compte éligible ; lecture TCO complète (une lecture partielle est une erreur de contrôle, jamais un résultat conforme)',
  invariant: 'toute dépense dont le montant est connu est retenue, représentée par une Opération, ou exclue avec un motif explicable ; toute source du bien dont l’extract porte un montant produit une ligne économique ou une exclusion motivée',
  anomalies: ['EXTRACTED_EXPENSE_NOT_EVALUATED', 'SOURCE_AMOUNT_NOT_EXPLOITED', 'EXTRACTED_EXPENSE_T3_REVIEW_MISSING', 'EXTRACTED_EXPENSE_T3_PENDING'],
  autoRepairWhen: 'montant à arbitrer jamais examiné dans son contexte et contrat t3-economic-qualification-v1 présent dans le prompt T3 actif : demande d’arbitrage T3 posée (sans appel IA), décidée par le passage T3 de fond puis appliquée par le moteur existant ; sinon (abstention, contrat absent) l’issue est la décision de l’utilisateur proposée sur la fiche (lot 111V)',
  forbiddenRepairs: ['classer une dépense par type de document ou mot-clé', 'relancer T1 (montant déjà extrait)', 'ajouter une décision utilisateur à sa place', 'appeler l’IA depuis le contrôle ou à l’ouverture du TCO', 'additionner un montant proposé par l’IA'],
  services: ['business-operations/tco/service#readAssetTco', 'business-operations/tco/semantic-qualification/review#requestQualificationReviews'],
  chain: ['T1', 'T3', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'ASSET_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'HIGH',
  tests: ['L82B-E2E-07', 'L82B-U-TCO', 'L85B-E2E-05', 'L113AL-E2E-ACCEPTATION', 'L113AL-U-CHECK'],
  semanticReevaluation: ['T3'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT a.id FROM assets a WHERE a.account_id = $1 AND a.deleted_at IS NULL AND a.id > $2 ORDER BY a.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.type === 'ASSET_UPDATED') {
      return e.entityId == null ? [] : idsOf(await rows(ctx.sql, `SELECT id FROM assets WHERE account_id = $1 AND id = $2 AND deleted_at IS NULL`, [accountId, e.entityId]));
    }
    // Document analysé / modifié : biens qu'il concerne (colonnes et liens actifs), plus le bien de l'analyse.
    const ids = e.entityId == null ? [] : idsOf(await rows(ctx.sql, `
      SELECT DISTINCT a.id FROM assets a
       WHERE a.account_id = $1 AND a.deleted_at IS NULL
         AND (a.id IN (SELECT f.asset_id FROM asset_files f WHERE f.id = $2 AND f.account_id = $1)
              OR a.id IN (SELECT f.linked_asset_id FROM asset_files f WHERE f.id = $2 AND f.account_id = $1)
              OR a.id IN (SELECT l.asset_id FROM document_asset_links l WHERE l.file_id = $2 AND l.account_id = $1 AND l.status = 'ACTIVE'))`,
    [accountId, e.entityId]));
    if (e.assetId != null) ids.push(e.assetId);
    return intArray(ids).sort((a, b) => a - b);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const [{ readAssetTco, AssetNotFoundForTcoError }, targets, review, { tcoLineKeys }] = await Promise.all([
      import('@/services/business-operations/tco/service'), import('@/services/business-operations/tco/semantic-qualification/targets'),
      import('@/services/business-operations/tco/semantic-qualification/review'), import('@/services/business-operations/tco/user-decisions'),
    ]);
    let capacite: { available: boolean; reason: string; contractState?: string } | null = null;
    const contrat = async () => {
      if (!capacite) {
        try { capacite = await (await import('@/services/business-operations/tco/semantic-qualification/decider')).qualificationDecider().capability(); }
        catch { capacite = { available: false, reason: 'CONTRACT_PENDING', contractState: 'UNREADABLE' }; }
      }
      return capacite;
    };
    for (const assetId of ids) {
      let tco;
      try {
        tco = await readAssetTco(accountId, assetId, { today: ctx.today });
      } catch (e) {
        if (e instanceof AssetNotFoundForTcoError) { out.set(assetId, { verdict: 'GONE' }); continue; }
        throw e;
      }
      // Lecture incomplète (pages non lues) : le contrôle n'a pas eu lieu — jamais « conforme ».
      if (tco.status === 'PARTIAL' || tco.status === 'ERROR') throw new Error(`lecture TCO ${tco.status} du bien ${assetId}`);
      // Lot 111V : une ligne arbitrée par l'utilisateur (ajoutée, nature confirmée, exclusion confirmée) a son issue explicable.
      const ecarts = tco.lines.filter((l) => targets.lineAwaitsQualification(l))
        .map((l) => ({ lineId: l.id, fileId: l.fileId, amountMinor: l.amountMinor, currency: l.currency, date: l.date, provenance: l.provenance, label: l.label.slice(0, 120), t3: l.semantic?.state ?? null }));
      // Lot 85B : sources sans AUCUNE ligne dont l'extract porte un montant (omission silencieuse du moteur, §4.4).
      const silencieuxBruts = await targets.silentAmountSources(ctx.sql as never, accountId, assetId, new Set(tco.lines.map((l) => l.fileId).filter((x): x is number => x != null)));
      const silencieux = silencieuxBruts.map((s) => ({ fileId: s.fileId, amounts: s.amounts.map((a) => a.amountMinor) }));
      if (!ecarts.length && !silencieux.length) { out.set(assetId, { verdict: 'CONSISTENT', detail: { lines: tco.lines.length } }); continue; }
      // Lot 113AL : examen T3 de chaque document à arbitrer, dans son contexte (empreinte) — lecture seule.
      const cibles = targets.qualificationTargets(tco, silencieuxBruts);
      const versions = await targets.documentVersions(ctx.sql as never, accountId, cibles.map((c) => c.fileId));
      const comptes = targets.countedFactsOf(tco, (l) => tcoLineKeys(l).primary);
      const demandes: DemandeT3[] = cibles.map((c) => ({
        fileId: c.fileId, amounts: c.amounts,
        fingerprint: targets.qualificationFingerprint({ fileId: c.fileId, docVersion: versions.get(c.fileId) ?? null, amounts: c.amounts, counted: comptes }),
      }));
      const etats = await review.reviewStates(ctx.sql as never, accountId, assetId, demandes);
      const etat = (d: DemandeT3) => etats.get(`${d.fileId}:${d.fingerprint}`)?.state ?? 'NONE';
      const cap = await contrat();
      const aDemander = demandes.filter((d) => etat(d) === 'NONE');
      const enCours = demandes.filter((d) => etat(d) === 'AWAITING');
      const sansContrat = demandes.filter((d) => etat(d) === 'CONTRACT_PENDING' || (!cap.available && etat(d) !== 'CONCLUDED'));
      const suivi = { requested: aDemander.length, awaiting: enCours.length, contractPending: sansContrat.length, concluded: demandes.filter((d) => etat(d) === 'CONCLUDED').length };
      if (cap.available && (aDemander.length || enCours.length)) {
        // Même empreinte pour « à demander » et « en cours » : la réparation en attente n'est pas rejouée (REPAIR_PENDING).
        const fps = [...aDemander, ...enCours].map((d) => `${d.fileId}:${d.fingerprint}`).sort();
        out.set(assetId, {
          verdict: 'REPAIRABLE', anomaly: aDemander.length ? 'EXTRACTED_EXPENSE_T3_REVIEW_MISSING' : 'EXTRACTED_EXPENSE_T3_PENDING', faultyLink: 'T3',
          expected: 'arbitrage sémantique T3 du montant (contrat t3-economic-qualification-v1), appliqué par le moteur existant',
          observed: ecarts.length ? ecarts : silencieux,
          // Détail borné : identifiants, montants, empreintes — jamais un passage du document.
          detail: {
            contract: TCO_T3_DECISION_CONTRACT, t1Relaunch: false, count: ecarts.length + silencieux.length, t3: suivi,
            requests: aDemander.map((d) => ({ fileId: d.fileId, fingerprint: d.fingerprint, amounts: d.amounts.map((m) => ({ ...m, quote: null })) })),
          },
          inputHash: hashOf({ assetId, t3: fps }),
        });
        continue;
      }
      // Contrat absent du prompt T3 actif (CONTRACT_PENDING, supervisé) ou examen conclu sans décision appliquée
      // (abstention, confiance insuffisante, sortie refusée) : constat d'origine, issue = arbitrage de l'utilisateur (111V).
      const t3Contract = sansContrat.length ? 'CONTRACT_PENDING' : 'ABSTAINED';
      const t3 = { contract: TCO_T3_DECISION_CONTRACT, t3Contract, ...(sansContrat.length ? { contractState: cap.contractState ?? cap.reason } : {}), t3: suivi };
      out.set(assetId, ecarts.length ? {
        verdict: 'FINDING', anomaly: 'EXTRACTED_EXPENSE_NOT_EVALUATED', faultyLink: 'T3',
        expected: 'dépense retenue, consolidée ou exclue avec motif (décision sémantique T3, C-Q6)',
        observed: ecarts,
        detail: {
          pendingContract: TCO_T3_DECISION_REQUEST, ...t3, resolution: 'USER_DECISION', userDiagnostic: 'DOCUMENTS_NOT_QUALIFIED',
          t1Relaunch: false, count: ecarts.length, ...(silencieux.length ? { silentSources: silencieux } : {}),
        },
        inputHash: hashOf({ assetId, ecarts: ecarts.map((x) => [x.lineId, x.amountMinor, x.currency]), silencieux, t3Contract }),
      } : {
        verdict: 'FINDING', anomaly: 'SOURCE_AMOUNT_NOT_EXPLOITED', faultyLink: 'T1',
        expected: 'ligne économique de la source (indice financier T1 ou arbitrage T3), ou exclusion motivée',
        observed: silencieux,
        detail: { pendingContract: T1_FINANCIAL_HINT_CONTRACT, inclusionContract: TCO_T3_DECISION_REQUEST, ...t3, resolution: 'USER_DECISION', t1Relaunch: false, count: silencieux.length },
        inputHash: hashOf({ assetId, silencieux, t3Contract }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    // Lot 113AL : la réparation POSE les demandes d'arbitrage T3 (aucun appel IA ici) ; la décision vient du passage T3
    // de fond — issue en attente (jamais un faux « réparé »), recontrôle au contrôle suivant.
    const out = new Map<number, RepairResult>();
    const { requestQualificationReviews } = await import('@/services/business-operations/tco/semantic-qualification/review');
    const trigger = ctx.trigger === 'TARGETED' ? 'EVIDENCE_CHANGE' : 'COHERENCE';
    for (const { id, inspection } of items) {
      const demandes = ((inspection.detail?.requests ?? []) as DemandeT3[]);
      const n = demandes.length ? await requestQualificationReviews(ctx.sql as never, accountId, id, demandes, trigger) : 0;
      out.set(id, {
        called: true, service: 'requestQualificationReviews', aiCalls: 0, pending: true, reevaluation: 'SEMANTIC_REEVALUATION_T3',
        result: { requested: n, documents: demandes.map((d) => d.fileId) }, rollbackRef: 'economic_qualification_reviews',
      });
    }
    return out;
  },
};
