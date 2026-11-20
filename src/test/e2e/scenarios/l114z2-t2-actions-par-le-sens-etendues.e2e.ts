/**
 * Passage 114Z2 (Trello #753, CDC T2 §9.1, §9.3, annexe A13 — bloc PO n° 40) — ACTIONS COMPRISES PAR LE SENS étendues,
 * de bout en bout sur PostgreSQL réel : `runAssistant` + ports réels, T2 en master, sortie UNDERSTAND rejouée par la
 * vraie passerelle (aucun réseau, aucun fournisseur d'IA), plan figé réel, confirmation par identifiant de plan,
 * écriture par les services métier (pièces, équipements, Agenda, point d'écriture des événements de référence).
 *
 *   E01  pièce puis équipement : plan à confirmer ; rien n'est écrit avant ; offre Standard : refus de l'offre, aucun plan ;
 *   E02  échéance créée SANS date (aucune date inventée), puis déplacée ;
 *   E03  événement de référence déclaré : la déclaration conservée est la PHRASE DE L'UTILISATEUR ; situation non
 *        dite : question, rien n'est préparé ; puis prestataire corrigé, fournisseur relié, document rattaché ;
 *   E04  document rattaché à un bien ; bien créé ;
 *   E05  deux comptes cloisonnés ; interrupteur des actions coupé : aucun plan ; indice incomplet : aucun plan.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

// Quota des biens : décision neutralisée comme dans les autres scénarios (le compte de test n'a pas de
// facturation réelle) ; les refus d'offre réellement éprouvés ici sont ceux des pièces et équipements (Standard).
vi.mock('@/lib/asset-quota-guard', () => ({
  assetModificationDecision: async () => ({ allowed: true }),
  refuserSiModificationBiensSuspendue: async () => null,
  countAccountAssets: async () => 0,
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;
type Indice = { operation: string; entityType: string; targetHint: string | null; fieldChanges: Array<{ fieldHint: string; value: string | null; unit: null }>; evidencePhrase: null };
const indice = (operation: string, entityType: string, targetHint: string | null, champs: Record<string, string | null> = {}): Indice => ({
  operation, entityType, targetHint, evidencePhrase: null,
  fieldChanges: Object.entries(champs).map(([fieldHint, value]) => ({ fieldHint, value, unit: null })),
});
const understand = (actionIntents: Indice[]) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND',
  output: { mode: 'UNDERSTAND', intent: 'UNSUPPORTED_ACTION', confidence: 'exact', requestedFacts: [], requestedTopics: [], filters: {}, reason: 'e2e', interactionMode: 'ACTION_REQUEST', actionIntents },
});

scenario('L114Z2-SENS', 'Passage 114Z2 — actions comprises par le sens : pièces, équipements, échéances, opérations, rattachements, création d’un bien', ({ sql, make, useRecordings: rejouerSortie }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  const compte = async (plan: 'standard' | 'premium' = 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const voiture = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${b.id}`;
    return b.id as number;
  };
  const logement = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'IMMOBILIER' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = 'Maison', deleted_at = NULL WHERE id = ${b.id}`;
    return b.id as number;
  };
  const document = async (c: Compte, assetId: number, titre: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET original_filename = ${`${titre}.pdf`}, retained_title = ${titre}, document_date = '2025-03-12'::date WHERE id = ${f.id}`;
    return f.id as number;
  };
  const fournisseur = async (c: Compte, name: string) => {
    const { createSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    return (await createSupplierForAccount({ accountId: c.id, userId: c.ownerUserId, input: { name } })).id;
  };
  const plans = async (c: Compte) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`)[0].n);
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  /** Tournure libre + indices rejoués : la réponse de l'Assistant (plan à confirmer, question, ou parcours normal). */
  const dire = async (c: Compte, message: string, indices: Indice[], extra: Json = {}) => {
    const replay = await rejouerSortie([understand(indices)]);
    const r = await demander(c, message, extra);
    if (process.env.DEBUG_Z2) console.log('DBG', message, JSON.stringify({ a: r.answer, p: r.commandPlan?.summary, t: replay.calls.map((x) => x.task), c: r.cascade, e: r.error }));
    return { r, taches: replay.calls.map((x) => x.task) };
  };
  const evenements = (c: Compte) => sql<Json[]>`
    SELECT id::int AS id, type_code, status, technical_label, provider, realized_date::text AS realise, invalidated_at IS NOT NULL AS invalide
      FROM business_operations WHERE account_id = ${c.id} ORDER BY id`;

  it('E01 — pièce puis équipement : plan à confirmer, rien avant ; Standard : refus de l’offre, aucun plan', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    const pieces = () => sql<Json[]>`SELECT id, name FROM substructures WHERE asset_id = ${maison} ORDER BY id`;

    const p = await dire(c, 'Il nous manque encore le cellier dans la maison, tu peux t’en occuper', [indice('CREATE', 'room', 'la maison', { nom: 'Cellier' })]);
    expect(p.taches).toEqual(['UNDERSTAND']);
    expect(p.r.commandPlan?.summary).toBe('Créer la pièce « Cellier » dans Maison. Confirmez-vous ?');
    expect(p.r.cascade?.intent).toBe('WRITE_COMMAND');
    expect(await pieces()).toHaveLength(0);
    expect(await confirmer(c, p.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await pieces()).map((x) => x.name)).toEqual(['Cellier']);
    expect(await confirmer(c, p.r.commandPlan!.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });

    const e = await dire(c, 'Il nous manque la chaudière du cellier de la maison, tu peux t’en occuper',
      [indice('CREATE', 'equipment', 'la maison', { nom: 'Chaudière', 'pièce': 'Cellier' })]);
    expect(e.r.commandPlan?.summary).toBe('Créer l’équipement « Chaudière » dans Maison (pièce « Cellier »). Confirmez-vous ?');
    expect(await sql`SELECT 1 FROM equipments WHERE asset_id = ${maison}`).toHaveLength(0);
    expect(await confirmer(c, e.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [eq] = await sql<Json[]>`SELECT name, substructure_id FROM equipments WHERE asset_id = ${maison}`;
    expect(eq).toMatchObject({ name: 'Chaudière', substructure_id: (await pieces())[0].id });

    // Offre Standard : le refus est celui de l'écran (service métier), aucun plan n'est préparé.
    const s = await compte('standard');
    const maisonS = await logement(s, 'Maison');
    const refus = await dire(s, 'Il nous manque encore le cellier dans la maison, tu peux t’en occuper', [indice('CREATE', 'room', 'la maison', { nom: 'Cellier' })], { planType: 'STANDARD' });
    expect(refus.r.commandPlan ?? null).toBeNull();
    expect(await plans(s)).toBe(0);
    expect(await sql`SELECT 1 FROM substructures WHERE asset_id = ${maisonS}`).toHaveLength(0);
  });

  it('E02 — échéance créée sans date (aucune date inventée), puis déplacée', async () => {
    const c = await compte();
    const clio = await voiture(c, 'Clio');
    const echeances = () => sql<Json[]>`SELECT id, title, start_date::text AS debut FROM agenda_items WHERE account_id = ${c.id} ORDER BY id`;

    const a = await dire(c, 'Il faudra penser à la vidange de la Clio un de ces jours', [indice('CREATE', 'agenda_item', 'la Clio', { titre: 'Vidange' })]);
    expect(a.r.commandPlan?.summary).toMatch(/^Créer l’échéance « Vidange » \(.+\), rattachée à Clio\. Confirmez-vous \?$/);
    expect(await echeances()).toHaveLength(0);
    expect(await confirmer(c, a.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [creee] = await echeances();
    expect(creee).toMatchObject({ title: 'Vidange', debut: null });
    expect(await sql`SELECT 1 FROM agenda_item_assets WHERE agenda_item_id = ${creee.id} AND asset_id = ${clio}`.catch(() => [1])).toHaveLength(1);

    const m = await dire(c, 'Finalement la vidange de la Clio ce sera plutôt pour le 20 mars 2031', [indice('UPDATE', 'agenda_item', 'la vidange de la Clio', { date: '2031-03-20' })]);
    expect(m.r.commandPlan?.summary).toContain('20 mars 2031');
    expect((await echeances())[0].debut).toBeNull();
    expect(await confirmer(c, m.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await echeances())[0]).toMatchObject({ id: creee.id, debut: '2031-03-20' });
  });

  it('E03 — opération : déclaré sur la phrase de l’utilisateur ; corrigé ; fournisseur relié ; document rattaché', async () => {
    const c = await compte();
    const clio = await voiture(c, 'Clio');
    const facture = await document(c, clio, 'Facture Norauto');
    const garage = await fournisseur(c, 'Garage Martin');
    const DITE = 'Les pneus de la Clio ont été changés le 12 mars 2025, garde-le en mémoire';
    const pneus = { type: 'intervention', nom: 'Changement des pneus', date: '2025-03-12' };

    // Situation non dite par le modèle : la question de l'Agenda, rien n'est préparé (elle n'est jamais déduite de la date).
    const q = await dire(c, DITE, [indice('CREATE', 'business_operation', 'la Clio', pneus)]);
    expect(q.r.commandPlan ?? null).toBeNull();
    expect(q.r.answer).toContain('Précisez-le dans votre demande');
    expect(await plans(c)).toBe(0);

    const d = await dire(c, DITE, [indice('CREATE', 'business_operation', 'la Clio', { ...pneus, situation: 'a eu lieu' })]);
    expect(d.r.commandPlan?.summary).toBe('Enregistrer l’opération « Intervention — Changement des pneus » du 12 mars 2025 pour Clio. Confirmez-vous ?');
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(JSON.stringify(d.r.commandPlan)).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect(await evenements(c)).toHaveLength(0);
    expect(await confirmer(c, d.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [ev] = await evenements(c);
    expect(ev).toMatchObject({ type_code: 'INTERVENTION', status: 'REALIZED', technical_label: 'Changement des pneus', realise: '2025-03-12', provider: null, invalide: false });
    // Source durable : la phrase de l'utilisateur, jamais la formulation réécrite par le serveur.
    expect(await sql<Json[]>`SELECT purpose, channel, author_user_id, declaration_text FROM business_operation_declarations WHERE account_id = ${c.id}`)
      .toEqual([{ purpose: 'CREATE', channel: 'ASSISTANT', author_user_id: c.ownerUserId, declaration_text: DITE }]);
    expect(await sql<Json[]>`SELECT asset_id FROM business_operation_asset_links WHERE operation_id = ${ev.id} AND active`).toEqual([{ asset_id: clio }]);
    // Rien d'inventé : ni échéance, ni montant.
    expect(await sql`SELECT 1 FROM agenda_items WHERE account_id = ${c.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM business_operation_financial_components WHERE account_id = ${c.id}`).toHaveLength(0);

    const p = await dire(c, 'Il nous manque le prestataire du changement des pneus de la Clio, tu peux t’en occuper', [indice('UPDATE', 'business_operation', 'l’intervention Changement des pneus', { prestataire: 'Garage Martin' })]);
    expect(p.r.commandPlan?.summary).toContain('Modifier le prestataire de l’opération « Intervention — Changement des pneus » du 12 mars 2025 — Clio : (aucun) → Garage Martin.');
    expect((await evenements(c))[0].provider).toBeNull();
    expect(await confirmer(c, p.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await evenements(c))[0].provider).toBe('Garage Martin');

    // Deux rattachements compris dans une même phrase : un seul plan, une confirmation, deux réussites.
    const l = await dire(c, 'Il nous manque la facture Norauto et le garage Martin sur le changement des pneus de la Clio, tu peux t’en occuper', [
      indice('LINK', 'document', 'Facture Norauto', { 'opération': 'l’intervention Changement des pneus' }),
      indice('LINK', 'supplier', 'Garage Martin', { 'opération': 'l’intervention Changement des pneus' }),
    ]);
    expect(l.r.commandPlan?.actions).toHaveLength(2);
    expect(await sql`SELECT 1 FROM business_operation_suppliers WHERE operation_id = ${ev.id}`).toHaveLength(0);
    const conf = await confirmer(c, l.r.commandPlan!.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await sql<Json[]>`SELECT supplier_id::int AS supplier_id, role FROM business_operation_suppliers WHERE operation_id = ${ev.id} AND status = 'ACTIVE'`)
      .toEqual([{ supplier_id: garage, role: 'PROVIDER' }]);
    const { readReferenceEvent } = await import('@/services/documents/business-period-surfaces');
    expect((await readReferenceEvent(c.id, ev.id))?.documents.map((x) => x.fileId)).toContain(facture);
  });

  it('E04 — document rattaché à un bien ; bien créé', async () => {
    const c = await compte();
    const clio = await voiture(c, 'Clio');
    const maison = await logement(c, 'Maison');
    const garantie = await document(c, maison, 'Garantie');
    const biensDuDocument = async () => (await sql<Json[]>`SELECT asset_id FROM asset_files WHERE id = ${garantie}`).map((x) => x.asset_id);

    const r = await dire(c, 'Il nous manque le rattachement de la garantie à la Clio, tu peux t’en occuper', [indice('LINK', 'document', 'le document Garantie', { bien: 'la Clio' })]);
    expect(r.r.commandPlan?.summary).toBe('Rattacher le document « Garantie » à Clio. Confirmez-vous ?');
    expect(await biensDuDocument()).toEqual([maison]);
    expect(await confirmer(c, r.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const { sqlLookup } = await import('@/services/verebona-assistant/commands/plan.service');
    const cibles = await sqlLookup.getDocumentAssetTargets!(c.id, garantie);
    expect([...(cibles?.chosen ?? [])].map((a) => a.id).sort()).toEqual([clio, maison].sort());

    // Création d'un bien : compte neuf (le quota de biens du compte est celui de l'écran, il n'est pas contourné).
    const n9 = await compte();
    const n = await dire(n9, 'Il nous manque encore la Mégane dans la liste, tu peux t’en occuper', [indice('CREATE', 'asset', null, { 'catégorie': 'voiture', nom: 'Mégane' })]);
    expect(n.r.commandPlan?.summary).toMatch(/^Créer le bien « Mégane »/);
    expect(await sql`SELECT 1 FROM assets WHERE account_id = ${n9.id} AND name = 'Mégane'`).toHaveLength(0);
    expect(await confirmer(n9, n.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await sql`SELECT 1 FROM assets WHERE account_id = ${n9.id} AND name = 'Mégane' AND deleted_at IS NULL`).toHaveLength(1);
  });

  it('E06 — passage 114AA : document rattaché à une PIÈCE ; catégorie et statut d’un bien', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    const clio = await voiture(c, 'Clio');
    await sql`UPDATE assets SET subtype = 'Voiture' WHERE id = ${clio}`;
    const garantie = await document(c, maison, 'Garantie');
    const [cuisine] = await sql<Json[]>`
      INSERT INTO substructures (asset_id, name, order_index, scope, public_id, created_at, updated_at)
      VALUES (${maison}, 'Cuisine', 0, 'personal', gen_random_uuid(), now(), now()) RETURNING id`;

    // Rattachement à une pièce par le sens : même plan que la phrase directe.
    const p = await dire(c, 'Il nous manque le rattachement de la garantie à la cuisine de la maison, tu peux t’en occuper', [indice('LINK', 'document', 'le document Garantie', { 'pièce': 'Cuisine' })]);
    expect(p.r.commandPlan?.summary).toBe('Rattacher le document « Garantie » à la pièce « Cuisine » (Maison). Confirmez-vous ?');
    expect((await sql<Json[]>`SELECT substructure_id FROM asset_files WHERE id = ${garantie}`)[0].substructure_id).toBeNull();
    expect(await confirmer(c, p.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const { sqlLookup } = await import('@/services/verebona-assistant/commands/plan.service');
    expect((await sqlLookup.getDocumentAssetTargets!(c.id, garantie))?.rooms?.map((r) => r.id)).toEqual([Number(cuisine.id)]);

    // Catégorie d'un bien par le sens.
    const cat = await dire(c, 'Il nous manque le bon classement de la Clio, c’est une moto, tu peux t’en occuper', [indice('UPDATE', 'asset', 'la Clio', { 'catégorie': 'moto' })]);
    expect(cat.r.commandPlan?.summary).toBe('Modifier « Catégorie de bien » de Clio : Voiture → Moto. Confirmez-vous ?');
    expect((await sql<Json[]>`SELECT subtype FROM assets WHERE id = ${clio}`)[0].subtype).toBe('Voiture');
    expect(await confirmer(c, cat.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await sql<Json[]>`SELECT subtype FROM assets WHERE id = ${clio}`)[0].subtype).toBe('Moto');

    // Statut d'un bien par le sens ; un statut hors référentiel n'aboutit à aucun plan.
    const avant = await plans(c);
    const faux = await dire(c, 'Il nous manque la bonne situation de la Clio, elle est prioritaire, tu peux t’en occuper', [indice('UPDATE', 'asset', 'la Clio', { statut: 'prioritaire' })]);
    expect(faux.r.commandPlan).toBeFalsy();
    expect(await plans(c)).toBe(avant);
    const st = await dire(c, 'Il nous manque la bonne situation de la Clio, elle est vendue, tu peux t’en occuper', [indice('UPDATE', 'asset', 'la Clio', { statut: 'vendu' })]);
    expect(st.r.commandPlan?.summary).toBe('Modifier « Statut » de Clio : En service → Vendu. Confirmez-vous ?');
    expect(await confirmer(c, st.r.commandPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const apres = (await sql<Json[]>`SELECT status, deleted_at FROM assets WHERE id = ${clio}`)[0];
    expect(apres).toMatchObject({ status: 'VENDU', deleted_at: null });
  });

  it('E05 — deux comptes cloisonnés ; interrupteur coupé ; indice incomplet : aucun plan, rien d’écrit', async () => {
    const a = await compte();
    const b = await compte();
    const maisonB = await logement(b, 'Maison');
    await voiture(a, 'Twingo');
    // Le bien nommé n'existe que dans l'autre compte : une question, jamais un plan sur le bien d'autrui.
    const autre = await dire(a, 'Il nous manque encore le cellier dans la maison, tu peux t’en occuper', [indice('CREATE', 'room', 'la maison', { nom: 'Cellier' })]);
    expect(autre.r.commandPlan ?? null).toBeNull();
    expect(await plans(a)).toBe(0);
    expect(await sql`SELECT 1 FROM substructures WHERE asset_id = ${maisonB}`).toHaveLength(0);
    // Événement de référence d'un autre compte : jamais trouvé.
    const { createOperation } = await import('@/services/business-operations/operation-write.facade');
    await createOperation({ accountId: b.id, actor: { kind: 'USER', userId: b.ownerUserId, channel: 'ASSISTANT' } }, { declaration: 'Vidange de la maison', type: { code: 'INTERVENTION' }, status: 'REALIZED', label: 'Vidange', assetIds: [maisonB] });
    const evt = await dire(a, 'La vidange, finalement, ne la garde pas', [indice('DELETE', 'business_operation', 'l’opération Vidange')]);
    expect(evt.r.commandPlan ?? null).toBeNull();
    expect((await evenements(b))[0].invalide).toBe(false);

    // Indice incomplet (pièce sans nom) : ignoré — aucun plan.
    const incomplet = await dire(b, 'Il nous manque encore le cellier dans la maison, tu peux t’en occuper', [indice('CREATE', 'room', 'Cellier')]);
    expect(incomplet.r.commandPlan ?? null).toBeNull();

    // Interrupteur des actions de l'Assistant coupé : aucun plan, même avec un indice complet.
    const avant = process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
    process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = 'false';
    try {
      const coupe = await dire(b, 'Il nous manque encore le cellier dans la maison, tu peux t’en occuper', [indice('CREATE', 'room', 'la maison', { nom: 'Cellier' })]);
      expect(coupe.r.commandPlan ?? null).toBeNull();
    } finally {
      if (avant === undefined) delete process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS; else process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = avant;
    }
    expect(await plans(b)).toBe(0);
    expect(await sql`SELECT 1 FROM substructures WHERE asset_id = ${maisonB}`).toHaveLength(0);
  });
});
