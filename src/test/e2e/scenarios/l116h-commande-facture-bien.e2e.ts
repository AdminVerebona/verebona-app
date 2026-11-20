/**
 * Carte #819 (lot 116H) — commande → facture : rattachement au bien par
 * l'opération et date principale — PostgreSQL 16 réel.
 *
 * Cas reproduit (préproduction, compte 13 — AUCUN accès d'ici : données
 * synthétiques, fournisseur d'IA SIMULÉ rendant ce que la carte rapporte) :
 *   · bon de commande du 17/11/2026 (commande FR61L4LRPKVR, article 4911471
 *     « Polisport Groovy coussin gris », 9,99 € TTC), rattaché au vélo
 *     « Jean Fourche » ; son opération d'achat porte le vélo ;
 *   · facture du 20/11/2026, déposée SANS bien ; T1 délègue le rattachement ;
 *   · `t3_operation_match` rend SAME_OPERATION / ATTACH / certain ;
 *   · `t3_link_ambiguity` (résolution du bien) ne retient aucun des cinq
 *     biens ; son contexte porte `crossDocument.documentIdentity.status = NONE`.
 *
 * Chemins de PRODUCTION : barrière et persistance T1, titre, consolidation T3
 * (`consolidateAccountOperations`, M3 par la passerelle réelle et son rejeu),
 * résolution du bien (`resolveDocumentAsset`), projection T4, producteurs
 * « À traiter », page de l'opération, Timeline du bien, coût de possession,
 * contrôle de cohérence COH-DOC-PRIMARY-LINK, reprise (`repriseOrderInvoice`).
 *
 *   L116H-E2E-01  (4.A) parcours neuf, ordre nominal : même opération, facture rattachée au vélo par l'opération, aucune carte, date principale = date de la facture
 *   L116H-E2E-02  (4.C) ordre INVERSE : la résolution du bien passe AVANT le rapprochement (carte ouverte, abstention mémorisée) ; l'enregistrement de la relation la résout
 *   L116H-E2E-03  (4.C) course : la relation est enregistrée PENDANT l'appel au modèle de la résolution du bien — ni carte ni abstention durable
 *   L116H-E2E-04  (4.B simulée) cas déjà enregistré (document 395, opération 116, carte 775) : relevé avant, reprise à blanc, reprise réelle, idempotence
 *   L116H-E2E-05  (4.C) stabilité : T3, « À traiter » et cohérence rejoués — aucune recréation de carte, aucun doublon, aucun retour au 17/11 ; convergence des lectures
 *   L116H-E2E-06  (4.D) garde-fous : commande seule, deux achats du même vélo, refus et rattachement de l'utilisateur, opération à plusieurs biens, isolation des comptes
 *   L116H-E2E-07  (4.D) dates : correction de l'utilisateur jamais écrasée, plusieurs factures, acompte, intervention — règles existantes inchangées
 *   L116H-E2E-08  (4.B, durabilité) même cas déjà enregistré repris par le SEUL contrôle de cohérence (sans le script) : COH-DOC-PRIMARY-LINK puis COH-OPS-ACQUISITION-DATE
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, fh, cible, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';
import type { RecordedOutput } from '../replay-gateway';
import { gateOperationCandidates, type AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

/**
 * Commutateurs du scénario (jamais en production) :
 *   · `sansDeclenchement` : reproduit l'état laissé par la version PRÉCÉDENTE — l'enregistrement de la relation
 *     document – opération ne déclenchait aucune réévaluation du rattachement (stock de la section 4.B, course 03b) ;
 *   · `avantCarte` : action concurrente exécutée juste avant l'écriture de la carte « À traiter » (course 03c).
 */
const bascule = vi.hoisted(() => ({ sansDeclenchement: false, avantCarte: null as null | (() => Promise<void>) }));
vi.mock('@/services/ai/reconciliation/document-asset/operation-inheritance.store', async (o) => {
  const m = await o<typeof import('@/services/ai/reconciliation/document-asset/operation-inheritance.store')>();
  return {
    ...m,
    reevaluateOperationDocuments: (...a: Parameters<typeof m.reevaluateOperationDocuments>) =>
      (bascule.sansDeclenchement ? Promise.resolve({ examined: [], attached: [], errors: [] }) : m.reevaluateOperationDocuments(...a)),
  };
});
vi.mock('@/services/to-process/to-process-action.service', async (o) => {
  const m = await o<typeof import('@/services/to-process/to-process-action.service')>();
  return {
    ...m,
    upsertAction: async (...a: Parameters<typeof m.upsertAction>) => {
      const avant = bascule.avantCarte;
      bascule.avantCarte = null;
      if (avant) await avant();
      return m.upsertAction(...a);
    },
  };
});

type Json = Record<string, any>;
type Compte = AccountRow & { owner: { id: number } };
const AUJ = '2026-11-20';
const COMMANDE = 'FR61L4LRPKVR';
const DESIGNATION = 'Polisport groovy coussin gris';
const TITRE_BON = `Bon de commande ${DESIGNATION}`;
const NOM_ACHAT = `Achat ${DESIGNATION}`;
const JOUR_COMMANDE = '2026-11-17';
const JOUR_FACTURE = '2026-11-20';
/**
 * Le vendeur n'est pas désigné de la même façon sur le bon et sur la facture : la référence de commande commune
 * ne suffit alors pas au rapprochement déterministe (référence « fragile », lot 53) — c'est `t3_operation_match`
 * qui tranche, comme dans le cas réel (appel 16252).
 */
const VENDEUR_FACTURE = 'Cycles Exemple Web';

/** Sortie SIMULÉE de `t3_operation_match` : celle de l'appel 16252 de la carte. */
const m3Meme = (operationId: number): RecordedOutput => ({
  operationCode: 't3_operation_match', task: 'OPERATION_MATCH',
  output: {
    task: 'OPERATION_MATCH', decision: 'SAME_OPERATION', matchedCandidateId: operationId, confidence: 'certain', resolution: 'ATTACH',
    concordantSignals: ['même numéro de commande', 'même article', 'même montant', 'même fournisseur'], contradictions: [], reason: 'facture de la commande',
  },
});

scenario('L116H', 'Commande → facture : rattachement au bien par l’opération, carte LINK-ASSET, date principale, reprise (carte #819)', ({ sql, make, useRecordings }) => {
  const k = operationsKit(sql, make);

  // ── Outils ────────────────────────────────────────────────────────────────
  /** Compte du cas : cinq biens (ceux que la carte 775 proposait), dont le vélo. */
  async function compteCas(): Promise<{ compte: Compte; velo: AssetRow; autres: AssetRow[] }> {
    const compte = await make.account({ plan: 'premium' });
    const autres = [
      await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' }),
      await make.asset(compte, { category: 'OBJET', name: 'Draisienne' }),
      await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' }),
      await make.asset(compte, { category: 'VEHICULE', name: 'Polo' }),
    ];
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo Jean Fourche' });
    return { compte, velo, autres };
  }
  function barriere(typeDocument: string | null, brut: AnchoredOperationCandidate): AnchoredOperationCandidate[] {
    return gateOperationCandidates([brut], {
      hasExploitableContent: true, documentTypeCode: typeDocument,
      verifiedIds: { ASSET: new Set(brut.targetHints.flatMap((t) => (t.entityId ? [t.entityId] : []))), EQUIPMENT: new Set(), ROOM: new Set() },
      capabilities: { rooms: false, equipments: false }, keptFactRefs: new Set(['f1']),
    }).candidates;
  }
  /** Analyse T1 d'un document (modèle simulé) : type, date, titre, candidat (barrière réelle), connaissance persistée, titre métier. */
  async function analyser(compte: AccountRow, assetId: number | null, o: {
    type: string; titre: string; date: string; candidat: AnchoredOperationCandidate; montant?: number; fournisseur?: string; texte?: string;
  }): Promise<number> {
    const id = await k.document(compte, assetId, barriere(o.type, o.candidat), { type: o.type, amountCents: o.montant ?? 999, date: o.date });
    const fournisseur = o.fournisseur ?? 'Cycles Exemple';
    await sql`UPDATE asset_files SET supplier = ${fournisseur}, title_source = 'SYSTEM', last_analysis_at = now(), original_filename = ${`scan-${id}.pdf`} WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = ${o.titre}, supplier_name = ${fournisseur}, document_date = ${o.date}, document_type_code = ${o.type},
                     full_text = ${o.texte ?? `${o.titre}\nCommande ${COMMANDE}\nArticle 4911471 ${DESIGNATION}\nTotal TTC 9,99 €`} WHERE file_id = ${id}`;
    const raw = { task: 'ANALYZE_DOCUMENT', document: {
      title: { value: o.titre, confidence: 'certain' }, type: { value: o.type, confidence: 'certain' },
      supplier: { value: { name: fournisseur }, confidence: 'certain' }, date: { value: o.date, confidence: 'certain' },
    } };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${id}, ${`h${id}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${compte.id}, ${JSON.stringify(raw)})`;
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    await ensureBusinessTitle({ fileId: id, accountId: compte.id, origin: 'T1', mode: 'refresh' });
    return id;
  }
  /** Bon de commande du 17/11, rattaché au vélo. `paye` : la commande est payée à la commande (paiement daté lu sur le bon). */
  const bon = (compte: AccountRow, veloId: number, o: { paye?: boolean; commande?: string; designation?: string; montant?: number; date?: string; fournisseur?: string } = {}) =>
    analyser(compte, veloId, {
      type: 'ACQUISITION_ORDER', titre: `Bon de commande ${o.designation ?? DESIGNATION}`, date: o.date ?? JOUR_COMMANDE, montant: o.montant ?? 999, fournisseur: o.fournisseur,
      candidat: cand({
        typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', summary: 'Coussin pour siège enfant', provider: o.fournisseur ?? 'Cycles Exemple',
        targetHints: [cible(veloId)], businessReferences: [ref('ORDER', o.commande ?? COMMANDE)] as never,
        financialHints: [fh('REALIZED_COST', o.montant ?? 999, o.paye ? { economicDate: o.date ?? JOUR_COMMANDE } : {}),
          ...(o.paye ? [fh('PAYMENT', o.montant ?? 999, { economicDate: o.date ?? JOUR_COMMANDE })] : [])],
      }),
    });
  /**
   * Facture du 20/11, déposée SANS bien : T1 extrait la commande, la date de commande, le montant ; il ne désigne aucun
   * bien (rattachement délégué à T3). `dateAchat` : date de réalisation proposée par le modèle (date de COMMANDE dans le cas réel).
   */
  const facture = (compte: AccountRow, o: { commande?: string | null; dateAchat?: string | null; date?: string; montant?: number; designation?: string; assetId?: number | null; role?: AnchoredOperationCandidate['sourceRoleHint']; fournisseur?: string } = {}) =>
    analyser(compte, o.assetId ?? null, {
      type: 'ACQUISITION_INVOICE', titre: `Facture ${o.designation ?? DESIGNATION}`, date: o.date ?? JOUR_FACTURE, montant: o.montant ?? 999, fournisseur: o.fournisseur,
      candidat: cand({
        typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: o.role ?? 'INVOICE', summary: 'Coussin pour siège enfant', provider: o.fournisseur ?? 'Cycles Exemple',
        targetHints: [], businessReferences: [ref('INVOICE', `FA-${o.date ?? JOUR_FACTURE}`), ...(o.commande === null ? [] : [ref('ORDER', o.commande ?? COMMANDE)])] as never,
        temporalHints: o.dateAchat === null ? {} : { realizedDate: o.dateAchat ?? JOUR_COMMANDE },
        financialHints: [fh('REALIZED_COST', o.montant ?? 999, { economicDate: o.dateAchat === null ? null : o.dateAchat ?? JOUR_COMMANDE })],
      }),
    });
  /** Passage T3 des opérations ; `m3` : sorties rejouées de `t3_operation_match` (passerelle réelle). */
  const rejouer = useRecordings;
  async function passer(compte: AccountRow, m3: RecordedOutput[] | false = false) {
    if (m3 === false) return k.passer(compte, { today: AUJ });
    await rejouer(m3);
    return k.passer(compte, { today: AUJ, operationMatch: {} });
  }
  /** Variables reçues par `t3_link_ambiguity` (modèle simulé : aucun bien retenu, comme les appels 16253 et 16264). */
  const vus: Array<Record<string, unknown>> = [];
  const aucunBien = async (p: { variables: Record<string, unknown> }) => { vus.push(p.variables); return { task: 'LINK_AMBIGUITY' as const, matches: [] }; };
  const depsIa = { callModel: aucunBien, crossContractActive: async () => true, aiConfigSignature: async () => 'sig-e2e' };
  /** Résolution du bien d'un document (travail T3 `document_asset`), modèle simulé. */
  async function resoudre(compte: AccountRow, fileId: number, deps: Record<string, unknown> = depsIa, input: Record<string, unknown> = {}) {
    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service');
    return resolveDocumentAsset({ accountId: compte.id, fileId, triggerCode: 'source_analyzed', ...input }, deps as never);
  }
  const achats = (compte: AccountRow) => sql<Json[]>`
    SELECT o.id::int AS id, o.status, o.technical_label AS label, o.realized_date::text AS realized, o.planned_date::text AS planned,
           o.attribute_provenance -> 'fields' -> 'realizedDate' AS prov
      FROM business_operations o WHERE o.account_id = ${compte.id} AND o.type_code = 'ACQUISITION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL ORDER BY o.id`;
  const bienDe = async (fileId: number) => (await sql<Json[]>`
    SELECT f.asset_id AS colonne, f.document_date::text AS date, f.document_type_code AS type,
           (SELECT json_agg(json_build_object('asset', l.asset_id, 'role', l.link_role, 'origin', l.origin) ORDER BY l.id)
              FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL) AS liens
      FROM asset_files f WHERE f.id = ${fileId}`)[0];
  const cartesBien = (fileId: number) => sql<Json[]>`
    SELECT a.id::int AS id, a.resolved_at IS NOT NULL AS fermee, a.resolution_reason AS motif, a.action_kind AS nature,
           (SELECT e.details ->> 'reason' FROM to_process_action_events e WHERE e.action_id = a.id ORDER BY e.id DESC LIMIT 1) AS detail
      FROM to_process_actions a WHERE a.target_type = 'DOCUMENT' AND a.target_id = ${fileId} AND a.rule_code = 'LINK-ASSET' ORDER BY a.id`;
  const resolution = async (fileId: number) => (await sql<Json[]>`
    SELECT status, method, reason_code, decided_asset_ids, last_evaluation AS e FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0];
  const membres = (operationId: number) => sql<Json[]>`
    SELECT s.source_entity_key::int AS file, s.match_method AS methode, s.confidence, s.authority
      FROM business_operation_sources s WHERE s.operation_id = ${operationId} AND s.active AND s.source_kind = 'DOCUMENT' ORDER BY s.id`;
  const evenements = (compte: AccountRow) => sql<Json[]>`
    SELECT ai.id::int AS id, ai.title, ai.start_date::text AS date, ai.business_operation_id::int AS op FROM agenda_items ai WHERE ai.account_id = ${compte.id} ORDER BY ai.id`;
  const page = async (compte: AccountRow, op: number) => {
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    return (await readReferenceEventPage(compte.id, op))!;
  };
  const timeline = async (compte: AccountRow, assetId: number) => {
    const { readAssetTimelineAll } = await import('@/services/agenda/timeline/read');
    return (await readAssetTimelineAll({ accountId: compte.id, assetId, today: AUJ })) as unknown as Json[];
  };

  afterEach(() => { bascule.sansDeclenchement = false; bascule.avantCarte = null; });
  const historique = async (compte: AccountRow, operationId: number) => sql<Json[]>`
    SELECT event_type, reason_code, before_json AS avant, after_json AS apres FROM business_operation_history
     WHERE account_id = ${compte.id} AND operation_id = ${operationId} ORDER BY id`;
  const projeter = async (compte: AccountRow) =>
    (await import('@/services/business-operations/agenda-projection/service')).projectAccountOperations(compte.id, { all: true, today: AUJ, correlationId: 'e2e-116h' });
  /**
   * Cartes « À traiter » OUVERTES du compte après le passage des producteurs de l'Agenda. La question « prestataires
   * différents pour le même achat » (vendeur désigné autrement sur le bon et sur la facture) relève d'un autre ticket
   * (faux conflits de fournisseur, carte #819 §1.A) : elle est écartée ici, et sa stabilité est vérifiée à part.
   */
  const cartesAgenda = async (compte: AccountRow) => {
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    await produceAgendaActions(compte.id, { trigger: 'SWEEP' });
    return sql<Json[]>`SELECT id::int AS id, rule_code, question FROM to_process_actions
                        WHERE account_id = ${compte.id} AND resolved_at IS NULL AND NOT (rule_code = 'OPERATION-ATTRIBUTE' AND trigger_context ->> 'field' = 'provider') ORDER BY id`;
  };
  const toutesCartes = (compte: AccountRow) => sql<Json[]>`SELECT id::int AS id, rule_code FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL ORDER BY id`;
  const notifications = async (compte: AccountRow) => (await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`)[0].n as number;
  const documentsDuBien = async (compte: AccountRow, assetId: number) => {
    const { listAssetDocuments } = await import('@/services/documents/document-asset-links');
    return (await listAssetDocuments(compte.id, assetId, { roles: ['PRIMARY'] })).map((l) => l.fileId);
  };
  const inspecter = async (compte: AccountRow, ids: number[]) => {
    const { documentPrimaryLinkCheck } = await import('@/services/coherence/registry/checks/document-primary-link');
    const { pgClient } = await import('@/db');
    return documentPrimaryLinkCheck.inspect!({ sql: pgClient as never, now: new Date(), today: AUJ, mode: 'DRY_RUN', correlationId: 'e2e-116h' }, compte.id, ids);
  };
  /** Contrôle COH-OPS-ACQUISITION-DATE (inspection, lecture seule) d'une opération. */
  const inspecterDate = async (compte: AccountRow, operationId: number) => {
    const { operationsAcquisitionDateCheck } = await import('@/services/coherence/registry/checks/operations-acquisition-date');
    const { pgClient } = await import('@/db');
    const ctx = { sql: pgClient as never, now: new Date(), today: AUJ, mode: 'DRY_RUN' as const, correlationId: 'e2e-116h' };
    return { check: operationsAcquisitionDateCheck, ctx, inspection: (await operationsAcquisitionDateCheck.inspect!(ctx, compte.id, [operationId])).get(operationId)! };
  };
  const reprise = async (compte: AccountRow, apply = false) =>
    (await import('@/services/business-operations/consolidation/order-invoice-reprise')).repriseOrderInvoice(compte.id, { apply, today: AUJ });
  /**
   * ÉTAT DÉJÀ ENREGISTRÉ (cas réel : document 395, opération 116, carte 775) : la résolution du bien passe (carte
   * ouverte, abstention mémorisée), puis le rapprochement d'opération rattache la facture — par la version PRÉCÉDENTE
   * (aucune réévaluation du rattachement, date principale restée à la date de commande).
   */
  async function casEnregistre() {
    const { compte, velo, autres } = await compteCas();
    const fb = await bon(compte, velo.id, { paye: true });
    await passer(compte);
    const [op] = await achats(compte);
    const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
    vus.length = 0;
    await resoudre(compte, ff); // appel 16253 : aucun bien retenu → carte
    bascule.sansDeclenchement = true;
    await passer(compte, [m3Meme(op.id)]); // appel 16252 : SAME_OPERATION / ATTACH / certain
    bascule.sansDeclenchement = false;
    // Date principale telle que la version précédente l'a laissée : celle de la commande (la provenance pointait la source de la facture).
    await sql`UPDATE business_operations SET realized_date = ${JOUR_COMMANDE},
                     attribute_provenance = jsonb_set(attribute_provenance, '{fields,realizedDate}',
                       jsonb_build_object('sourceId', (attribute_provenance -> 'fields' -> 'realizedDate' ->> 'sourceId')::int, 'value', ${JOUR_COMMANDE}::text))
               WHERE id = ${op.id}`;
    await sql`DELETE FROM business_operation_history WHERE operation_id = ${op.id} AND reason_code = 'T3_INVOICE_DATE_AFTER_ORDER'`;
    return { compte, velo, autres, fb, ff, op: op.id as number };
  }

  /** État attendu une fois la chaîne terminée (sections 4.A et 4.B de la carte). */
  async function attendreEtatFinal(compte: Compte, velo: AssetRow, fb: number, ff: number, operationId: number, o: { resolution?: boolean } = {}) {
    // Une seule opération, celle du bon ; deux documents distincts, chacun une fois.
    const ops = await achats(compte);
    expect(ops.map((o) => o.id)).toEqual([operationId]);
    expect((await membres(operationId)).map((m) => m.file)).toEqual([fb, ff]);
    // La facture est rattachée au vélo PAR l'opération (même relation que tout rattachement automatique : lien + colonne, origine tracée).
    const b = await bienDe(ff);
    expect(b.colonne).toBe(velo.id);
    expect(b.liens).toEqual([expect.objectContaining({ asset: velo.id, role: 'PRIMARY' })]);
    expect(b.liens[0].origin).toBe('AI');
    if (o.resolution !== false) {
      const res = await resolution(ff);
      expect(res).toMatchObject({ status: 'RESOLVED', method: 'DETERMINISTIC', reason_code: `OPERATION_ASSET:${operationId}`, decided_asset_ids: [velo.id] });
      expect(res.e).toMatchObject({ branch: 'OPERATION', aiCalled: false, operation: { status: 'TARGET', operationId, targetAssetId: velo.id } });
    }
    // Provenance du lien : relation structurelle par l'opération, admise par la garde et journalisée.
    const [adm] = await sql<Json[]>`SELECT rule, decisive_proof FROM document_asset_link_admissions WHERE file_id = ${ff} AND asset_id = ${velo.id} AND decision = 'ADMITTED' ORDER BY id LIMIT 1`;
    expect(adm).toMatchObject({ rule: `OPERATION:OPERATION_ASSET:${operationId}`, decisive_proof: { kind: 'STRUCTURAL', detail: `OPERATION_MEMBERSHIP:${operationId}` } });
    // Aucune question de rattachement restée ouverte.
    expect((await cartesBien(ff)).filter((c) => !c.fermee)).toEqual([]);
    // Date principale = date de la facture ; provenance : la facture ; chaque document garde sa date.
    expect(ops[0]).toMatchObject({ status: 'REALIZED', realized: JOUR_FACTURE, label: NOM_ACHAT });
    expect(ops[0].prov).toMatchObject({ value: JOUR_FACTURE, origin: 'INVOICE_DOCUMENT_DATE' });
    expect((await bienDe(fb)).date).toBe(JOUR_COMMANDE);
    expect(b.date).toBe(JOUR_FACTURE);
  }

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L116H-E2E-01 — parcours neuf (ordre nominal) : commande du 17/11 liée au vélo, puis facture du 20/11 → même opération, facture rattachée au vélo par l’opération, aucune question, date principale 20/11', async () => {
    const { compte, velo } = await compteCas();
    const fb = await bon(compte, velo.id, { paye: true });
    await passer(compte);
    const [op] = await achats(compte);
    // Tant que seule la commande est connue : le repère de l'opération vient de la commande.
    expect((await page(compte, op.id)).presentation?.date).toBe(JOUR_COMMANDE);
    // Même numéro de commande, vendeur désigné autrement : le rapprochement sémantique (M3) tranche.
    const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
    // Rapprochement d'opération : SAME_OPERATION / ATTACH / certain (modèle simulé, passerelle réelle).
    vus.length = 0;
    const r = await passer(compte, [m3Meme(op.id)]);
    expect(r.m3).toMatchObject({ calls: 1 });
    expect(await k.candidat(ff)).toEqual([expect.objectContaining({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op.id })]);
    expect((await membres(op.id)).map((m) => [m.file, m.methode, m.confidence])).toEqual([[fb, null, 'certain'], [ff, 'M3', 'certain']]);
    // L'enregistrement de la relation a rattaché la facture au vélo dans le MÊME passage (aucun travail de plus).
    expect(r.operationAssetLinks).toBe(1);
    await attendreEtatFinal(compte, velo, fb, ff, op.id);
    // Le travail `document_asset` de la facture, exécuté ensuite, n'a plus rien à décider.
    expect(await resoudre(compte, ff)).toMatchObject({ outcome: 'NO_CHANGE', status: 'ALREADY_LINKED', aiCalled: false });
    await attendreEtatFinal(compte, velo, fb, ff, op.id, { resolution: false });
    // Aucun appel au modèle de rattachement n'a été nécessaire, aucune carte n'a jamais existé.
    expect(vus).toEqual([]);
    expect(await cartesBien(ff)).toEqual([]);
    // Fiche de l'opération et Timeline du vélo : même date principale.
    expect((await page(compte, op.id)).presentation).toMatchObject({ date: JOUR_FACTURE, basis: 'REALIZED' });
    const tl = await timeline(compte, velo.id);
    expect(tl.filter((e) => e.kind === 'group').map((e) => [e.title, e.effectiveDate, e.dateBasis])).toEqual([[NOM_ACHAT, JOUR_FACTURE, 'REALIZED']]);
    // Un seul achat, un seul coût réalisé de 9,99 € ; le vélo lui-même n'a ni date ni prix d'achat.
    expect((await k.composantes(op.id)).filter((c) => c.kind === 'REALIZED_COST').map((c) => c.amount_minor)).toEqual([999]);
    expect(await k.coutNet(op.id)).toBe(999);
    const [fiche] = await sql<Json[]>`SELECT key_characteristics::jsonb ->> 'acquisitionDate' AS d, key_characteristics::jsonb ->> 'acquisitionPrice' AS p FROM assets WHERE id = ${velo.id}`;
    expect(fiche).toEqual({ d: null, p: null });
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('L116H-E2E-02 — ordre INVERSE : la résolution du bien passe AVANT le rapprochement (contexte NONE, cinq biens proposés, aucun retenu, carte ouverte, abstention mémorisée) ; l’enregistrement de la relation la résout et ferme la carte', async () => {
    const { compte, velo, autres } = await compteCas();
    const fb = await bon(compte, velo.id, { paye: true });
    await passer(compte);
    const [op] = await achats(compte);
    const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
    // 1. Résolution du bien AVANT le rapprochement : exactement ce que la carte rapporte (appel 16253).
    vus.length = 0;
    expect(await resoudre(compte, ff)).toMatchObject({ outcome: 'ABSTAIN', status: 'NO_CANDIDATE', aiCalled: true });
    expect(vus).toHaveLength(1);
    expect(JSON.parse(String(vus[0].SUBJECT_CONTEXT)).crossDocument).toMatchObject({ documentIdentity: { status: 'NONE' } });
    expect((vus[0].CANDIDATES as Array<{ candidateId: number }>).map((c) => c.candidateId).sort((a, b) => a - b)).toEqual([...autres.map((a) => a.id), velo.id].sort((a, b) => a - b));
    const [carte] = await cartesBien(ff);
    expect(carte).toMatchObject({ fermee: false, nature: 'COMPLETE' });
    const avant = await resolution(ff);
    expect(avant).toMatchObject({ status: 'NO_CANDIDATE' });
    expect(avant.e.aiMemory).toMatchObject({ path: 'SEMANTIC', reasonCode: 'NO_CANDIDATE' }); // abstention mémorisée
    // 2. Rapprochement d'opération : la relation est enregistrée → réévaluation immédiate du rattachement.
    const r = await passer(compte, [m3Meme(op.id)]);
    expect(r.operationAssetLinks).toBe(1);
    await attendreEtatFinal(compte, velo, fb, ff, op.id);
    // La carte ouverte est FERMÉE (jamais reformulée ni filtrée), avec son motif tracé.
    expect(await cartesBien(ff)).toEqual([{ id: carte.id, fermee: true, motif: 'OBSOLETE', nature: 'COMPLETE', detail: `RESOLVED_BY_OPERATION:${op.id}` }]);
    // Aucun nouvel appel au modèle ; l'abstention mémorisée ne décide plus de rien.
    expect(vus).toHaveLength(1);
    expect(await resoudre(compte, ff)).toMatchObject({ outcome: 'NO_CHANGE', status: 'ALREADY_LINKED', aiCalled: false });
    expect((await cartesBien(ff)).filter((c) => !c.fermee)).toEqual([]);
    expect(vus).toHaveLength(1);
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L116H-E2E-03 — course : la relation est enregistrée PENDANT l’appel au modèle de la résolution du bien (contexte construit avant) — ni abstention durable ni carte ; carte écrite pendant un rattachement concurrent : refermée', async () => {
    // a) Le passage T3 complet (avec sa réévaluation) se termine pendant l'appel au modèle.
    {
      const { compte, velo } = await compteCas();
      const fb = await bon(compte, velo.id, { paye: true });
      await passer(compte);
      const [op] = await achats(compte);
      const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
      let appels = 0;
      const pendant = async () => { appels += 1; await passer(compte, [m3Meme(op.id)]); return { task: 'LINK_AMBIGUITY' as const, matches: [] }; };
      // Le rattachement a été posé par la réévaluation du rapprochement : le travail en cours s'efface devant lui.
      expect(await resoudre(compte, ff, { ...depsIa, callModel: pendant })).toMatchObject({ outcome: 'NO_CHANGE', status: 'ALREADY_LINKED' });
      expect(appels).toBe(1);
      await attendreEtatFinal(compte, velo, fb, ff, op.id, { resolution: false });
      expect(await cartesBien(ff)).toEqual([]);
    }
    // b) Seule la relation est enregistrée pendant l'appel (aucune réévaluation par le rapprochement) : la relecture
    //    juste avant l'abstention suffit — l'évaluation est rejouée une fois, sans second appel au modèle.
    {
      const { compte, velo } = await compteCas();
      const fb = await bon(compte, velo.id, { paye: true });
      await passer(compte);
      const [op] = await achats(compte);
      const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
      let appels = 0;
      const pendant = async () => {
        appels += 1;
        bascule.sansDeclenchement = true;
        await passer(compte, [m3Meme(op.id)]);
        bascule.sansDeclenchement = false;
        return { task: 'LINK_AMBIGUITY' as const, matches: [] };
      };
      expect(await resoudre(compte, ff, { ...depsIa, callModel: pendant })).toMatchObject({ outcome: 'APPLIED', status: 'RESOLVED' });
      expect(appels).toBe(1);
      expect(await cartesBien(ff)).toEqual([]);
      // Le bien du document entre dans la version de sa source : le passage T3 suivant la reconsolide, puis plus rien ne bouge.
      await passer(compte);
      await attendreEtatFinal(compte, velo, fb, ff, op.id);
      const h = await k.historique(compte);
      await passer(compte);
      expect(await k.historique(compte)).toBe(h);
    }
    // c) Un rattachement est posé entre la relecture et l'écriture de la carte : la carte tout juste écrite est refermée.
    {
      const { compte, velo } = await compteCas();
      await bon(compte, velo.id, { paye: true });
      await passer(compte);
      const [op] = await achats(compte);
      const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
      bascule.avantCarte = async () => { await passer(compte, [m3Meme(op.id)]); };
      expect(await resoudre(compte, ff)).toMatchObject({ outcome: 'SUPERSEDED', status: 'ALREADY_LINKED' });
      expect((await bienDe(ff)).colonne).toBe(velo.id);
      expect((await cartesBien(ff)).filter((c) => !c.fermee)).toEqual([]);
      expect(await resolution(ff)).toMatchObject({ status: 'ALREADY_LINKED' });
    }
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('L116H-E2E-04 — cas déjà enregistré (document 395, opération 116, carte 775 simulés) : relevé avant, reprise à blanc (rien n’est écrit), reprise réelle (mêmes identifiants, carte close avec motif, date 20/11), idempotence', async () => {
    const { compte, velo, fb, ff, op } = await casEnregistre();
    // ── RELEVÉ AVANT (section 4.B, première case) : c'est l'état que la carte décrit.
    const [carte] = await cartesBien(ff);
    expect(carte).toMatchObject({ fermee: false });
    expect(await bienDe(ff)).toMatchObject({ colonne: null, liens: null });
    expect(await resolution(ff)).toMatchObject({ status: 'NO_CANDIDATE', reason_code: 'NO_CANDIDATE' });
    expect((await membres(op)).map((m) => [m.file, m.methode])).toEqual([[fb, null], [ff, 'M3']]);
    expect((await achats(compte))[0]).toMatchObject({ id: op, realized: JOUR_COMMANDE });
    expect((await page(compte, op)).presentation).toMatchObject({ date: JOUR_COMMANDE, basis: 'REALIZED' });
    expect(await documentsDuBien(compte, velo.id)).toEqual([fb]);
    // Le contrôle de cohérence voit l'écart, et le dit réparable par la règle de l'opération.
    expect((await inspecter(compte, [ff])).get(ff)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'PRIMARY_LINK_RECOVERABLE', detail: { expectedAssetIds: [velo.id], rule: `OPERATION_ASSET:${op}` } });
    expect((await inspecterDate(compte, op)).inspection).toMatchObject({
      verdict: 'REPAIRABLE', anomaly: 'ACQUISITION_DATE_INVOICE_AFTER_ORDER', expected: { realizedDate: JOUR_FACTURE }, observed: { realizedDate: JOUR_COMMANDE } });
    // Événement d'achat déjà projeté (la facture prouve l'achat) : daté du 17/11 par la version précédente.
    await projeter(compte);
    expect(await evenements(compte)).toEqual([expect.objectContaining({ title: NOM_ACHAT, date: JOUR_COMMANDE, op })]);
    const avant = { historique: await k.historique(compte), notifications: await notifications(compte), fichiers: (await sql`SELECT id FROM asset_files WHERE account_id = ${compte.id}`).length,
      liens: (await sql`SELECT id FROM document_asset_links WHERE account_id = ${compte.id}`).length, composantes: await k.composantes(op), evenement: (await evenements(compte))[0].id };

    // ── REPRISE À BLANC : rapport seul.
    const blanc = await reprise(compte);
    expect(blanc).toMatchObject({ applied: false, attached: 0, cardsClosed: 0, datesChanged: 0, remaining: false });
    expect(blanc.attachments).toEqual([expect.objectContaining({ fileId: ff, operationId: op, assetId: velo.id, assetName: 'Vélo Jean Fourche', openCardIds: [carte.id], documentDate: JOUR_FACTURE })]);
    expect(blanc.dates).toEqual([{ operationId: op, label: NOM_ACHAT, current: JOUR_COMMANDE, expected: JOUR_FACTURE, invoiceFileId: ff, orderDates: [JOUR_COMMANDE], protectedByUser: false }]);
    expect(await k.historique(compte)).toBe(avant.historique);
    expect(await bienDe(ff)).toMatchObject({ colonne: null, liens: null });
    expect((await cartesBien(ff))[0].fermee).toBe(false);
    expect((await achats(compte))[0].realized).toBe(JOUR_COMMANDE);

    // ── REPRISE RÉELLE.
    const reel = await reprise(compte, true);
    expect(reel).toMatchObject({ applied: true, attached: 1, cardsClosed: 1, datesChanged: 1, agenda: { created: 0, updated: 1, removed: 0 } });
    await attendreEtatFinal(compte, velo, fb, ff, op);
    // Mêmes identifiants : même opération, mêmes documents, même carte (fermée avec son motif), même événement.
    expect(await cartesBien(ff)).toEqual([{ id: carte.id, fermee: true, motif: 'OBSOLETE', nature: 'COMPLETE', detail: `RESOLVED_BY_OPERATION:${op}` }]);
    expect(await documentsDuBien(compte, velo.id)).toEqual([fb, ff]);
    expect((await sql`SELECT id FROM asset_files WHERE account_id = ${compte.id}`).length).toBe(avant.fichiers);
    expect((await sql`SELECT id FROM document_asset_links WHERE account_id = ${compte.id}`).length).toBe(avant.liens + 1);
    // Date principale : trace (ancienne valeur, nouvelle valeur, motif) et provenance (source : la facture).
    const trace = (await historique(compte, op)).filter((h) => h.reason_code === 'T3_INVOICE_DATE_AFTER_ORDER');
    expect(trace).toEqual([{ event_type: 'UPDATED', reason_code: 'T3_INVOICE_DATE_AFTER_ORDER', avant: { realized_date: JOUR_COMMANDE }, apres: { realized_date: JOUR_FACTURE } }]);
    const [src] = await sql<Json[]>`SELECT id::int AS id FROM business_operation_sources WHERE operation_id = ${op} AND source_entity_key = ${String(ff)} AND active`;
    expect((await achats(compte))[0].prov).toEqual({ sourceId: src.id, value: JOUR_FACTURE, origin: 'INVOICE_DOCUMENT_DATE' });
    // Agenda : le MÊME événement suit la date ; aucun second événement, aucune notification, aucune question de date.
    expect(await evenements(compte)).toEqual([expect.objectContaining({ id: avant.evenement, title: NOM_ACHAT, date: JOUR_FACTURE, op })]);
    expect(await notifications(compte)).toBe(avant.notifications);
    expect(await cartesAgenda(compte)).toEqual([]);
    // Un seul achat, un seul coût réalisé de 9,99 € — les composantes n'ont pas bougé (ni montant, ni date de paiement).
    expect(await k.composantes(op)).toEqual(avant.composantes);
    expect(await k.coutNet(op)).toBe(999);
    expect((await achats(compte)).length).toBe(1);

    expect((await inspecterDate(compte, op)).inspection.anomaly ?? null).not.toBe('ACQUISITION_DATE_INVOICE_AFTER_ORDER');
    expect((await inspecter(compte, [ff])).get(ff)).toMatchObject({ verdict: 'CONSISTENT' });

    // ── IDEMPOTENCE : un second passage ne trouve plus rien et n'écrit rien.
    const h = await k.historique(compte);
    const encore = await reprise(compte, true);
    expect(encore).toMatchObject({ applied: false, attachments: [], dates: [], attached: 0, datesChanged: 0 });
    expect(await k.historique(compte)).toBe(h);
    expect((await evenements(compte)).length).toBe(1);
  });

  // ══ 05 ═══════════════════════════════════════════════════════════════════

  it('L116H-E2E-05 — stabilité après correction : T3, T4, « À traiter » et cohérence rejoués — aucune carte recréée, aucun doublon, aucun retour au 17/11 ; sans le script, le réexamen de la carte ouverte suffit ; lectures convergentes', async () => {
    const { compte, velo, fb, ff, op } = await casEnregistre();
    await projeter(compte);
    // Sans le script de reprise : la carte ouverte est réexaminée par T3 (chaque passage) — la règle de l'opération la résout.
    vus.length = 0;
    expect(await resoudre(compte, ff, depsIa, { triggerCode: 'open_action_review' })).toMatchObject({ outcome: 'APPLIED', status: 'RESOLVED', aiCalled: false });
    expect(vus).toEqual([]); // l'abstention mémorisée n'est ni réutilisée ni rejouée : le contexte a changé
    // Le bien de la facture entre dans la version de sa source : le passage T3 suivant reconsolide l'opération → date de la facture.
    await passer(compte);
    await projeter(compte);
    await attendreEtatFinal(compte, velo, fb, ff, op);
    const etat = async () => ({
      ops: await achats(compte), membres: await membres(op), bien: await bienDe(ff), cartes: await cartesBien(ff), evts: await evenements(compte),
      historique: await k.historique(compte), composantes: await k.composantes(op), ouvertes: await cartesAgenda(compte), toutes: await toutesCartes(compte),
      liens: (await sql`SELECT id FROM document_asset_links WHERE account_id = ${compte.id} AND status = 'ACTIVE'`).length,
    });
    const reference = await etat();
    expect(reference.evts).toEqual([expect.objectContaining({ title: NOM_ACHAT, date: JOUR_FACTURE, op })]);
    expect(reference.ouvertes).toEqual([]);
    // Trois cycles complets : T3 opérations (M3 permis : aucun appel attendu), résolution du bien, T4, producteurs, reprise, cohérence.
    for (let i = 0; i < 3; i += 1) {
      const r = await passer(compte, []);
      expect(r.m3?.calls ?? 0).toBe(0);
      expect(await resoudre(compte, ff)).toMatchObject({ outcome: 'NO_CHANGE', status: 'ALREADY_LINKED', aiCalled: false });
      expect(await resoudre(compte, fb)).toMatchObject({ outcome: 'NO_CHANGE', aiCalled: false });
      await projeter(compte);
      expect(await reprise(compte, true)).toMatchObject({ applied: false, attachments: [], dates: [] });
      const insp = await inspecter(compte, [fb, ff]);
      expect([insp.get(fb)?.verdict, insp.get(ff)?.verdict]).toEqual(['CONSISTENT', 'CONSISTENT']);
      expect(await etat()).toEqual(reference);
    }
    expect(vus).toEqual([]);
    // Convergence des lectures : même opération, même date principale, même bien effectif partout.
    const p = await page(compte, op);
    expect(p).toMatchObject({ title: NOM_ACHAT, presentation: { date: JOUR_FACTURE, basis: 'REALIZED' } });
    expect(p.assets.map((a) => a.name)).toEqual(['Vélo Jean Fourche']);
    expect(p.documents.map((d) => [d.fileId, d.date]).sort()).toEqual([[fb, JOUR_COMMANDE], [ff, JOUR_FACTURE]]);
    const tl = await timeline(compte, velo.id);
    expect(tl.filter((e) => e.kind === 'group').map((e) => [e.title, e.effectiveDate, e.dateBasis])).toEqual([[NOM_ACHAT, JOUR_FACTURE, 'REALIZED']]);
    const { readPresentationDates } = await import('@/services/business-operations/graph/presentation-date');
    expect((await readPresentationDates(compte.id, [op])).get(op)).toEqual({ date: JOUR_FACTURE, basis: 'REALIZED' });
    expect(await documentsDuBien(compte, velo.id)).toEqual([fb, ff]);
    const { ASSET_LINK_SLOT } = await import('@/services/to-process/document-slots');
    const { db } = await import('@/db');
    expect(await ASSET_LINK_SLOT.read(db, compte.id, ff)).toMatchObject({ value: velo.id, values: [velo.id], userValidated: false });
    // Le vélo lui-même : ni date ni prix d'achat ; un seul coût réalisé de 9,99 € dans son coût de possession.
    const [fiche] = await sql<Json[]>`SELECT key_characteristics::jsonb ->> 'acquisitionDate' AS d, key_characteristics::jsonb ->> 'acquisitionPrice' AS p, purchase_date::text AS pd, purchase_price_cents AS pp FROM assets WHERE id = ${velo.id}`;
    expect(fiche).toEqual({ d: null, p: null, pd: null, pp: null });
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const tco = JSON.stringify(await readAssetTco(compte.id, velo.id, { today: AUJ }));
    expect(tco.match(/"includedCents":999/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  // ══ 06 ═══════════════════════════════════════════════════════════════════

  it('L116H-E2E-06 — garde-fous : commande seule, deux achats du même vélo, autre achat non rapproché, retrait et choix de l’utilisateur, plusieurs biens, simple association, appartenance « probable », isolation des comptes', async () => {
    const { attachByOperation, loadOperationAttachment } = await import('@/services/ai/reconciliation/document-asset/operation-inheritance.store');
    const { ASSET_LINK_SLOT } = await import('@/services/to-process/document-slots');
    const { db } = await import('@/db');
    // a) Commande seule (#813) : aucun événement d'Agenda, aucune carte, repère « Date de commande ».
    {
      const { compte, velo } = await compteCas();
      await bon(compte, velo.id);
      await passer(compte);
      await projeter(compte);
      const [op] = await achats(compte);
      expect(op).toMatchObject({ status: 'ENVISAGED', realized: null });
      expect(await evenements(compte)).toEqual([]);
      expect(await cartesAgenda(compte)).toEqual([]);
      expect((await page(compte, op.id)).presentation).toMatchObject({ date: JOUR_COMMANDE, basis: 'FIRST_ORDER', label: 'Date de commande' });
    }
    // b) Deux achats différents du même vélo restent distincts ; la facture rejoint le SIEN ; une troisième facture
    //    (autre achat, même vélo cité nulle part, même fournisseur) n'est rapprochée d'aucun : pas d'héritage, question conservée.
    {
      const { compte, velo } = await compteCas();
      const fbA = await bon(compte, velo.id);
      const fbB = await bon(compte, velo.id, { commande: 'VS-778', designation: 'Antivol Abus Bordo 6000', montant: 8900, date: '2026-11-14' });
      await passer(compte);
      const [a, b] = await achats(compte);
      expect([a.label, b.label]).toEqual([NOM_ACHAT, 'Achat Antivol Abus Bordo 6000']);
      const ffB = await facture(compte, { commande: 'VS-778', designation: 'Antivol Abus Bordo 6000', montant: 8900, dateAchat: null });
      const r = await passer(compte);
      expect(r.operationAssetLinks).toBe(1);
      expect((await achats(compte)).map((o) => [o.id, o.status, o.realized])).toEqual([[a.id, 'ENVISAGED', null], [b.id, 'REALIZED', JOUR_FACTURE]]);
      expect((await membres(a.id)).map((m) => m.file)).toEqual([fbA]);
      expect((await membres(b.id)).map((m) => m.file)).toEqual([fbB, ffB]);
      expect(await resolution(ffB)).toMatchObject({ status: 'RESOLVED', reason_code: `OPERATION_ASSET:${b.id}` });
      // Troisième achat, sans commande connue : même fournisseur, aucun bien désigné — jamais rapproché sur ce seul fait.
      const autre = await facture(compte, { commande: 'ZZ-0001', designation: 'Sonnette Knog Oi', montant: 1990, date: '2026-11-19', dateAchat: '2026-11-19' });
      const r2 = await passer(compte);
      expect(r2.operationAssetLinks ?? 0).toBe(0);
      expect((await achats(compte)).length).toBe(3);
      expect(await loadOperationAttachment(compte.id, autre)).toMatchObject({ status: 'NO_ASSET', targetAssetId: null, fingerprint: null });
      expect(await attachByOperation(compte.id, autre)).toBeNull();
      expect((await bienDe(autre)).colonne).toBeNull();
      await resoudre(compte, autre);
      expect((await cartesBien(autre)).filter((c) => !c.fermee)).toHaveLength(1); // la question légitime est posée
    }
    // c) Retrait par l'utilisateur, puis choix d'un autre bien : jamais passés outre.
    {
      const { compte, velo, autres } = await compteCas();
      await bon(compte, velo.id, { paye: true });
      await passer(compte);
      const [op] = await achats(compte);
      const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
      await ASSET_LINK_SLOT.writeUser(db, compte.id, ff, null); // l'utilisateur a retiré le rattachement (document « sans bien »)
      const r = await passer(compte, [m3Meme(op.id)]);
      expect(r.operationAssetLinks ?? 0).toBe(0);
      expect(await attachByOperation(compte.id, ff)).toBeNull();
      expect(await resoudre(compte, ff)).toMatchObject({ outcome: 'SUPERSEDED', status: 'USER_DECIDED', aiCalled: false });
      expect(await bienDe(ff)).toMatchObject({ colonne: null, liens: null });
      expect((await reprise(compte)).attachments).toEqual([]);
      // La date principale, elle, suit la facture : c'est un fait de l'opération, pas du rattachement.
      expect((await achats(compte))[0]).toMatchObject({ realized: JOUR_FACTURE });
      await ASSET_LINK_SLOT.writeUser(db, compte.id, ff, autres[1].id); // l'utilisateur choisit la draisienne
      await passer(compte);
      expect(await attachByOperation(compte.id, ff)).toBeNull();
      expect((await bienDe(ff)).colonne).toBe(autres[1].id);
      expect((await reprise(compte, true)).attached).toBe(0);
      expect((await bienDe(ff)).colonne).toBe(autres[1].id);
    }
    // d) Opération à PLUSIEURS biens : aucun n'est désigné au document — pas d'héritage, la question reste.
    {
      const { compte, velo, autres } = await compteCas();
      await bon(compte, velo.id, { paye: true });
      await passer(compte);
      const [op] = await achats(compte);
      const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
      await withBusinessOperationWrite(compte.id, (repo) => repo.linkAsset(op.id, { assetId: autres[1].id, role: 'CONCERNED', authority: 'USER' }, 'E2E_SECOND_ASSET'));
      const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
      const r = await passer(compte, [m3Meme(op.id)]);
      expect(r.operationAssetLinks ?? 0).toBe(0);
      expect(await loadOperationAttachment(compte.id, ff)).toMatchObject({ status: 'SEVERAL_ASSETS', targetAssetId: null, fingerprint: null });
      expect(await resoudre(compte, ff)).toMatchObject({ outcome: 'ABSTAIN' });
      expect((await bienDe(ff)).colonne).toBeNull();
      expect((await cartesBien(ff)).filter((c) => !c.fermee)).toHaveLength(1);
    }
    // e) Simple ASSOCIATION entre opérations (jamais une appartenance) ; f) appartenance « probable » : pas d'héritage.
    {
      const { compte, velo } = await compteCas();
      await bon(compte, velo.id, { paye: true });
      await passer(compte);
      const [op] = await achats(compte);
      const seule = await facture(compte, { commande: 'ZZ-0002', designation: 'Sonnette Knog Oi', montant: 1990, date: '2026-11-19', dateAchat: '2026-11-19' });
      await passer(compte);
      const autreOp = (await achats(compte)).find((o) => o.id !== op.id)!;
      const { associateOperations } = await import('@/services/business-operations/operation-write.facade');
      const ctx = { accountId: compte.id, actor: { kind: 'USER' as const, userId: compte.owner.id, channel: 'UI' as const } };
      expect((await associateOperations(ctx, { fromOperationId: autreOp.id, toOperationId: op.id, nature: 'ASSOCIATED' })).status).toBe('APPLIED');
      expect(await loadOperationAttachment(compte.id, seule)).toMatchObject({ status: 'NO_ASSET', targetAssetId: null });
      expect(await attachByOperation(compte.id, seule)).toBeNull();
      expect((await bienDe(seule)).colonne).toBeNull();
      // f) Source rattachée avec une confiance « probable » : l'appartenance n'est pas établie.
      const probable = await facture(compte, { dateAchat: null });
      await sql`UPDATE document_operation_candidates SET confidence = 'probable' WHERE file_id = ${probable} AND status = 'ACTIVE'`;
      await passer(compte);
      const m = (await membres(op.id)).find((x) => x.file === probable);
      if (m) expect(m.confidence).toBe('probable');
      expect((await loadOperationAttachment(compte.id, probable)).status).toBe('NONE');
      expect(await attachByOperation(compte.id, probable)).toBeNull();
      expect((await bienDe(probable)).colonne).toBeNull();
    }
    // g) Isolation des comptes : rien n'est lu ni écrit à travers un autre compte.
    {
      const A = await casEnregistre();
      const B = await compteCas();
      expect(await loadOperationAttachment(B.compte.id, A.ff)).toMatchObject({ status: 'NONE' });
      expect(await attachByOperation(B.compte.id, A.ff)).toBeNull();
      expect(await reprise(B.compte, true)).toMatchObject({ attachments: [], dates: [], applied: false });
      const { previewInvoiceAfterOrder } = await import('@/services/business-operations/consolidation/consolidator');
      expect((await previewInvoiceAfterOrder(B.compte.id, [A.op], AUJ)).size).toBe(0);
      expect(await bienDe(A.ff)).toMatchObject({ colonne: null, liens: null });
      expect((await achats(A.compte))[0].realized).toBe(JOUR_COMMANDE);
      expect((await reprise(A.compte, true)).attached).toBe(1);
      expect((await bienDe(A.ff)).colonne).toBe(A.velo.id);
    }
  });

  // ══ 07 ═══════════════════════════════════════════════════════════════════

  it('L116H-E2E-07 — dates : commande non payée, date proposée par le modèle, livraison et paiement intacts ; correction de l’utilisateur jamais écrasée ; plusieurs factures, acompte, intervention : règles existantes inchangées', async () => {
    // a) Commande NON payée + facture dont le modèle propose la date de COMMANDE comme date d'achat : date principale = date de la facture.
    //    La date de livraison annoncée (date prévue) et la date du bon ne bougent pas.
    {
      const { compte, velo } = await compteCas();
      const fb = await analyser(compte, velo.id, { type: 'ACQUISITION_ORDER', titre: TITRE_BON, date: JOUR_COMMANDE,
        candidat: cand({ typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', summary: 'Coussin', provider: 'Cycles Exemple', targetHints: [cible(velo.id)],
          businessReferences: [ref('ORDER', COMMANDE)] as never, temporalHints: { plannedDate: '2026-11-25' }, financialHints: [fh('REALIZED_COST', 999)] }) });
      await passer(compte);
      const [op] = await achats(compte);
      expect(op).toMatchObject({ status: 'ENVISAGED', realized: null, planned: '2026-11-25' });
      const ff = await facture(compte, { dateAchat: JOUR_COMMANDE });
      await passer(compte);
      expect((await achats(compte))[0]).toMatchObject({ id: op.id, status: 'REALIZED', realized: JOUR_FACTURE, planned: '2026-11-25' });
      expect((await bienDe(fb)).date).toBe(JOUR_COMMANDE);
      expect((await bienDe(ff)).colonne).toBe(velo.id);
      // Aucune contradiction de date relevée entre la commande et sa facture, donc aucune question.
      const [prov] = await sql<Json[]>`SELECT attribute_provenance -> 'conflicts' AS c FROM business_operations WHERE id = ${op.id}`;
      expect(prov.c ?? []).toEqual([]);
      expect((await cartesAgenda(compte)).filter((c) => /date/i.test(String(c.question)))).toEqual([]);
      // Un seul coût réalisé : celui de la facture (le montant du bon est prévisionnel), date économique inchangée.
      expect((await k.composantes(op.id)).map((c) => [c.kind, c.amount_minor]).sort()).toEqual([['FORECAST_COST', 999], ['REALIZED_COST', 999]]);
      const [cout] = await sql<Json[]>`SELECT economic_date::text AS d FROM business_operation_financial_components WHERE operation_id = ${op.id} AND active AND kind = 'REALIZED_COST'`;
      expect(cout.d).toBe(JOUR_COMMANDE);
    }
    // b) Date corrigée par l'UTILISATEUR (fiche de l'opération) : jamais écrasée, ni à l'arrivée de la facture, ni par la reprise.
    {
      const { compte, velo } = await compteCas();
      await bon(compte, velo.id, { paye: true });
      await passer(compte);
      const [op] = await achats(compte);
      const { correctOperation } = await import('@/services/business-operations/operation-write.facade');
      const ctx = { accountId: compte.id, actor: { kind: 'USER' as const, userId: compte.owner.id, channel: 'UI' as const } };
      expect((await correctOperation(ctx, { operationId: op.id, attributes: { realizedDate: '2026-11-15' } })).status).toBe('APPLIED');
      const ff = await facture(compte, { fournisseur: VENDEUR_FACTURE });
      await passer(compte, [m3Meme(op.id)]);
      expect((await achats(compte))[0]).toMatchObject({ id: op.id, realized: '2026-11-15' });
      expect((await bienDe(ff)).colonne).toBe(velo.id); // le rattachement au bien, lui, ne dépend pas de la date
      const blanc = await reprise(compte);
      expect(blanc.dates).toEqual([expect.objectContaining({ operationId: op.id, current: '2026-11-15', expected: JOUR_FACTURE, protectedByUser: true })]);
      expect(await reprise(compte, true)).toMatchObject({ applied: false, datesChanged: 0 });
      expect((await achats(compte))[0].realized).toBe('2026-11-15');
    }
    // c) PLUSIEURS factures dans l'opération : la règle ne s'applique pas — règle existante (date de la source fondatrice).
    {
      const { compte, velo } = await compteCas();
      await bon(compte, velo.id, { paye: true });
      await passer(compte);
      const [op] = await achats(compte);
      await facture(compte, { dateAchat: JOUR_FACTURE });
      await passer(compte);
      expect((await achats(compte))[0].realized).toBe(JOUR_FACTURE); // une facture : sa date
      await facture(compte, { dateAchat: '2026-11-25', date: '2026-11-25' });
      await passer(compte);
      const apres = (await achats(compte))[0];
      expect(apres.id).toBe(op.id);
      expect((await membres(op.id)).length).toBe(3);
      // Règle existante d'un achat : la plus ancienne date de réalisation portée par ses preuves (ici la première facture).
      expect(apres.realized).toBe(JOUR_FACTURE);
      expect(apres.prov?.origin ?? null).toBeNull();
      expect((await reprise(compte)).dates).toEqual([]);
    }
    // d) Facture d'ACOMPTE : la règle ne s'applique pas.
    {
      const { compte, velo } = await compteCas();
      await bon(compte, velo.id, { paye: true });
      await passer(compte);
      await facture(compte, { role: 'DEPOSIT_INVOICE', dateAchat: null });
      await passer(compte);
      const [op] = await achats(compte);
      expect(op.prov?.origin ?? null).toBeNull();
      expect(op.realized).not.toBe(JOUR_FACTURE);
    }
    // e) INTERVENTION (devis puis facture) : hors de la règle — date de prestation, comme avant.
    {
      const { compte, autres } = await compteCas();
      const maison = autres[2];
      await k.document(compte, maison.id, [cand({ typeHint: 'INTERVENTION', statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', summary: 'Ramonage', provider: 'Ramoneur Dupont',
        targetHints: [cible(maison.id)], businessReferences: [ref('QUOTE', 'DV-9')] as never, financialHints: [fh('FORECAST_COST', 9000)] })], { type: 'WORKS_QUOTE', date: '2026-11-10', amountCents: 9000 });
      await k.document(compte, maison.id, [cand({ typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', summary: 'Ramonage', provider: 'Ramoneur Dupont',
        targetHints: [cible(maison.id)], businessReferences: [ref('QUOTE', 'DV-9')] as never, temporalHints: { realizedDate: '2026-11-18' }, financialHints: [fh('REALIZED_COST', 9000)] })],
      { type: 'MAINTENANCE_INVOICE', date: JOUR_FACTURE, amountCents: 9000 });
      await passer(compte);
      const [op] = await sql<Json[]>`SELECT realized_date::text AS realized, attribute_provenance -> 'fields' -> 'realizedDate' ->> 'origin' AS origine
                                       FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'INTERVENTION' AND invalidated_at IS NULL`;
      expect(op).toEqual({ realized: '2026-11-18', origine: null });
    }
  });

  // ══ 08 ═══════════════════════════════════════════════════════════════════

  it('L116H-E2E-08 — durabilité : le cas déjà enregistré est repris par le SEUL contrôle de cohérence, sans le script — rattachement (COH-DOC-PRIMARY-LINK → file T3), puis date principale (COH-OPS-ACQUISITION-DATE)', async () => {
    const { compte, velo, fb, ff, op } = await casEnregistre();
    await projeter(compte);
    const [carte] = await cartesBien(ff);
    const [evt] = await evenements(compte);
    // 1. Rattachement : écart réparable, réparation = remise dans la file durable T3 DOCUMENT_ASSET (aucune écriture directe).
    const { documentPrimaryLinkCheck } = await import('@/services/coherence/registry/checks/document-primary-link');
    const { pgClient } = await import('@/db');
    const cctx = { sql: pgClient as never, now: new Date(), today: AUJ, mode: 'CORRECTIVE' as const, correlationId: 'e2e-116h-coh' };
    const constat = (await inspecter(compte, [ff])).get(ff)!;
    expect(constat).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'PRIMARY_LINK_RECOVERABLE' });
    const rep = (await documentPrimaryLinkCheck.repair!(cctx, compte.id, [{ id: ff, inspection: constat }])).get(ff)!;
    expect(rep).toMatchObject({ called: true, service: 'requestDocumentAssetResolution', pending: true, aiCalls: 0 });
    expect((await sql`SELECT 1 FROM ai_job_queue WHERE treatment = 'T3' AND target_type = 'document' AND target_id = ${String(ff)} AND status = 'PENDING'`).length).toBe(1);
    // Le travail T3 de la file (exécuté ici directement) : rattachement par l'opération, sans IA ; carte fermée avec son motif.
    vus.length = 0;
    expect(await resoudre(compte, ff, depsIa, { triggerCode: 'coherence', reprocessReason: 'COHERENCE_RECOVERABLE' })).toMatchObject({ outcome: 'APPLIED', status: 'RESOLVED', aiCalled: false });
    expect(vus).toEqual([]);
    expect(await cartesBien(ff)).toEqual([{ id: carte.id, fermee: true, motif: 'OBSOLETE', nature: 'COMPLETE', detail: `RESOLVED_BY_OPERATION:${op}` }]);
    expect((await inspecter(compte, [ff])).get(ff)).toMatchObject({ verdict: 'CONSISTENT' });
    // 2. Date principale : écart réparable, réparation = reconsolidation T3 de l'opération puis projection T4.
    const d = await inspecterDate(compte, op);
    expect(d.inspection).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'ACQUISITION_DATE_INVOICE_AFTER_ORDER', expected: { realizedDate: JOUR_FACTURE } });
    expect((await achats(compte))[0].realized).toBe(JOUR_COMMANDE); // l'inspection n'a rien écrit
    const r2 = (await d.check.repair!({ ...d.ctx, mode: 'CORRECTIVE' }, compte.id, [{ id: op, inspection: d.inspection }])).get(op)!;
    expect(r2).toMatchObject({ called: true, service: 'reconsolidateOperations+projectAccountOperations', aiCalls: 0, result: { t4Created: 0, t4Updated: 1 } });
    await attendreEtatFinal(compte, velo, fb, ff, op);
    expect(await evenements(compte)).toEqual([expect.objectContaining({ id: evt.id, date: JOUR_FACTURE, op })]);
    expect((await inspecterDate(compte, op)).inspection.anomaly ?? null).not.toBe('ACQUISITION_DATE_INVOICE_AFTER_ORDER');
    // Rien à reprendre ensuite, par aucune voie.
    expect(await reprise(compte, true)).toMatchObject({ applied: false, attachments: [], dates: [] });
    const h = await k.historique(compte);
    await passer(compte);
    expect(await k.historique(compte)).toBe(h);
  });
});
