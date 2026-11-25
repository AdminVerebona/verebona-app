/**
 * Carte #843 — ASSISTANT T2, écarts restants après #807 : INTÉGRITÉ et SÉCURITÉ des écritures, de bout en bout sur
 * PostgreSQL réel (plan figé, confirmation, façades métier des écrans). Aucun appel à un fournisseur d'IA.
 *
 *   T01  E02  créer un équipement AVEC sa fiche : panne injectée après la création → RIEN (ni équipement, ni fiche),
 *             jamais « créé » ; rejeu sans doublon ; double clic ; deux créations simultanées ; champ invalide au
 *             commit ; offre revérifiée au commit ;
 *   T02  E07  Duo, anciennes voies : A prépare, B modifie, A confirme → aucune écriture périmée, CONFLIT explicite,
 *             données relues, NOUVELLE proposition à reconfirmer (renommer / retirer un équipement, renommer /
 *             supprimer une pièce, archiver un fournisseur, supprimer une échéance, modifier / supprimer un
 *             document, rattacher un document à une opération) ;
 *   T03  E07  concurrence RÉELLE (l'écriture de B est validée PENDANT la confirmation de A) sur les anciennes voies
 *             ET les nouvelles : la version est exigée DANS la transaction de l'écriture ;
 *   T04  E04  IBAN : jamais en clair dans la proposition (même en attente), les traces, le fil, le journal des
 *             purges ; valeur scellée purgée à la confirmation, à l'annulation, à l'expiration ; purge en ÉCHEC
 *             simulée → tracée, comptée, reprise par le balayage ; panne pendant la clôture ; valeur purgée avant
 *             confirmation → refus ; IBAN invalide ; Duo ; compte tiers ; historique des fils masqué ;
 *   T05  E09  déplacer un document de A vers B : B refusé ou en PANNE → A conservé, rien d'écrit ; réussite → un
 *             seul document, liens tiers intacts ; « ajouter à B » conserve A ; Duo (B modifie l'opération) ;
 *             rejeu sans doublon.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const h = vi.hoisted(() => ({ panneFiche: false, panneRattachement: false }));

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// E02 : panne injectée APRÈS l'insertion de l'équipement, pendant l'écriture de sa fiche (même transaction).
vi.mock('@/services/canonical/entity-state/write-canonical-entity-field', async (o) => {
  const m = await o<typeof import('@/services/canonical/entity-state/write-canonical-entity-field')>();
  return {
    ...m,
    writeCanonicalEntityFieldsInTransaction: async (...a: Parameters<typeof m.writeCanonicalEntityFieldsInTransaction>) => {
      if (h.panneFiche) throw new Error('panne simulée (E02)');
      return m.writeCanonicalEntityFieldsInTransaction(...a);
    },
  };
});
// E09 : panne injectée pendant le RATTACHEMENT à B, après le retrait de A (même transaction).
vi.mock('@/services/business-operations/grouping/service', async (o) => {
  const m = await o<typeof import('@/services/business-operations/grouping/service')>();
  return {
    ...m,
    attachDocument: async (...a: Parameters<typeof m.attachDocument>) => {
      if (h.panneRattachement) throw new Error('panne simulée (E09)');
      return m.attachDocument(...a);
    },
  };
});

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;
const IBAN = 'FR7630006000011234567890189';
const IBAN_MIN = 'fr76 3000 6000 0112 3456 7890 189';
const IBAN_2 = 'FR7610278060610001020480101';
const sansEspaces = (v: unknown) => JSON.stringify(v ?? null).replace(/\s/g, '').toUpperCase();

scenario('C843-T2-INTEGRITE', 'Carte #843 — Assistant T2 : intégrité et sécurité des écritures (E02, E04, E07, E09)', ({ sql, make }) => {
  const compte = async (plan: 'standard' | 'premium' | 'premium_duo' = 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const membre = async (c: Compte): Promise<number> => {
    const u = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${u.id}, 'member', 'active')`;
    return u.id as number;
  };
  const logement = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'IMMOBILIER' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = 'Maison' WHERE id = ${b.id}`;
    return b.id as number;
  };
  const voiture = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = 'Voiture' WHERE id = ${b.id}`;
    return b.id as number;
  };
  const piece = async (assetId: number, name: string) => {
    const [r] = await sql<Json[]>`INSERT INTO substructures (asset_id, name, order_index, scope, public_id, created_at, updated_at)
      VALUES (${assetId}, ${name}, 0, 'personal', gen_random_uuid(), now(), now()) RETURNING id`;
    return Number(r.id);
  };
  const demander = async (c: Compte, message: string, userId = c.ownerUserId) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId, planType: 'PREMIUM', message, clientRequestId: `c843-${Math.random()}`, locale: 'fr-FR' } as never);
  };
  const confirmer = async (c: Compte, planId: string, userId = c.ownerUserId, strongConfirmation = false) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId, strongConfirmation });
  };
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  const faire = async (c: Compte, message: string) => {
    const r = planDe(await demander(c, message));
    return { plan: r, conf: await confirmer(c, r.plan.planId) };
  };
  const equipements = (assetId: number) => sql<Json[]>`
    SELECT id::int AS id, name, status, type, archived_at, updated_at FROM equipments WHERE asset_id = ${assetId} ORDER BY id`;
  const fiche = async (c: Compte, equipmentId: number) => {
    const { getCanonicalEntityState } = await import('@/services/canonical/entity-state/entity-view');
    const vue = await getCanonicalEntityState({ type: 'EQUIPMENT', id: equipmentId }, c.id);
    return Object.fromEntries(Object.entries(vue?.fields ?? {}).map(([k, f]) => [k, { value: f.value, origin: f.origin }]));
  };
  const fournisseur = async (c: Compte, input: Json) => {
    const { createSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    return (await createSupplierForAccount({ accountId: c.id, userId: c.ownerUserId, input: input as never })).id;
  };
  const ligneFournisseur = async (id: number) => (await sql<Json[]>`SELECT * FROM suppliers WHERE id = ${id}`)[0];
  const operations = (c: Compte) => sql<Json[]>`
    SELECT id::int AS id, technical_label, version FROM business_operations WHERE account_id = ${c.id} ORDER BY id`;
  const documentTitre = async (c: Compte, assetId: number, titre: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    return f.id as number;
  };
  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const membres = async (c: Compte, id: number) => Number((await sql<Json[]>`
    SELECT count(*)::int AS n FROM business_operation_documents WHERE account_id = ${c.id} AND operation_id = ${id} AND active`)[0].n);

  it('T01 — E02 : création atomique d’un équipement avec sa fiche — panne, rejeu, double clic, concurrence, validation, offre', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    const phrase = 'Ajoute un équipement Chaudière dans la maison : marque Viessmann, modèle Vitodens 200, numéro de série VS-1, prix d’achat 2 500 €';

    // Panne APRÈS l'insertion, pendant l'écriture de la fiche : la transaction est annulée — rien n'est créé.
    const p1 = planDe(await demander(c, phrase));
    h.panneFiche = true;
    const c1 = await confirmer(c, p1.plan.planId);
    h.panneFiche = false;
    expect(c1).toMatchObject({ ok: true, status: 'FAILED', results: [{ status: 'FAILED', message: 'L’équipement n’a pas pu être créé : rien n’a été enregistré (ni l’équipement, ni sa fiche). Vous pouvez refaire votre demande.' }] });
    expect(JSON.stringify(c1)).not.toMatch(/créé\./);
    expect(await equipements(maison)).toHaveLength(0);
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM canonical_field_writes WHERE account_id = ${c.id} AND target_type = 'EQUIPMENT'`)[0].n)).toBe(0);
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM equipment_cil_specs s JOIN equipments e ON e.id = s.equipment_id WHERE e.asset_id = ${maison}`)[0].n)).toBe(0);

    // Rejeu : la même demande, refaite → UN équipement, avec TOUTE sa fiche, origine utilisateur.
    const p2 = planDe(await demander(c, phrase));
    expect(await confirmer(c, p2.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED', results: [{ status: 'SUCCESS', message: 'Équipement « Chaudière » créé.' }] });
    const [ch] = await equipements(maison);
    expect(await equipements(maison)).toHaveLength(1);
    const f = await fiche(c, ch.id);
    expect(f.brand).toEqual({ value: 'Viessmann', origin: 'USER' });
    expect(f.modelName).toEqual({ value: 'Vitodens 200', origin: 'USER' });
    expect(f.serialNumber).toEqual({ value: 'VS-1', origin: 'USER' });
    expect(f.acquisitionPrice).toMatchObject({ value: 2500, origin: 'USER' });
    // Double clic : jamais rejoué.
    expect(await confirmer(c, p2.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await equipements(maison)).toHaveLength(1);

    // Deux créations SIMULTANÉES du même équipement (deux propositions, deux onglets) : une seule réussit.
    const pa = planDe(await demander(c, 'Ajoute un équipement Ballon dans la maison : marque Atlantic'));
    const pb = planDe(await demander(c, 'Ajoute un équipement Ballon dans la maison : marque Thermor'));
    const [ra, rb] = await Promise.all([confirmer(c, pa.plan.planId), confirmer(c, pb.plan.planId)]);
    const issues = [ra, rb].map((r) => (r.ok ? r.results[0].status : 'KO')).sort();
    expect(issues).toEqual(['REFUSED', 'SUCCESS']);
    expect(JSON.stringify([ra, rb])).toMatch(/existe déjà dans ce bien : rien n’a été créé en double/);
    expect((await equipements(maison)).filter((e) => e.name === 'Ballon')).toHaveLength(1);

    // Champ refusé AU COMMIT (proposition altérée après l'aperçu) : rien n'est créé.
    const pv = planDe(await demander(c, 'Ajoute un équipement Pompe dans la maison : marque Grundfos'));
    const { hashActions } = await import('@/services/verebona-assistant/commands/plan.service');
    const altere = pv.plan.actions.map((a) => ({ ...a, params: { ...(a.params as Json), details: { fiche: { powerKw: -3 } } } }));
    const payload = JSON.stringify(altere);
    await sql`UPDATE verebona_command_plans SET actions_payload = ${payload}, params_hash = ${hashActions(payload)} WHERE plan_id = ${pv.plan.planId}`;
    expect(await confirmer(c, pv.plan.planId)).toMatchObject({ ok: true, status: 'FAILED', results: [{ message: expect.stringMatching(/rien n’a été créé/) }] });
    expect((await equipements(maison)).filter((e) => e.name === 'Pompe')).toHaveLength(0);

    // Offre REVÉRIFIÉE au commit : passée en Standard entre l'aperçu et la confirmation → refus, rien n'est créé.
    const po = planDe(await demander(c, 'Ajoute un équipement Adoucisseur dans la maison : marque BWT'));
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${c.id}`;
    const co = await confirmer(c, po.plan.planId);
    expect(co).toMatchObject({ ok: true, status: 'FAILED', results: [{ status: 'REFUSED', message: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' }] });
    expect((await equipements(maison)).filter((e) => e.name === 'Adoucisseur')).toHaveLength(0);
  });

  it('T02 — E07 : Duo, anciennes voies — A prépare, B modifie, A confirme : conflit explicite, relecture, nouvelle confirmation', async () => {
    const c = await compte('premium_duo');
    const b = await membre(c);
    const maison = await logement(c, 'Maison');
    const facade = await import('@/services/assets/structure-write.facade');

    // Renommer un équipement (ancienne voie RENAME_EQUIPMENT, sans garde avant #843).
    await faire(c, 'Ajoute un équipement Chaudière dans la maison');
    const [ch] = await equipements(maison);
    const pr = planDe(await demander(c, 'Renomme l’équipement Chaudière en Chaudière principale'));
    await attendre(5);
    expect((await facade.updateEquipmentForAccount({ userId: b, currentAccountId: c.id }, maison, ch.id, { name: 'Chaudière gaz' })).status).toBe(200);
    const cr = await confirmer(c, pr.plan.planId);
    expect(cr).toMatchObject({ ok: true, status: 'FAILED', results: [{ status: 'FAILED', conflict: true }] });
    expect((await equipements(maison))[0].name).toBe('Chaudière gaz');
    if (!cr.ok) throw new Error('confirmation attendue');
    expect(cr.summary).toMatch(/J’ai relu les données actuelles : voici la proposition mise à jour/);
    expect(cr.refreshedPlan?.actions[0].preview).toBe('Renommer l’équipement « Chaudière gaz » (Maison) en « Chaudière principale ».');
    expect(await confirmer(c, cr.refreshedPlan!.planId, b)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(await confirmer(c, cr.refreshedPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await equipements(maison))[0].name).toBe('Chaudière principale');

    // Renommer une pièce, supprimer une pièce.
    const cave = await piece(maison, 'Cave');
    const pp = planDe(await demander(c, 'Renomme la pièce Cave en Cellier'));
    await attendre(5);
    await facade.renameRoomForAccount(c.id, maison, cave, 'Cave à vin');
    const cp = await confirmer(c, pp.plan.planId);
    expect(cp).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await sql<Json[]>`SELECT name FROM substructures WHERE id = ${cave}`)[0].name).toBe('Cave à vin');
    if (!cp.ok) throw new Error('confirmation attendue');
    expect(cp.refreshedPlan?.actions[0].preview).toBe('Renommer la pièce « Cave à vin » (Maison) en « Cellier ».');

    // Archiver un fournisseur (B change son téléphone entre-temps).
    const fid = await fournisseur(c, { name: 'Garage Martin', phone: '0102030405' });
    const pf = planDe(await demander(c, 'Archive le fournisseur Garage Martin'));
    const { updateSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    await updateSupplierForAccount({ accountId: c.id, userId: b, supplierId: fid, body: { phone: '0499887766' } });
    const cf = await confirmer(c, pf.plan.planId);
    expect(cf).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await ligneFournisseur(fid)).status).toBe('active');
    if (!cf.ok) throw new Error('confirmation attendue');
    expect(await confirmer(c, cf.refreshedPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await ligneFournisseur(fid)).status).toBe('archived');

    // Supprimer une échéance (B la renomme entre-temps).
    const item = await make.agendaItem(c as never, { title: 'Ramonage', startDate: '2031-09-01' });
    const pd = planDe(await demander(c, 'Supprime l’échéance Ramonage'));
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await attendre(5);
    await updateAgendaItem(item.id, { title: 'Ramonage annuel' }, c.id, b);
    const cd = await confirmer(c, pd.plan.planId);
    expect(cd).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect(await sql<Json[]>`SELECT id FROM agenda_items WHERE id = ${item.id}`).toHaveLength(1);
    if (!cd.ok) throw new Error('confirmation attendue');
    expect(cd.refreshedPlan?.actions[0].preview).toMatch(/^Supprimer l’échéance « Ramonage annuel »/);

    // Modifier puis supprimer un document (B change sa date entre-temps).
    const doc = await documentTitre(c, maison, 'Facture Plombier');
    const pdoc = planDe(await demander(c, 'Renomme le document Facture Plombier en Facture plomberie 2024'));
    const { updateDocumentForAccount } = await import('@/services/documents/document-write.facade');
    await attendre(5);
    expect((await updateDocumentForAccount({ userId: b, currentAccountId: c.id }, doc, { fileName: 'facture.pdf', documentDate: '2024-02-03', retainedTitle: 'Facture plombier mars' })).status).toBe(200);
    const cdoc = await confirmer(c, pdoc.plan.planId);
    expect(cdoc).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await sql<Json[]>`SELECT retained_title FROM asset_files WHERE id = ${doc}`)[0].retained_title).toBe('Facture plombier mars');

    // Rattacher un document à une opération (B corrige l'opération entre-temps).
    const clio = await voiture(c, 'Clio');
    await faire(c, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio');
    const [op] = await operations(c);
    const facture = await documentTitre(c, clio, 'Facture Norauto');
    const pl = planDe(await demander(c, 'Rattache le document Facture Norauto à l’intervention Vidange'));
    const { updateOperation } = await import('@/services/business-operations/operation-write.facade');
    expect((await updateOperation({ accountId: c.id, actor: { kind: 'USER', userId: b, channel: 'UI' } }, { operationId: op.id, declaration: 'B corrige', label: 'Vidange complète' })).status).toBe('APPLIED');
    const cl = await confirmer(c, pl.plan.planId);
    expect(cl).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect(await membres(c, op.id)).toBe(0);
    if (!cl.ok) throw new Error('confirmation attendue');
    expect(await confirmer(c, cl.refreshedPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await membres(c, op.id)).toBe(1);
    expect(facture).toBeGreaterThan(0);
  });

  it('T03 — E07 : concurrence réelle — l’écriture de B validée PENDANT la confirmation de A (anciennes et nouvelles voies)', async () => {
    const c = await compte('premium_duo');
    const maison = await logement(c, 'Maison');
    const entrelacer = async (ecrireB: (tx: any) => Promise<unknown>, planId: string) => {
      let enCours: ReturnType<typeof confirmer> | null = null;
      await sql.begin(async (tx) => {
        await ecrireB(tx);
        enCours = confirmer(c, planId);
        // La relecture de A voit encore l'ancien état (B non validé) ; son écriture attend le verrou de B.
        await attendre(400);
      });
      return enCours!;
    };

    // RENAME_EQUIPMENT (ancienne voie).
    await faire(c, 'Ajoute un équipement Chaudière dans la maison');
    const [ch] = await equipements(maison);
    const pr = planDe(await demander(c, 'Renomme l’équipement Chaudière en Chaudière A'));
    expect(await entrelacer((tx) => tx`UPDATE equipments SET name = 'Chaudière B', updated_at = now() WHERE id = ${ch.id}`, pr.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await equipements(maison))[0].name).toBe('Chaudière B');

    // ARCHIVE_EQUIPMENT.
    const pa = planDe(await demander(c, 'Retire l’équipement Chaudière B de la maison'));
    expect(await entrelacer((tx) => tx`UPDATE equipments SET status = 'EN_PANNE', updated_at = now() WHERE id = ${ch.id}`, pa.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await equipements(maison))[0].archived_at).toBeNull();

    // RENAME_ROOM.
    const cave = await piece(maison, 'Cave');
    const pp = planDe(await demander(c, 'Renomme la pièce Cave en Cellier'));
    expect(await entrelacer((tx) => tx`UPDATE substructures SET name = 'Cave B', updated_at = now() WHERE id = ${cave}`, pp.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await sql<Json[]>`SELECT name FROM substructures WHERE id = ${cave}`)[0].name).toBe('Cave B');

    // ARCHIVE_SUPPLIER.
    const fid = await fournisseur(c, { name: 'Garage Martin', phone: '0102030405' });
    const pf = planDe(await demander(c, 'Archive le fournisseur Garage Martin'));
    expect(await entrelacer((tx) => tx`UPDATE suppliers SET phone = '0499887766', updated_at = now() WHERE id = ${fid}`, pf.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await ligneFournisseur(fid)).status).toBe('active');

    // DELETE_AGENDA_ITEM.
    const item = await make.agendaItem(c as never, { title: 'Ramonage', startDate: '2031-09-01' });
    const pd = planDe(await demander(c, 'Supprime l’échéance Ramonage'));
    expect(await entrelacer((tx) => tx`UPDATE agenda_items SET description = 'par B', updated_at = now() WHERE id = ${item.id}`, pd.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect(await sql<Json[]>`SELECT id FROM agenda_items WHERE id = ${item.id}`).toHaveLength(1);

    // UPDATE_DOCUMENT / DELETE_DOCUMENT.
    const doc = await documentTitre(c, maison, 'Facture Plombier');
    const pdoc = planDe(await demander(c, 'Renomme le document Facture Plombier en Facture plomberie'));
    expect(await entrelacer((tx) => tx`UPDATE asset_files SET notes = 'par B', updated_at = now() WHERE id = ${doc}`, pdoc.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await sql<Json[]>`SELECT retained_title FROM asset_files WHERE id = ${doc}`)[0].retained_title).toBe('Facture Plombier');
    const psup = planDe(await demander(c, 'Supprime le document Facture Plombier'));
    expect(await entrelacer((tx) => tx`UPDATE asset_files SET notes = 'encore B', updated_at = now() WHERE id = ${doc}`, psup.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await sql<Json[]>`SELECT deleted_at FROM asset_files WHERE id = ${doc}`)[0].deleted_at).toBeNull();

    // Lien document ↔ opération : la version de l'opération est exigée DANS la transaction de la façade.
    const clio = await voiture(c, 'Clio');
    await faire(c, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio');
    const [op] = await operations(c);
    await documentTitre(c, clio, 'Facture Norauto');
    const pl = planDe(await demander(c, 'Rattache le document Facture Norauto à l’intervention Vidange'));
    expect(await entrelacer((tx) => tx`UPDATE business_operations SET version = version + 1, updated_at = now() WHERE id = ${op.id}`, pl.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect(await membres(c, op.id)).toBe(0);

    // Nouvelle voie (#807) toujours protégée : modification à plusieurs champs d'un équipement.
    const pe = planDe(await demander(c, 'Modifie l’équipement Chaudière B : type Chaudière gaz'));
    expect(await entrelacer((tx) => tx`UPDATE equipments SET type = 'Chaudière fioul', updated_at = now() WHERE id = ${ch.id}`, pe.plan.planId))
      .toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await equipements(maison))[0].type).toBe('Chaudière fioul');
  });

  it('T04 — E04 : IBAN minimisé, scellé, purgé (tracé, supervisé), jamais dans un flux interdit', async () => {
    const c = await compte('premium_duo');
    const b = await membre(c);
    const autre = await compte('premium_duo');
    const id = await fournisseur(c, { name: 'Plomberie Durand', phone: '0102030405' });
    const secrets = (planId: string) => sql<Json[]>`SELECT sealed_value, purged_at, purge_reason, purge_attempts, last_purge_error FROM verebona_command_plan_secrets WHERE plan_id = ${planId}`;
    const plan = async (planId: string) => (await sql<Json[]>`SELECT status, actions_payload, results_json FROM verebona_command_plans WHERE plan_id = ${planId}`)[0];
    const flux = async () => sansEspaces([
      await sql`SELECT detail_json FROM verebona_command_events WHERE account_id = ${c.id}`,
      await sql`SELECT actions_payload, results_json, summary FROM verebona_command_plans WHERE account_id = ${c.id}`,
      await sql`SELECT * FROM verebona_sensitive_purge_log WHERE account_id = ${c.id}`,
      await sql`SELECT sealed_value FROM verebona_command_plan_secrets WHERE account_id = ${c.id}`,
    ]);

    // IBAN invalide : refusé avant tout plan, rien n'est scellé.
    expect(await demander(c, 'Change l’IBAN du fournisseur Plomberie Durand en FR00PASUNIBAN')).toMatchObject({ kind: 'need_info' });
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM verebona_command_plan_secrets WHERE account_id = ${c.id}`)[0].n)).toBe(0);

    // Demande écrite en MINUSCULES : la proposition EN ATTENTE ne porte déjà plus l'IBAN — seule sa forme masquée.
    const r = planDe(await demander(c, `Change l’IBAN du fournisseur Plomberie Durand en ${IBAN_MIN}`));
    expect(r.plan.actions[0].effects).toContain('IBAN : (vide) → FR76 •••• •••• 0189');
    const enAttente = await plan(r.plan.planId);
    expect(enAttente.status).toBe('PENDING_CONFIRMATION');
    expect(sansEspaces(enAttente.actions_payload)).not.toContain(IBAN);
    expect(String(enAttente.actions_payload)).toContain('"ibanSealed":true');
    const [scelle] = await secrets(r.plan.planId);
    expect(scelle.sealed_value).toMatch(/^v1\./);
    expect(sansEspaces(scelle.sealed_value)).not.toContain(IBAN);
    expect(await flux()).not.toContain(IBAN);

    // Compte tiers : la valeur scellée est inatteignable ; la proposition aussi. Duo : B ne confirme pas pour A.
    const { unsealPlanSecret } = await import('@/services/verebona-assistant/commands/plan-secrets');
    expect(await unsealPlanSecret({ planId: r.plan.planId, accountId: autre.id, actionId: 'a1' })).toBeNull();
    expect(await confirmer(autre, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(await confirmer(c, r.plan.planId, b, true)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    // Sans la case : refus, rien d'écrit, valeur toujours scellée (la proposition reste confirmable).
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'STRONG_CONFIRMATION_REQUIRED' });
    expect((await secrets(r.plan.planId))[0].sealed_value).not.toBeNull();

    // Confirmée : l'IBAN est écrit, puis la valeur transitoire PURGÉE, purge tracée.
    const ok = await confirmer(c, r.plan.planId, c.ownerUserId, true);
    expect(ok).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(sansEspaces(ok)).not.toContain(IBAN);
    expect((await ligneFournisseur(id)).iban).toBe(IBAN);
    expect((await secrets(r.plan.planId))[0]).toMatchObject({ sealed_value: null, purge_reason: 'EXECUTED', purge_attempts: 1, last_purge_error: null });
    expect(await sql<Json[]>`SELECT outcome FROM verebona_sensitive_purge_log WHERE account_id = ${c.id} AND target_id = ${r.plan.planId}`).toEqual([{ outcome: 'PURGED' }]);
    // Purge idempotente : rejouée, rien à faire.
    const { purgePlanSecrets, sweepSensitiveData } = await import('@/services/verebona-assistant/commands/plan-secrets');
    expect(await purgePlanSecrets({ planId: r.plan.planId, accountId: c.id, reason: 'REJEU' })).toEqual({ ok: true, purged: 0 });

    // Annulée, puis expirée : purgées aussi.
    const an = planDe(await demander(c, `Change l’IBAN du fournisseur Plomberie Durand en ${IBAN_2}`));
    const { cancelCommandPlan, expirePendingPlans } = await import('@/services/verebona-assistant/commands/plan.service');
    expect(await cancelCommandPlan({ planId: an.plan.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: true });
    expect((await secrets(an.plan.planId))[0]).toMatchObject({ sealed_value: null, purge_reason: 'CANCELLED' });
    const ex = planDe(await demander(c, `Change l’IBAN du fournisseur Plomberie Durand en ${IBAN_2}`));
    await sql`UPDATE verebona_command_plans SET expires_at = now() - interval '1 minute' WHERE plan_id = ${ex.plan.planId}`;
    await expirePendingPlans({ accountId: c.id });
    expect((await secrets(ex.plan.planId))[0]).toMatchObject({ sealed_value: null, purge_reason: 'EXPIRED' });

    // Valeur purgée AVANT la confirmation (proposition restée ouverte au-delà de sa rétention) : refus, rien d'écrit.
    const pg = planDe(await demander(c, `Change l’IBAN du fournisseur Plomberie Durand en ${IBAN_2}`));
    await sql`UPDATE verebona_command_plan_secrets SET sealed_value = NULL, purged_at = now(), purge_reason = 'TEST' WHERE plan_id = ${pg.plan.planId}`;
    expect(await confirmer(c, pg.plan.planId, c.ownerUserId, true)).toMatchObject({ ok: true, status: 'FAILED', results: [{ status: 'REFUSED', message: 'La nouvelle coordonnée bancaire de cette proposition n’est plus disponible : rien n’a été modifié. Refaites votre demande.' }] });
    expect((await ligneFournisseur(id)).iban).toBe(IBAN);

    // PANNE pendant la clôture : la purge échoue (contrainte posée pour le test) → l'écriture reste faite, l'échec est
    // TRACÉ (tentative, code, journal FAILED), la valeur reste chiffrée, le balayage la compte et le SIGNALE.
    const pp = planDe(await demander(c, `Change l’IBAN du fournisseur Plomberie Durand en ${IBAN_2}`));
    await sql.unsafe(`ALTER TABLE verebona_command_plan_secrets ADD CONSTRAINT c843_panne_purge CHECK (sealed_value IS NOT NULL OR plan_id <> '${pp.plan.planId}')`);
    expect(await confirmer(c, pp.plan.planId, c.ownerUserId, true)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await ligneFournisseur(id)).iban).toBe(IBAN_2);
    const [echec] = await secrets(pp.plan.planId);
    expect(echec.sealed_value).not.toBeNull();
    expect(echec).toMatchObject({ purge_attempts: 1, last_purge_error: '23514' });
    expect(await sql<Json[]>`SELECT outcome, detail_json->>'code' AS code FROM verebona_sensitive_purge_log WHERE target_id = ${pp.plan.planId}`).toEqual([{ outcome: 'FAILED', code: '23514' }]);
    const balaye = await sweepSensitiveData();
    expect(balaye).toMatchObject({ purgeOk: false, backlog: 1 });
    expect(await sql<Json[]>`SELECT outcome FROM verebona_sensitive_purge_log WHERE scope = 'SWEEP' ORDER BY id DESC LIMIT 1`).toEqual([{ outcome: 'BACKLOG' }]);
    // Panne levée : le balayage suivant purge, plus aucun reste.
    await sql.unsafe('ALTER TABLE verebona_command_plan_secrets DROP CONSTRAINT c843_panne_purge');
    expect(await sweepSensitiveData()).toMatchObject({ purgeOk: true, backlog: 0 });
    expect((await secrets(pp.plan.planId))[0]).toMatchObject({ sealed_value: null, purge_reason: 'SWEEP' });
    expect(await flux()).not.toContain(IBAN);
    expect(await flux()).not.toContain(IBAN_2);

    // Historique des fils : un IBAN tapé avant #843 est masqué, le message garde sa place et le reste du texte.
    const [conv] = await sql<Json[]>`INSERT INTO verebona_conversations (account_id, user_id, status, locale, expires_at) VALUES (${c.id}, ${c.ownerUserId}, 'active', 'fr-FR', now() + interval '30 days') RETURNING id`;
    const [msg] = await sql<Json[]>`INSERT INTO verebona_messages (conversation_id, account_id, author_user_id, role, status, content, expires_at)
      VALUES (${conv.id}, ${c.id}, ${c.ownerUserId}, 'user', 'ready', ${`Mon IBAN est ${IBAN_MIN}, merci`}, now() + interval '30 days') RETURNING id`;
    expect(await sweepSensitiveData()).toMatchObject({ messagesMasked: 1 });
    expect((await sql<Json[]>`SELECT id, content FROM verebona_messages WHERE id = ${msg.id}`)[0]).toEqual({ id: msg.id, content: 'Mon IBAN est FR76 •••• •••• 0189, merci' });
    expect(await sweepSensitiveData()).toMatchObject({ messagesMasked: 0 });

    // Diagnostic : la table des valeurs transitoires n'est JAMAIS exportée (transversale, aucune ligne).
    const { DIAG_TABLE_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
    expect(DIAG_TABLE_COVERAGE.verebona_command_plan_secrets).toMatchObject({ filter: 'FALSE' });
  });

  it('T05 — E09 : déplacer un document de A vers B — atomique : B refusé ou en panne ⇒ A conservé ; liens tiers intacts', async () => {
    const c = await compte('premium_duo');
    const b = await membre(c);
    const clio = await voiture(c, 'Clio');
    await faire(c, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio');
    await faire(c, 'Déclare une intervention « Freins » réalisée le 20 mai 2025 pour la Clio');
    const [vidange, freins] = await operations(c);
    const doc = await documentTitre(c, clio, 'Facture Norauto');
    const rdv = await make.agendaItem(c as never, { title: 'Révision', startDate: '2025-03-12', assetIds: [clio] });
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${rdv.id}, ${doc})`;
    expect((await faire(c, 'Rattache le document Facture Norauto à l’intervention Vidange')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const phrase = 'Déplace le document Facture Norauto de l’intervention Vidange vers l’intervention Freins';
    const etat = async () => [await membres(c, vidange.id), await membres(c, freins.id)];

    // Aperçu : deux gestes, faits ensemble.
    const p1 = planDe(await demander(c, phrase));
    expect(p1.plan.actions.map((a) => a.command)).toEqual(['UNLINK_DOCUMENT_REFERENCE_EVENT', 'LINK_DOCUMENT_REFERENCE_EVENT']);
    expect(p1.plan.actions[1].effects.join(' ')).toMatch(/Si le rattachement à cette opération échoue, le retrait est annulé/);

    // PANNE pendant le rattachement à B (après le retrait de A, même transaction) : A conservé, rien d'écrit.
    h.panneRattachement = true;
    const c1 = await confirmer(c, p1.plan.planId);
    h.panneRattachement = false;
    expect(c1).toMatchObject({ ok: true, status: 'FAILED', results: [{ status: 'FAILED' }, { status: 'SKIPPED_DEPENDENCY' }] });
    expect(JSON.stringify(c1)).toMatch(/reste rattaché à l’opération « Intervention — Vidange » : le déplacement n’a pas eu lieu/);
    expect(await etat()).toEqual([1, 0]);

    // B SUPPRIMÉE entre l'aperçu et la confirmation : refus, A conservé.
    const p2 = planDe(await demander(c, phrase));
    const { invalidateOperation, updateOperation } = await import('@/services/business-operations/operation-write.facade');
    expect((await invalidateOperation({ accountId: c.id, actor: { kind: 'USER', userId: b, channel: 'UI' } }, { operationId: freins.id })).status).toBe('APPLIED');
    const c2 = await confirmer(c, p2.plan.planId);
    expect(c2).toMatchObject({ ok: true, status: expect.stringMatching(/FAILED|REFUSED/) });
    expect(await etat()).toEqual([1, 0]);
    const { restoreOperation } = await import('@/services/business-operations/operation-write.facade');
    expect((await restoreOperation({ accountId: c.id, actor: { kind: 'USER', userId: b, channel: 'UI' } }, { operationId: freins.id })).status).toBe('APPLIED');

    // Duo : B corrige l'opération de destination entre l'aperçu et la confirmation → conflit, A conservé, reproposé.
    const p3 = planDe(await demander(c, phrase));
    expect((await updateOperation({ accountId: c.id, actor: { kind: 'USER', userId: b, channel: 'UI' } }, { operationId: freins.id, declaration: 'B', label: 'Freins avant' })).status).toBe('APPLIED');
    const c3 = await confirmer(c, p3.plan.planId);
    expect(c3).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }, { status: 'SKIPPED_DEPENDENCY' }] });
    expect(await etat()).toEqual([1, 0]);

    // Réussite : retiré de A, rattaché à B, en une écriture ; un seul fichier ; liens tiers (bien, Agenda) intacts.
    const p4 = planDe(await demander(c, 'Déplace le document Facture Norauto de l’intervention Vidange vers l’intervention Freins avant'));
    expect(await confirmer(c, p4.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await etat()).toEqual([0, 1]);
    expect(await sql<Json[]>`SELECT id::int AS id, asset_id, deleted_at FROM asset_files WHERE account_id = ${c.id}`).toEqual([{ id: doc, asset_id: clio, deleted_at: null }]);
    expect(await sql<Json[]>`SELECT asset_file_id::int AS f FROM agenda_file_links WHERE agenda_item_id = ${rdv.id}`).toEqual([{ f: doc }]);
    // Rejeu : rien n'est refait (prise unique du plan).
    expect(await confirmer(c, p4.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await etat()).toEqual([0, 1]);
    // « Ajouter à B » (rattacher seul) CONSERVE A : le document est alors dans les deux opérations.
    expect((await faire(c, 'Rattache le document Facture Norauto à l’intervention Vidange')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await etat()).toEqual([1, 1]);
  });
});
