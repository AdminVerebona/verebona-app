/**
 * Carte #821 (lot 116I) — événements d'achat : le titre désigne l'objet
 * réellement acheté, plus le type « Achat » nu — PostgreSQL 16 réel.
 *
 * Cas reproduit (capture du 20/11/2026) : ticket de carburant classé « Facture
 * d'achat », rattaché au véhicule « Cupra », daté du 20/11/2026, dont
 * l'événement d'Agenda s'appelle « Achat ». Fournisseur d'IA SIMULÉ : la
 * sortie du modèle est écrite ici (classification, titre proposé, candidat
 * ACQUISITION réalisé, fait porteur d'un événement d'achat), aucun appel
 * réseau.
 *
 * Chemins de PRODUCTION : barrière T1 (`gateOperationCandidates`), persistance
 * T1 (`replaceOperationCandidates`), titre du document (`ensureBusinessTitle`,
 * désignation persistée), candidats T4 du document (`buildAgendaCandidatesT4`)
 * et primitive d'écriture d'Agenda (`persistAgendaDecisions`), consolidation
 * T3 (`consolidateAccountOperations`), projection T4
 * (`projectAccountOperations`), contrôle de cohérence
 * COH-AGENDA-OPERATION-PROJECTION, fiche de l'opération, liste des opérations
 * du document, Timeline du bien, lecture de l'Agenda (ordinateur et mobile
 * lisent le même titre enregistré), coût de possession, reprise du stock
 * (`reprisePurchaseTitles`).
 *
 *   L116I-E2E-01  nouvel événement carburant : « Achat de carburant », Cupra bien associé — fiche, liste, Timeline, Agenda (critère 1)
 *   L116I-E2E-02  DIAGNOSTIC + stock : événements « Achat » existants renommés SUR PLACE ; à blanc puis réel ; idempotent ;
 *                 titres de l'utilisateur et titres explicites intacts ; toutes les autres données identiques (critères 1, 3)
 *   L116I-E2E-03  non-confusion : accessoire → sa désignation ; « Achat Cupra » seulement quand l'acquisition du véhicule est
 *                 établie ; rattachement seul ou rien de fiable → libellé neutre, jamais le bien ni le fournisseur (critère 2)
 *   L116I-E2E-04  rejouabilité : T3, T4 et contrôle de cohérence rejoués — aucun doublon, aucun retour à « Achat » ;
 *                 la règle « commande seule → aucun événement » (#813) reste (critère 4)
 *   L116I-E2E-05  relevé du cas réel : les requêtes en lecture seule de la fiche de recette s'exécutent sur le schéma réel
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';
import { gateOperationCandidates, type AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { buildAgendaCandidatesT4 } from '@/services/ai/source-analysis/steps/build-agenda-candidates.step';
import type { ExtractedField } from '@/services/ai/source-analysis/types';

const emis = vi.hoisted(() => [] as string[]);
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()),
  emitBusinessEvent: async (e: { type: string }) => { emis.push(e.type); },
  emitBusinessEvents: async (l: Array<{ type: string }>) => { for (const e of l ?? []) emis.push(e.type); },
}));

type Json = Record<string, any>;
const AUJ = '2026-11-20';
const NOM_CARBURANT = 'Achat de carburant';
const CHECK = 'COH-AGENDA-OPERATION-PROJECTION';

scenario('L116I', 'Événements d’achat : le titre désigne l’objet réellement acheté, plus « Achat » nu (carte #821)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const projection = () => import('@/services/business-operations/agenda-projection/service');

  // ── Outils ────────────────────────────────────────────────────────────────
  async function compteCupra(): Promise<{ compte: AccountRow & { owner: { id: number } }; cupra: AssetRow; velo: AssetRow }> {
    const compte = await make.account({ plan: 'premium' });
    const cupra = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Jean Fourche' });
    return { compte, cupra, velo };
  }
  /** Sortie SIMULÉE du modèle pour un candidat, passée par la barrière serveur T1 réelle. */
  function barriere(typeDocument: string | null, brut: AnchoredOperationCandidate): AnchoredOperationCandidate[] {
    return gateOperationCandidates([brut], {
      hasExploitableContent: true, documentTypeCode: typeDocument,
      verifiedIds: { ASSET: new Set(brut.targetHints.flatMap((t) => (t.entityId ? [t.entityId] : []))), EQUIPMENT: new Set(), ROOM: new Set() },
      capabilities: { rooms: false, equipments: false }, keptFactRefs: new Set(['f1']),
    }).candidates;
  }
  async function titrer(compte: AccountRow, fileId: number, mode: 'refresh' | 'repair' = 'refresh') {
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    return ensureBusinessTitle({ fileId, accountId: compte.id, origin: mode === 'refresh' ? 'T1' : 'T3', mode });
  }
  /** Analyse T1 d'un document (modèle simulé) : type, date, titre proposé, fournisseur, candidats (barrière réelle), puis titre métier. */
  async function analyser(compte: AccountRow, assetId: number | null, o: {
    type: string; titreModele: string; date: string; candidats: AnchoredOperationCandidate[]; montant?: number; fournisseur?: string | null; sansTitre?: boolean;
  }): Promise<number> {
    const candidats = o.candidats.flatMap((c) => barriere(o.type, c));
    const id = await k.document(compte, assetId, candidats, { type: o.type, amountCents: o.montant ?? 6230, date: o.date });
    const fournisseur = o.fournisseur === undefined ? 'TotalEnergies' : o.fournisseur;
    await sql`UPDATE asset_files SET supplier = ${fournisseur}, title_source = 'SYSTEM', last_analysis_at = now(), original_filename = ${`IMG_${4000 + id}.jpg`} WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = ${o.titreModele}, supplier_name = ${fournisseur}, document_date = ${o.date} WHERE file_id = ${id}`;
    const raw = { task: 'ANALYZE_DOCUMENT', document: {
      title: { value: o.titreModele, confidence: 'certain' }, type: { value: o.type, confidence: 'certain' },
      ...(fournisseur ? { supplier: { value: { name: fournisseur }, confidence: 'certain' } } : {}),
      date: { value: o.date, confidence: 'certain' },
    } };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${id}, ${`h${id}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${compte.id}, ${JSON.stringify(raw)})`;
    if (!o.sansTitre) await titrer(compte, id);
    return id;
  }
  /** Candidat tel que le modèle le rend pour un ticket de carburant : achat réalisé, résumé pauvre (« Achat »), fournisseur. */
  const achat = (assetId: number, over: Partial<AnchoredOperationCandidate> = {}) => cand({
    typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', summary: 'Achat', provider: 'TotalEnergies',
    targetHints: [cible(assetId)], businessReferences: [ref('INVOICE', 'TK-2026-1120')] as never,
    temporalHints: { realizedDate: AUJ }, financialHints: [fh('REALIZED_COST', 6230, { economicDate: AUJ })], ...over,
  });
  /** Le ticket du cas réel : « Facture d'achat », titre proposé « Ticket de carburant TotalEnergies », 20/11/2026, rattaché à la Cupra. */
  const ticket = (compte: AccountRow, cupraId: number, o: {
    titre?: string; candidat?: Partial<AnchoredOperationCandidate>; station?: string; date?: string; cents?: number; reference?: string; sansTitre?: boolean;
  } = {}) => {
    const station = o.station ?? 'TotalEnergies';
    const date = o.date ?? AUJ;
    const cents = o.cents ?? 6230;
    return analyser(compte, cupraId, {
      type: 'ACQUISITION_INVOICE', titreModele: o.titre ?? `Ticket de carburant ${station}`, date, montant: cents, fournisseur: station, sansTitre: o.sansTitre,
      candidats: [achat(cupraId, {
        provider: station, businessReferences: [ref('INVOICE', o.reference ?? `TK-${station}-${date}`)] as never,
        temporalHints: { realizedDate: date }, financialHints: [fh('REALIZED_COST', cents, { economicDate: date })], ...o.candidat,
      })],
    });
  };
  /**
   * Événement que la décision T4 du DOCUMENT crée pour un fait d'achat (chemin de production : candidat du registre
   * `buildAgendaCandidatesT4`, puis primitive d'écriture d'Agenda). Le fait ne porte ni sujet ni libellé de cible :
   * son titre est celui du catalogue, « Achat » — complété par le titre proposé par l'analyse s'il est fourni.
   */
  async function evenementDuDocument(compte: AccountRow, assetId: number, fileId: number, o: { titreDocument?: string | null; libelleCible?: string | null; date?: string } = {}) {
    const fait: ExtractedField = {
      fieldKey: 'amount.total', value: 62.3, confidence: 'certain', excerpt: 'TOTAL TTC 62,30 EUR', canonicalKey: null,
      semanticEvent: { type: 'purchase', nature: 'HISTORICAL' },
      target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: o.libelleCible ?? null } as never,
    };
    const [c] = buildAgendaCandidatesT4([fait], {
      sourceFileId: fileId, documentAssetId: assetId, multiAsset: false, documentTitle: o.titreDocument ?? null, documentDate: o.date ?? AUJ,
      documentTypeCode: 'ACQUISITION_INVOICE',
    });
    expect(c).toBeTruthy();
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    await persistAgendaDecisions([{
      action: 'create', title: c.title, date: c.date, category: 'information', confidence: 'certain', reasonCode: 'E2E', deterministic: true,
      sourceFileId: fileId, nature: c.nature ?? null, businessType: c.businessType ?? null, target: c.target ?? null,
      occurrenceIndex: c.occurrence ?? null, dateSource: c.dateSource ?? null, sources: c.sources,
    }], compte.id, assetId);
    const [e] = await sql<Json[]>`SELECT id, title FROM agenda_items WHERE account_id = ${compte.id} AND origin_ref_type = 'asset_file' AND origin_ref_id = ${fileId} ORDER BY id DESC LIMIT 1`;
    expect(e).toBeTruthy();
    return { id: Number(e.id), titreCandidat: c.title };
  }
  const passer = (compte: AccountRow) => k.passer(compte, { today: AUJ });
  const projeter = async (compte: AccountRow, o: { dryRun?: boolean } = {}) =>
    (await projection()).projectAccountOperations(compte.id, { all: true, today: AUJ, correlationId: 'e2e-116i', ...o });
  const chaine = async (compte: AccountRow) => { await passer(compte); return projeter(compte); };
  const achats = (compte: AccountRow) => sql<Json[]>`
    SELECT o.id::int AS id, o.status, o.technical_label AS label, o.realized_date::text AS realized,
           (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active
      FROM business_operations o WHERE o.account_id = ${compte.id} AND o.type_code = 'ACQUISITION' ORDER BY o.id`;
  const actifs = async (compte: AccountRow) => (await achats(compte)).filter((o) => o.active);
  const evenements = (compte: AccountRow) => sql<Json[]>`
    SELECT ai.id::int AS id, ai.title, ai.start_date::text AS date, ai.business_operation_id::int AS op, ai.event_nature AS nature, ai.business_type,
           ai.projection_origin AS origine, ai.is_automatic AS auto, ai.is_automatic_modified AS modifie,
           COALESCE((SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = ai.id), '{}') AS biens,
           COALESCE((SELECT array_agg(l.asset_file_id ORDER BY l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = ai.id), '{}') AS fichiers
      FROM agenda_items ai WHERE ai.account_id = ${compte.id} ORDER BY ai.id`;
  const page = async (compte: AccountRow, op: number) => {
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    return (await readReferenceEventPage(compte.id, op))!;
  };
  const timeline = async (compte: AccountRow, assetId: number) => {
    const { readAssetTimelineAll } = await import('@/services/agenda/timeline/read');
    return (await readAssetTimelineAll({ accountId: compte.id, assetId, today: AUJ })) as unknown as Json[];
  };
  /** Liste « opérations du document » (tiroir du document, liste des documents) : même libellé que la fiche. */
  const operationsDuDocument = async (compte: AccountRow, fileId: number) => {
    const { referenceEventsOfDocument } = await import('@/services/documents/business-period-surfaces');
    return (await referenceEventsOfDocument(compte.id, fileId)) as unknown as Json[];
  };
  /** Lecture de l'Agenda (tiroir de l'événement, ordinateur et mobile : même lecture, même titre enregistré), par identifiant croissant. */
  const agenda = async (compte: AccountRow) => {
    const { getAgendaItemById } = await import('@/services/agenda/AgendaQueryService');
    const out: Json[] = [];
    for (const e of await evenements(compte)) {
      const lu = await getAgendaItemById(e.id, compte.id);
      if (lu) out.push(lu as unknown as Json);
    }
    return out;
  };
  const tco = async (compte: AccountRow, assetId: number) => {
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    return readAssetTco(compte.id, assetId, { today: AUJ }) as unknown as Promise<Json>;
  };
  async function controler(compte: AccountRow, ids: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([
      import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db'),
    ]);
    return controlObjects({
      ctx: { sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode, correlationId: `coherence:e2e-116i:${CHECK}` },
      check: getCheck(CHECK)!, accountId: compte.id, ids, trigger: 'MANUAL', campaignId: null,
      stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
  }
  const inspecter = async (compte: AccountRow, ids: number[]) => {
    const [{ getCheck }, { pgClient }] = await Promise.all([import('@/services/coherence/registry'), import('@/db')]);
    return getCheck(CHECK)!.inspect!({ sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode: 'DRY_RUN', correlationId: 'e2e-116i' } as never, compte.id, ids);
  };
  /**
   * PHOTOGRAPHIE de tout ce qu'une correction de libellé ne doit PAS changer : événements (toutes les colonnes sauf le
   * titre et les horodatages techniques), leurs liens (biens, documents, sources, opérations), opérations (toutes les
   * colonnes sauf l'intitulé et les compteurs techniques), sources, liens, montants, coût de possession, fiche des biens,
   * cartes « À traiter », rappels et notifications, retraits.
   */
  async function photo(compte: AccountRow, assetIds: number[]) {
    const lignes = async (q: Promise<Json[]>) => JSON.stringify(await q);
    const cout: Json = {};
    for (const a of assetIds) {
      const t = await tco(compte, a);
      cout[a] = { cumul: t.summary?.cumulativeCostCents ?? null, lignes: JSON.stringify(t).match(/"includedCents":\d+/g) ?? [] };
    }
    return {
      evenements: await lignes(sql<Json[]>`
        SELECT to_jsonb(i) - 'title' - 'title_provenance' - 'updated_at' - 'projection_correlation_id' AS e FROM agenda_items i WHERE i.account_id = ${compte.id} ORDER BY i.id`),
      liensBiens: await lignes(sql<Json[]>`SELECT l.agenda_item_id, l.asset_id FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id} ORDER BY 1, 2`),
      liensDocuments: await lignes(sql<Json[]>`SELECT l.agenda_item_id, l.asset_file_id FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id} ORDER BY 1, 2`),
      sourcesAgenda: await lignes(sql<Json[]>`SELECT count(*)::int AS n FROM agenda_item_sources s JOIN agenda_items i ON i.id = s.agenda_item_id WHERE i.account_id = ${compte.id}`),
      liensOperations: await lignes(sql<Json[]>`SELECT to_jsonb(l) - 'updated_at' AS l FROM business_operation_agenda_links l WHERE l.account_id = ${compte.id} ORDER BY l.id`),
      operations: await lignes(sql<Json[]>`
        SELECT (to_jsonb(o) - 'technical_label' - 'title_provenance' - 'version' - 'updated_at' - 'last_reconciled_at') #- '{attribute_provenance,fields,label}' AS o
          FROM business_operations o WHERE o.account_id = ${compte.id} ORDER BY o.id`),
      sources: await lignes(sql<Json[]>`SELECT id, operation_id, source_kind, source_entity_key, source_role, authority, active FROM business_operation_sources WHERE account_id = ${compte.id} ORDER BY id`),
      liensBiensOperations: await lignes(sql<Json[]>`SELECT operation_id, asset_id, link_role, active FROM business_operation_asset_links WHERE account_id = ${compte.id} ORDER BY operation_id, asset_id`),
      montants: await lignes(sql<Json[]>`
        SELECT c.id, c.operation_id, c.kind, c.amount_minor, c.currency, c.economic_date::text AS d, c.active
          FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id WHERE o.account_id = ${compte.id} ORDER BY c.id`),
      cout,
      biens: await lignes(sql<Json[]>`SELECT id, name, status, key_characteristics FROM assets WHERE account_id = ${compte.id} ORDER BY id`),
      documents: await lignes(sql<Json[]>`SELECT id, asset_id, retained_title, document_type_code, document_date::text AS d, deleted_at FROM asset_files WHERE account_id = ${compte.id} ORDER BY id`),
      cartes: await lignes(sql<Json[]>`SELECT id, rule_code, target_type, target_id, resolved_at IS NOT NULL AS resolu FROM to_process_actions WHERE account_id = ${compte.id} ORDER BY id`),
      rappels: await lignes(sql<Json[]>`SELECT count(*)::int AS n FROM agenda_deadline_reminders`),
      notifications: await lignes(sql<Json[]>`SELECT (SELECT count(*)::int FROM notifications) AS n, (SELECT count(*)::int FROM notification_events WHERE account_id = ${compte.id}) AS e, (SELECT count(*)::int FROM notification_outbox) AS o`),
      retraits: await lignes(sql<Json[]>`SELECT count(*)::int AS n FROM agenda_item_removals WHERE account_id = ${compte.id}`),
    };
  }

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L116I-E2E-01 — nouveau ticket de carburant (« Facture d’achat », Cupra, 20/11/2026) : l’événement s’appelle « Achat de carburant », plus « Achat » ; Cupra reste le bien associé ; même intitulé sur la fiche, la liste, la Timeline et l’Agenda', async () => {
    const { compte, cupra } = await compteCupra();
    const f = await ticket(compte, cupra.id);
    // Document : classé « Facture d'achat », nommé par le moteur de titrage ; sa désignation persistée porte encore le fournisseur.
    const [doc] = await sql<Json[]>`SELECT retained_title AS titre, document_type_code AS type, title_basis ->> 'subject' AS designation FROM asset_files WHERE id = ${f}`;
    expect(doc).toMatchObject({ type: 'ACQUISITION_INVOICE', designation: 'de carburant TotalEnergies' });
    expect(doc.titre).toMatch(/^Ticket de carburant/);
    // Décision T4 du document : un fait d'achat sans sujet → événement automatique « Achat » (titre du catalogue).
    const evt = await evenementDuDocument(compte, cupra.id, f);
    expect(evt.titreCandidat).toBe('Achat');
    await chaine(compte);

    const [op, ...autres] = await actifs(compte);
    expect(autres).toEqual([]);
    // Agenda : UN événement — celui du document, MÊME identifiant —, renommé ; daté du 20/11 ; Cupra et le ticket associés.
    const evts = await evenements(compte);
    expect(evts).toEqual([expect.objectContaining({
      id: evt.id, title: NOM_CARBURANT, date: AUJ, op: op.id, nature: 'HISTORICAL', business_type: 'purchase', auto: true, modifie: false, biens: [cupra.id], fichiers: [f],
    })]);
    // Opération : UNE, réalisée le 20/11/2026, nommée par la CATÉGORIE (ni le fournisseur, ni la Cupra).
    expect(op).toMatchObject({ status: 'REALIZED', realized: AUJ, label: NOM_CARBURANT });
    expect((await k.liens(op.id)).map((l) => l.asset_id)).toEqual([cupra.id]);
    // Renommage tracé sur l'événement (ancien titre, nouveau titre, opération), restaurable.
    expect(await sql<Json[]>`SELECT event_type, detail_json ->> 'from' AS de, detail_json ->> 'to' AS vers FROM agenda_occurrence_events WHERE agenda_item_id = ${evt.id} AND event_type = 'TITLE_FROM_OPERATION'`)
      .toEqual([{ event_type: 'TITLE_FROM_OPERATION', de: 'Achat', vers: NOM_CARBURANT }]);
    // Fiche de l'opération : même intitulé ; Cupra est le BIEN ASSOCIÉ, pas l'objet de l'achat ; le ticket est son justificatif.
    const p = await page(compte, op.id);
    expect(p).toMatchObject({ title: NOM_CARBURANT, ownLabel: NOM_CARBURANT });
    expect(p.assets.map((a) => a.name)).toEqual(['Cupra']);
    expect(p.documents.map((d) => d.fileId)).toEqual([f]);
    expect(p.agendaItems.map((a: Json) => a.title)).toEqual([NOM_CARBURANT]);
    // Liste des opérations du document, Timeline du bien, lecture de l'Agenda : le même intitulé partout.
    expect((await operationsDuDocument(compte, f)).map((o) => o.label)).toEqual([NOM_CARBURANT]);
    const tl = await timeline(compte, cupra.id);
    expect(tl.filter((e) => e.kind === 'group').map((e) => e.title)).toEqual([NOM_CARBURANT]);
    expect(JSON.stringify(tl)).not.toMatch(/"title":"Achat"/);
    expect((await agenda(compte)).map((a) => a.title)).toEqual([NOM_CARBURANT]);
    // La Cupra elle-même : ni date ni prix d'achat écrits par ce ticket (ce n'est pas l'acquisition du véhicule).
    const [fiche] = await sql<Json[]>`SELECT key_characteristics::jsonb ->> 'acquisitionDate' AS d, key_characteristics::jsonb ->> 'acquisitionPrice' AS p FROM assets WHERE id = ${cupra.id}`;
    expect(fiche).toEqual({ d: null, p: null });

    // Sans événement du document : la projection de l'opération crée l'événement, directement bien nommé.
    const autre = await compteCupra();
    const f2 = await ticket(autre.compte, autre.cupra.id);
    await chaine(autre.compte);
    expect(await evenements(autre.compte)).toEqual([expect.objectContaining({ title: NOM_CARBURANT, date: AUJ, origine: 'OPERATION', biens: [autre.cupra.id] })]);
    expect((await operationsDuDocument(autre.compte, f2)).map((o) => o.label)).toEqual([NOM_CARBURANT]);
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('L116I-E2E-02 — diagnostic et stock : événements automatiquement nommés « Achat » renommés SUR L’ÉVÉNEMENT EXISTANT (à blanc, puis réel, idempotent) ; titres de l’utilisateur et titres explicites intacts ; toutes les autres données identiques', async () => {
    const { compte, cupra } = await compteCupra();
    // ── ÉTAT « AVANT » (stock) ───────────────────────────────────────────────
    // A. Le cas de la capture : opération consolidée AVANT que la désignation du ticket soit disponible (intitulé = résumé
    //    « Achat ») ; événement projeté « Achat ». La désignation arrive ensuite : rien ne redéclenche la consolidation.
    const fA = await ticket(compte, cupra.id, { sansTitre: true });
    await chaine(compte);
    const [opA] = await actifs(compte);
    expect(opA).toMatchObject({ label: 'Achat', status: 'REALIZED', realized: AUJ });
    const evtA = (await evenements(compte)).find((e) => e.op === opA.id)!;
    expect(evtA).toMatchObject({ title: 'Achat', date: AUJ, origine: 'OPERATION', auto: true, modifie: false, biens: [cupra.id] });
    await titrer(compte, fA);
    // DIAGNOSTIC : la désignation est maintenant connue, mais un nouveau passage T3 / T4 ne voit aucun document « sale »
    // (la désignation n'entre pas dans la version de la source) : l'intitulé et le titre restent « Achat ».
    expect((await sql<Json[]>`SELECT title_basis ->> 'subject' AS s FROM asset_files WHERE id = ${fA}`)[0].s).toBe('de carburant TotalEnergies');
    await chaine(compte);
    expect((await actifs(compte))[0]).toMatchObject({ id: opA.id, label: 'Achat' });
    expect((await evenements(compte)).find((e) => e.id === evtA.id)).toMatchObject({ title: 'Achat' });
    expect((await page(compte, opA.id)).title).toBe('Achat');

    // B. Événement du DOCUMENT (décision T4) nommé « Achat — Cupra » (libellé de la cible), relié à son opération.
    const fB = await ticket(compte, cupra.id, { sansTitre: true, station: 'Esso', date: '2026-10-02', cents: 5510 });
    const evtB = await evenementDuDocument(compte, cupra.id, fB, { libelleCible: 'Cupra', date: '2026-10-02' });
    expect(evtB.titreCandidat).toBe('Achat — Cupra');
    await chaine(compte);
    const opB = (await actifs(compte)).find((o) => o.id !== opA.id)!;
    expect((await evenements(compte)).find((e) => e.id === evtB.id)).toMatchObject({ title: 'Achat — Cupra', date: '2026-10-02', op: opB.id, origine: null, auto: true });
    await titrer(compte, fB);

    // C. Achat dont l'utilisateur a MODIFIÉ l'événement (titre renvoyé inchangé « Achat », date corrigée).
    //    Carte #859 : la correction de la DATE ne protège plus le titre — titre SYSTEM du champ, amélioré ; date intacte.
    const fC = await ticket(compte, cupra.id, { sansTitre: true, station: 'Avia', date: '2026-09-05', cents: 4800 });
    await chaine(compte);
    const opC = (await actifs(compte)).find((o) => ![opA.id, opB.id].includes(o.id))!;
    const evtC = (await evenements(compte)).find((e) => e.op === opC.id)!;
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(evtC.id, { title: 'Achat', startDate: '2026-09-06' }, compte.id, compte.owner.id);
    expect((await evenements(compte)).find((e) => e.id === evtC.id)).toMatchObject({ title: 'Achat', date: '2026-09-06', modifie: true });
    await titrer(compte, fC);

    // D. Achat dont l'utilisateur a CORRIGÉ l'intitulé (geste existant de la fiche) : intitulé et événement jamais touchés.
    const fD = await ticket(compte, cupra.id, { sansTitre: true, station: 'Intermarché', date: '2026-08-11', cents: 3900 });
    await chaine(compte);
    const opD = (await actifs(compte)).find((o) => ![opA.id, opB.id, opC.id].includes(o.id))!;
    const { correctOperation } = await import('@/services/business-operations/operation-write.facade');
    expect((await correctOperation({ accountId: compte.id, actor: { kind: 'USER', userId: compte.owner.id, channel: 'UI' } }, { operationId: opD.id, label: 'Plein des vacances' })).status).toBe('APPLIED');
    await projeter(compte);
    const evtD = (await evenements(compte)).find((e) => e.op === opD.id)!;
    await titrer(compte, fD);

    // E. Titre EXPLICITE d'un événement automatique du document (« Achat — Pneus hiver ») : jamais touché.
    const fE = await ticket(compte, cupra.id, { sansTitre: true, station: 'Leclerc', date: '2026-07-03', cents: 2700 });
    const evtE = await evenementDuDocument(compte, cupra.id, fE, { date: '2026-07-03' });
    await sql`UPDATE agenda_items SET title = 'Achat — Pneus hiver' WHERE id = ${evtE.id}`;
    await chaine(compte);
    const opE = (await actifs(compte)).find((o) => ![opA.id, opB.id, opC.id, opD.id].includes(o.id))!;
    expect((await evenements(compte)).find((e) => e.id === evtE.id)).toMatchObject({ title: 'Achat — Pneus hiver', op: opE.id });
    await titrer(compte, fE);

    const avantListe = await evenements(compte);
    expect(avantListe.map((e) => [e.id, e.title])).toEqual(expect.arrayContaining([[evtA.id, 'Achat'], [evtB.id, 'Achat — Cupra'], [evtC.id, 'Achat'], [evtE.id, 'Achat — Pneus hiver']]));
    const avant = await photo(compte, [cupra.id]);

    // ── À BLANC : rapport avant / après, aucune écriture ─────────────────────
    const { reprisePurchaseTitles } = await import('@/services/business-operations/agenda-projection/purchase-title-reprise');
    emis.length = 0;
    const blanc = await reprisePurchaseTitles(compte.id, { today: AUJ });
    expect(blanc).toMatchObject({ applied: false, examined: 5, labelsRenamed: 0, eventsRenamed: 0, remaining: false });
    const parOp = new Map(blanc.operations.map((o) => [o.operationId, o]));
    expect(parOp.get(opA.id)).toMatchObject({
      label: { before: 'Achat', after: NOM_CARBURANT, basis: 'CATEGORY', action: 'RENAME' },
      events: [{ itemId: evtA.id, before: 'Achat', after: NOM_CARBURANT, action: 'RENAME', origin: 'OPERATION_PROJECTION', date: AUJ }], otherPendingActions: [],
    });
    expect(parOp.get(opB.id)).toMatchObject({
      label: { before: 'Achat', after: NOM_CARBURANT, action: 'RENAME' },
      events: [{ itemId: evtB.id, before: 'Achat — Cupra', after: NOM_CARBURANT, action: 'RENAME', origin: 'DOCUMENT' }], otherPendingActions: [],
    });
    // C : l'utilisateur a corrigé la date depuis l'Agenda — l'opération porte sa saisie (source « déclaration de
    // l'utilisateur »). Carte #859 (défaut déclaré : « une correction de la date peut empêcher toute amélioration
    // ultérieure du titre ») : ni l'intitulé ni le titre n'ont été choisis par l'utilisateur — tous deux SYSTEM, repris.
    expect((await k.sources(opC.id)).filter((x) => x.active).map((x) => x.source_kind).sort()).toEqual(['DOCUMENT', 'USER_DECLARATION']);
    expect(parOp.get(opC.id)).toMatchObject({
      label: { before: 'Achat', after: NOM_CARBURANT, action: 'RENAME', titleAuthority: { authority: 'SYSTEM' } },
      events: [{ itemId: evtC.id, before: 'Achat', after: NOM_CARBURANT, action: 'RENAME', origin: 'OPERATION_PROJECTION', titleAuthority: { authority: 'SYSTEM' } }],
    });
    // D : intitulé corrigé par l'utilisateur — ni l'opération ni son événement ne sont repris (aucun titre à corriger : non listée).
    expect(parOp.get(opD.id)?.label).toMatchObject({ action: 'KEEP_USER_LABEL', titleAuthority: { authority: 'USER' }, blockedExpected: NOM_CARBURANT });
    expect(parOp.get(opD.id)?.events.some((e) => e.action === 'RENAME') ?? false).toBe(false);
    // E : l'intitulé de l'opération est corrigé ; le titre explicite de l'événement n'est pas un titre à renommer.
    expect(parOp.get(opE.id)).toMatchObject({ label: { action: 'RENAME', after: NOM_CARBURANT }, events: [] });
    expect(blanc).toMatchObject({ labelsToRename: 4, eventsToRename: 3, keptUnknown: 0 });
    expect(await photo(compte, [cupra.id])).toEqual(avant);
    expect((await evenements(compte)).map((e) => e.title)).toEqual(avantListe.map((e) => e.title));
    expect((await actifs(compte)).map((o) => o.label)).toEqual(['Achat', 'Achat', 'Achat', 'Plein des vacances', 'Achat']);
    expect(emis).toEqual([]);
    // Le contrôle de cohérence existant fait le MÊME constat (règle de consolidation rejouée à blanc) : intitulé du système
    // à corriger pour A, B, C (carte #859 : sa date corrigée ne protège plus l'intitulé) et E ; rien pour D (intitulé de
    // l'utilisateur). À blanc : aucune écriture.
    const constats = await inspecter(compte, [opA.id, opB.id, opC.id, opD.id, opE.id]);
    expect(constats.get(opA.id)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'OPERATION_NAME_NOT_APPLIED', expected: { technicalLabel: NOM_CARBURANT, basis: 'CATEGORY' }, observed: { technicalLabel: 'Achat' } });
    expect([opB.id, opC.id, opE.id].map((id) => constats.get(id)?.anomaly)).toEqual(['OPERATION_NAME_NOT_APPLIED', 'OPERATION_NAME_NOT_APPLIED', 'OPERATION_NAME_NOT_APPLIED']);
    expect(constats.get(opD.id)?.anomaly ?? null).toBeNull();
    await controler(compte, [opA.id, opB.id, opC.id, opD.id, opE.id], 'DRY_RUN');
    expect(await photo(compte, [cupra.id])).toEqual(avant);
    expect((await evenements(compte)).map((e) => e.title)).toEqual(avantListe.map((e) => e.title));
    expect((await actifs(compte)).map((o) => o.label)).toEqual(['Achat', 'Achat', 'Achat', 'Plein des vacances', 'Achat']);

    // ── RÉEL ─────────────────────────────────────────────────────────────────
    const historiqueAvant = await k.historique(compte);
    const reel = await reprisePurchaseTitles(compte.id, { apply: true, today: AUJ });
    expect(reel).toMatchObject({ applied: true, labelsRenamed: 4, eventsRenamed: 3 });
    const apresListe = await evenements(compte);
    // Même NOMBRE d'événements, mêmes IDENTIFIANTS ; seuls les trois titres SYSTEM ont changé.
    expect(apresListe.map((e) => e.id)).toEqual(avantListe.map((e) => e.id));
    const titres = new Map(apresListe.map((e) => [e.id, e.title]));
    expect(titres.get(evtA.id)).toBe(NOM_CARBURANT);
    expect(titres.get(evtB.id)).toBe(NOM_CARBURANT);
    expect(titres.get(evtC.id)).toBe(NOM_CARBURANT); // carte #859 : seule sa date avait été corrigée — titre SYSTEM amélioré
    expect((await evenements(compte)).find((e) => e.id === evtC.id)).toMatchObject({ date: '2026-09-06', modifie: true }); // date de l'utilisateur intacte
    expect(titres.get(evtD.id)).toBe(avantListe.find((e) => e.id === evtD.id)!.title); // opération corrigée par l'utilisateur
    expect(titres.get(evtE.id)).toBe('Achat — Pneus hiver'); // titre explicite
    expect((await actifs(compte)).map((o) => [o.id, o.label])).toEqual([[opA.id, NOM_CARBURANT], [opB.id, NOM_CARBURANT], [opC.id, NOM_CARBURANT], [opD.id, 'Plein des vacances'], [opE.id, NOM_CARBURANT]]);
    // TOUT LE RESTE est identique : dates, types, statuts, montants, coût de possession, relations, cartes, rappels, notifications, retraits.
    expect(await photo(compte, [cupra.id])).toEqual(avant);
    // Aucune notification ni création d'événement émise par le renommage.
    expect(emis.filter((t) => /AGENDA_ITEM_CREATED|AGENDA_ITEM_DELETED|NOTIFICATION/.test(t))).toEqual([]);
    // Traces : historique de l'opération (ancien intitulé, nouvel intitulé, motif) ; renommage de l'événement du document journalisé.
    expect(await k.historique(compte)).toBe(historiqueAvant + 4);
    expect(await sql<Json[]>`SELECT reason_code, before_json ->> 'technical_label' AS avant, after_json ->> 'technical_label' AS apres FROM business_operation_history WHERE account_id = ${compte.id} AND operation_id = ${opA.id} ORDER BY id DESC LIMIT 1`)
      .toEqual([{ reason_code: 'T3_ACQUISITION_NAME_APPLIED', avant: 'Achat', apres: NOM_CARBURANT }]);
    expect(await sql<Json[]>`SELECT kind, detail ->> 'from' AS de, detail ->> 'to' AS vers, run_id IS NOT NULL AS execution FROM agenda_intervention_consolidations WHERE account_id = ${compte.id} AND principal_item_id = ${evtB.id}`)
      .toEqual([{ kind: 'RETITLE', de: 'Achat — Cupra', vers: NOM_CARBURANT, execution: true }]);
    // Surfaces : fiche, Timeline, Agenda — même intitulé ; Cupra reste le bien associé.
    expect((await page(compte, opA.id))).toMatchObject({ title: NOM_CARBURANT });
    expect((await page(compte, opA.id)).assets.map((a) => a.name)).toEqual(['Cupra']);
    // Timeline de la Cupra : cinq opérations ; quatre portent « Achat de carburant » (dont celle dont l'utilisateur n'a corrigé
    // que la date — carte #859), celle de l'utilisateur son intitulé.
    expect((await timeline(compte, cupra.id)).filter((e) => e.kind === 'group').map((e) => e.title).sort()).toEqual(['Achat — Plein des vacances', NOM_CARBURANT, NOM_CARBURANT, NOM_CARBURANT, NOM_CARBURANT].sort());
    expect((await agenda(compte)).filter((a) => [evtA.id, evtB.id].includes(Number(a.id))).map((a) => a.title)).toEqual([NOM_CARBURANT, NOM_CARBURANT]);

    // Après la reprise : le contrôle de cohérence ne voit plus aucun écart sur ces opérations.
    expect([...(await inspecter(compte, [opA.id, opB.id, opC.id, opD.id, opE.id])).values()].map((i) => i.verdict)).toEqual(['CONSISTENT', 'CONSISTENT', 'CONSISTENT', 'CONSISTENT', 'CONSISTENT']);

    // ── IDEMPOTENCE : second passage, à blanc puis réel — rien à faire, rien d'écrit ─────────────────────────────────
    const apres = await photo(compte, [cupra.id]);
    const encore = await reprisePurchaseTitles(compte.id, { apply: true, today: AUJ });
    expect(encore).toMatchObject({ labelsToRename: 0, eventsToRename: 0, labelsRenamed: 0, eventsRenamed: 0 });
    expect(await photo(compte, [cupra.id])).toEqual(apres);
    expect(await k.historique(compte)).toBe(historiqueAvant + 4);
    expect((await evenements(compte)).map((e) => [e.id, e.title])).toEqual(apresListe.map((e) => [e.id, e.title]));
    // BORNE : une opération par appel, par curseur — même résultat qu'en une fois.
    const page1 = await reprisePurchaseTitles(compte.id, { today: AUJ, limit: 1 });
    expect(page1).toMatchObject({ examined: 1, remaining: true, nextAfterOperationId: opA.id });
    expect((await reprisePurchaseTitles(compte.id, { today: AUJ, limit: 1, afterOperationId: opE.id })).examined).toBe(0);
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L116I-E2E-03 — non-confusion : l’accessoire porte sa désignation ; « Achat Cupra » seulement quand l’acquisition du véhicule est établie ; rattachement seul ou rien de fiable → « Achat », jamais le bien ni le fournisseur', async () => {
    const { compte, cupra, velo } = await compteCupra();
    // 1. Accessoire du vélo : facture « Polisport groovy coussin gris » rattachée à « Jean Fourche ».
    const fAcc = await analyser(compte, velo.id, { type: 'ACQUISITION_INVOICE', titreModele: 'Facture Polisport groovy coussin gris', date: '2026-11-18', fournisseur: 'Cycles Exemple', montant: 2490,
      candidats: [achat(velo.id, { summary: 'Coussin pour siège enfant', provider: 'Cycles Exemple', businessReferences: [ref('INVOICE', 'FA-778')] as never,
        temporalHints: { realizedDate: '2026-11-18' }, financialHints: [fh('REALIZED_COST', 2490, { economicDate: '2026-11-18' })] })] });
    // 2. Acquisition de la Cupra ELLE-MÊME : facture du véhicule, preuve canonique de la date d'achat de la Cupra (mécanisme existant).
    const fVeh = await analyser(compte, cupra.id, { type: 'ACQUISITION_INVOICE', titreModele: 'Facture N° VN-2024-0457', date: '2024-03-02', fournisseur: 'Concession Exemple', montant: 3_890_000,
      candidats: [achat(cupra.id, { summary: 'Achat', provider: 'Concession Exemple', businessReferences: [ref('INVOICE', 'VN-2024-0457')] as never,
        temporalHints: { realizedDate: '2024-03-02' }, financialHints: [fh('REALIZED_COST', 3_890_000, { economicDate: '2024-03-02' })] })] });
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, canonical_key, value_json, source_type, source_id, confidence, fingerprint,
                evidence_excerpt, target_type, target_entity_id, projection_rule)
      VALUES (${compte.id}, ${cupra.id}, 'acquisitionDate', 'acquisitionDate', ${JSON.stringify('2024-03-02')}::jsonb, 'document', ${fVeh}, 'certain', ${`fp-821-${fVeh}`}, 'Facture : extrait',
              'ASSET', ${cupra.id}, 'PURCHASE_RECEIPT_ACQUISITION_DATE')`;
    // 3. Dépense rattachée à la Cupra dont RIEN ne dit l'objet : ticket « Ticket TotalEnergies » (le fournisseur seul), résumé « Achat ».
    const fRien = await ticket(compte, cupra.id, { titre: 'Ticket TotalEnergies', date: '2026-11-19', cents: 1500 });
    // 4. Ticket dont le titre proposé n'est que le nom du bien (« Ticket Cupra ») : le rattachement ne nomme pas l'achat.
    const fBien = await ticket(compte, cupra.id, { titre: 'Ticket Cupra', station: 'Intermarché', date: '2026-09-17', cents: 900 });
    expect((await sql<Json[]>`SELECT title_basis ->> 'subject' AS s FROM asset_files WHERE id = ANY(${[fRien, fBien]}) ORDER BY id`).map((x) => x.s)).toEqual(['TotalEnergies', 'Cupra']);
    await chaine(compte);

    const ops = await actifs(compte);
    const opDe = async (fileId: number) => {
      const [s] = await sql<Json[]>`SELECT operation_id::int AS op FROM business_operation_sources WHERE account_id = ${compte.id} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(fileId)} AND active`;
      return ops.find((o) => o.id === s.op)!;
    };
    const evtDe = async (opId: number) => (await evenements(compte)).filter((e) => e.op === opId);
    // 1. L'accessoire : sa désignation — jamais « Achat Jean Fourche », jamais « Achat — Cycles Exemple ».
    const acc = await opDe(fAcc);
    expect(acc.label).toBe('Achat Polisport groovy coussin gris');
    expect((await evtDe(acc.id)).map((e) => [e.title, e.biens])).toEqual([['Achat Polisport groovy coussin gris', [velo.id]]]);
    // 2. Le véhicule : « Achat Cupra », parce que l'acquisition du bien est ÉTABLIE (preuve canonique de ce document).
    const veh = await opDe(fVeh);
    expect(veh.label).toBe('Achat Cupra');
    expect((await evtDe(veh.id)).map((e) => [e.title, e.date])).toEqual([['Achat Cupra', '2024-03-02']]);
    expect((await page(compte, veh.id)).title).toBe('Achat Cupra');
    // 3 et 4. Rien de fiable : intitulé existant (résumé « Achat »), événement au libellé NEUTRE — ni la Cupra, ni TotalEnergies.
    for (const f of [fRien, fBien]) {
      const o = await opDe(f);
      expect(o.label, String(f)).toBe('Achat');
      const [e] = await evtDe(o.id);
      expect(e).toMatchObject({ title: 'Achat', biens: [cupra.id] });
      expect((await page(compte, o.id)).title).toBe('Achat');
    }
    const tous = await evenements(compte);
    expect(tous.filter((e) => /Cupra/.test(e.title)).map((e) => e.op)).toEqual([veh.id]); // « Cupra » n'apparaît que pour l'achat du véhicule
    expect(tous.some((e) => /TotalEnergies|Cycles Exemple|Concession|Jean Fourche|Ticket|Facture|IMG_/.test(e.title))).toBe(false); // ni fournisseur, ni bien associé, ni nom de justificatif
    // Preuve d'acquisition RETIRÉE : « Achat Cupra » n'a plus de fondement — l'intitulé (posé par le système, la provenance
    // l'atteste) revient au repli existant, le résumé « Achat » ; l'événement EXISTANT retrouve le libellé neutre.
    const [evtVeh] = await evtDe(veh.id);
    await sql`UPDATE field_evidence SET status = 'superseded' WHERE account_id = ${compte.id} AND source_id = ${fVeh} AND canonical_key = 'acquisitionDate'`;
    const { previewAcquisitionNames, reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    expect((await previewAcquisitionNames(compte.id, [veh.id], AUJ)).get(veh.id)).toMatchObject({ stored: 'Achat Cupra', expected: 'Achat', basis: null, systemLabel: true, wouldChange: true });
    await reconsolidateOperations(compte.id, [veh.id], { today: AUJ });
    await projeter(compte);
    expect((await actifs(compte)).find((o) => o.id === veh.id)).toMatchObject({ label: 'Achat' });
    expect(await evtDe(veh.id)).toEqual([expect.objectContaining({ id: evtVeh.id, title: 'Achat', date: '2024-03-02' })]);
    expect((await evenements(compte)).some((e) => /Cupra/.test(e.title))).toBe(false);
    // La fiche de la Cupra n'a reçu ni date ni prix d'achat des tickets.
    const [fiche] = await sql<Json[]>`SELECT key_characteristics::jsonb ->> 'acquisitionPrice' AS p FROM assets WHERE id = ${cupra.id}`;
    expect(fiche.p).toBeNull();
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('L116I-E2E-04 — rejouabilité : T3, T4 et le contrôle de cohérence rejoués ne créent aucun doublon et ne rétablissent jamais « Achat » ; le contrôle répare seul un événement automatique resté « Achat » ; commande seule : toujours aucun événement', async () => {
    const { compte, cupra, velo } = await compteCupra();
    const f = await ticket(compte, cupra.id);
    const evt = await evenementDuDocument(compte, cupra.id, f, { titreDocument: 'Ticket de carburant TotalEnergies' });
    expect(evt.titreCandidat).toBe('Achat — Ticket de carburant TotalEnergies'); // le nom du justificatif ne désigne pas l'objet acheté
    // Commande seule d'un accessoire (carte #813) : aucun événement, avant comme après.
    const fBon = await analyser(compte, velo.id, { type: 'ACQUISITION_ORDER', titreModele: 'Bon de commande Polisport groovy coussin gris', date: '2026-11-12', fournisseur: 'Cycles Exemple', montant: 2490,
      candidats: [achat(velo.id, { summary: 'Coussin pour siège enfant', provider: 'Cycles Exemple', businessReferences: [ref('ORDER', 'CMD-2026-0042')] as never,
        temporalHints: {}, financialHints: [fh('REALIZED_COST', 2490)] })] });
    await passer(compte);
    const [op] = (await actifs(compte)).filter((o) => o.status === 'REALIZED');
    expect((await actifs(compte)).length).toBe(2);
    expect(op.label).toBe(NOM_CARBURANT);
    // Avant toute projection : l'événement du document porte encore le titre du catalogue ; le contrôle de cohérence le voit et le répare SEUL.
    expect((await evenements(compte)).map((e) => e.title)).toEqual(['Achat — Ticket de carburant TotalEnergies']);
    const constat = (await inspecter(compte, [op.id])).get(op.id)!;
    expect(constat).toMatchObject({ verdict: 'REPAIRABLE' });
    await controler(compte, [op.id], 'CORRECTIVE');
    expect(await evenements(compte)).toEqual([expect.objectContaining({ id: evt.id, title: NOM_CARBURANT, op: op.id, date: AUJ, biens: [cupra.id] })]);
    expect((await inspecter(compte, [op.id])).get(op.id)?.verdict).toBe('CONSISTENT');

    // STOCK SANS SCRIPT : un achat consolidé avant que sa désignation soit connue (intitulé et événement « Achat ») est
    // repris par le SEUL contrôle de cohérence quotidien — à blanc (constat, aucune écriture), puis correctif.
    const fStock = await ticket(compte, cupra.id, { sansTitre: true, station: 'Esso', date: '2026-10-02', cents: 5510 });
    await chaine(compte);
    const stock = (await actifs(compte)).find((o) => o.label === 'Achat')!;
    const evtStock = (await evenements(compte)).find((e) => e.op === stock.id)!;
    expect(evtStock).toMatchObject({ title: 'Achat', date: '2026-10-02', origine: 'OPERATION' });
    await titrer(compte, fStock);
    const avantControle = await photo(compte, [cupra.id, velo.id]);
    expect((await inspecter(compte, [stock.id])).get(stock.id)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'OPERATION_NAME_NOT_APPLIED', expected: { technicalLabel: NOM_CARBURANT } });
    await controler(compte, [stock.id], 'DRY_RUN');
    expect((await actifs(compte)).find((o) => o.id === stock.id)).toMatchObject({ label: 'Achat' });
    expect((await evenements(compte)).find((e) => e.id === evtStock.id)).toMatchObject({ title: 'Achat' });
    await controler(compte, [stock.id], 'CORRECTIVE');
    expect((await actifs(compte)).find((o) => o.id === stock.id)).toMatchObject({ label: NOM_CARBURANT });
    expect((await evenements(compte)).filter((e) => e.op === stock.id)).toEqual([expect.objectContaining({ id: evtStock.id, title: NOM_CARBURANT, date: '2026-10-02', biens: [cupra.id] })]);
    expect(await photo(compte, [cupra.id, velo.id])).toEqual(avantControle); // tout le reste identique
    expect((await inspecter(compte, [stock.id])).get(stock.id)?.verdict).toBe('CONSISTENT');

    // Trois cycles complets T3 → T4 → contrôle de cohérence (simulation) : rien ne bouge.
    const reference = await photo(compte, [cupra.id, velo.id]);
    const historique = await k.historique(compte);
    for (let i = 0; i < 3; i++) {
      await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE account_id = ${compte.id} AND file_id = ${f}`; // nouvelle consolidation du ticket
      const r = await chaine(compte);
      expect(r.created + r.removed + (r.retitled ?? 0), `cycle ${i}`).toBe(0);
      expect((await projeter(compte, { dryRun: true })).plans ?? [], `cycle ${i}`).toEqual([]);
      expect((await inspecter(compte, [op.id])).get(op.id)?.verdict, `cycle ${i}`).toBe('CONSISTENT');
      const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
      await reconsolidateOperations(compte.id, [op.id], { today: AUJ });
    }
    expect((await evenements(compte)).map((e) => [e.id, e.title, e.op])).toEqual([[evt.id, NOM_CARBURANT, op.id], [evtStock.id, NOM_CARBURANT, stock.id]]);
    expect((await actifs(compte)).find((o) => o.id === op.id)).toMatchObject({ label: NOM_CARBURANT });
    expect(await photo(compte, [cupra.id, velo.id])).toEqual(reference);
    expect(await k.historique(compte)).toBe(historique);
    // Commande seule : opération envisagée nommée par sa désignation, AUCUN événement (règle de la carte #813 intacte).
    const commande = (await actifs(compte)).find((o) => o.status === 'ENVISAGED')!;
    expect(commande).toMatchObject({ status: 'ENVISAGED', label: 'Achat Polisport groovy coussin gris' });
    expect((await evenements(compte)).filter((e) => e.op === commande.id)).toEqual([]);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE id = ${fBon} AND deleted_at IS NULL`)[0].n).toBe(1);

    // Une modification de l'utilisateur APRÈS le renommage reste : la projection et la reprise ne la réécrivent pas.
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(evt.id, { title: 'Plein avant Lyon' }, compte.id, compte.owner.id);
    await chaine(compte);
    const { reprisePurchaseTitles } = await import('@/services/business-operations/agenda-projection/purchase-title-reprise');
    expect(await reprisePurchaseTitles(compte.id, { apply: true, today: AUJ })).toMatchObject({ eventsToRename: 0, labelsToRename: 0 });
    expect((await evenements(compte)).find((e) => e.id === evt.id)).toMatchObject({ title: 'Plein avant Lyon', modifie: true });
  });

  // ══ 05 ═══════════════════════════════════════════════════════════════════

  it('L116I-E2E-05 — relevé du cas réel : les requêtes en lecture seule de la fiche de recette (§ 5) s’exécutent sur le schéma réel et rendent les données d’où le titre est tiré', async () => {
    const { compte, cupra } = await compteCupra();
    const f = await ticket(compte, cupra.id);
    const evt = await evenementDuDocument(compte, cupra.id, f);
    await chaine(compte);
    const [op] = await actifs(compte);
    const { readFileSync } = await import('node:fs');
    const fiche = readFileSync('docs/exploitation/recette-116i-titre-evenements-achat.md', 'utf8');
    const bloc = /```sql\n([\s\S]*?)```/.exec(fiche)?.[1] ?? '';
    const requetes = bloc.split(';').map((q) => q.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    expect(requetes.length).toBeGreaterThanOrEqual(12);
    const valeurs: Record<string, string> = { ':compte': String(compte.id), ':fichier': String(f), ':operation': String(op.id), ':evenement': String(evt.id), ':bien': String(cupra.id) };
    const resultats: Json[][] = [];
    for (const q of requetes) {
      expect(q).toMatch(/^SELECT/i); // lecture seule
      expect(q).not.toMatch(/\b(UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE)\b/i);
      const texte = q.replace(/:(compte|fichier|operation|evenement|bien)\b/g, (m) => valeurs[m]);
      resultats.push(await sql.unsafe(texte) as unknown as Json[]);
    }
    // Les quatre données demandées par la carte sont bien rendues : désignation extraite, catégorie de dépense (textes
    // d'où elle se lit), sujet du titre du document, candidat T1 — et le chemin réel de l'événement.
    const tout = JSON.stringify(resultats);
    expect(tout).toContain('de carburant TotalEnergies'); // sujet du titre du document (désignation persistée)
    expect(tout).toContain('"summary":"Achat"'); // candidat T1
    expect(tout).toContain(NOM_CARBURANT); // intitulé de l'opération et titre de l'événement
    expect(tout).toContain('"origin_ref_type":"asset_file"'); // chemin : décision T4 du document
  });
});
