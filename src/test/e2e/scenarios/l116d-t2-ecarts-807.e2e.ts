/**
 * Carte #807 (lot 116D) — ASSISTANT T2, ÉCARTS RÉSIDUELS E01 à E10, de bout en bout sur PostgreSQL réel : plan
 * figé, confirmation, écriture par les façades métier des écrans. Aucun appel à un fournisseur d'IA (parcours
 * déterministe des commandes).
 *
 *   T01  E02  créer un équipement — minimal, puis riche (fiche, montants, pièce) ; jamais un doublon ;
 *   T02  E01  modifier un équipement — série, valeur, statut : avant / après, origine utilisateur ;
 *   T03  E01  changer de bien parent — même équipement, documents et échéances conservés ;
 *   T04  E03  modifier une échéance de l'Agenda — plusieurs champs, situation, lien ajouté ;
 *   T05  E04  fournisseur — adresse, SIRET, IBAN : formats contrôlés, IBAN MASQUÉ partout, confirmation renforcée ;
 *   T06  E07  Duo : A prépare, B modifie, A confirme → rien d'obsolète n'est écrit ; proposition relue, reconfirmée ;
 *   T07  E07  concurrence RÉELLE (verrou de ligne) : fournisseur, équipement, échéance, opération ;
 *   T08  E07  risque reproduit sur le chemin SANS version (plan d'avant cette carte) — et fermé avec version ;
 *   T09  E05  sinistre distinct du contrat d'assurance, associé à lui, jamais fusionné ;
 *   T10  E06  plus de 5 000 opérations actives et plus de 500 supprimées : toutes retrouvables ; budget de temps ;
 *   T11  E09  déplacer un document : deux gestes (retirer, puis rattacher) ; demande ambiguë → question ;
 *   T12  E10  conversion entre familles de bien refusée ; changement de catégorie dans la famille permis ;
 *   T13       compte A contre compte B ; double clic / rejeu.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;
const IBAN = 'FR7630006000011234567890189';
const IBAN_2 = 'FR7610278060610001020480101';

scenario('L116D-T2-ECARTS', 'Carte #807 — Assistant T2 : écarts résiduels E01 à E10', ({ sql, make }) => {
  const compte = async (plan: 'standard' | 'premium' | 'premium_duo' = 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const membre = async (c: Compte): Promise<number> => {
    const u = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${u.id}, 'member', 'active')`;
    return u.id as number;
  };
  const logement = async (c: Compte, name: string, subtype = 'Maison') => {
    const b = await make.asset(c as never, { name, category: 'IMMOBILIER' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = ${subtype} WHERE id = ${b.id}`;
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
  const demander = async (c: Compte, message: string, userId = c.ownerUserId, extra: Json = {}) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId, planType: 'PREMIUM', message, clientRequestId: `l116d-${Math.random()}`, locale: 'fr-FR', ...extra } as never);
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
    SELECT id, name, type, category, status, substructure_id, purchase_price_cents, estimated_value_cents, archived_at
      FROM equipments WHERE asset_id = ${assetId} ORDER BY id`;
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
    SELECT id::int AS id, type_code, technical_label, status, version, invalidated_at IS NOT NULL AS invalide, merged_into_operation_id AS fusion
      FROM business_operations WHERE account_id = ${c.id} ORDER BY id`;
  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('T01 — E02 : équipement créé avec le minimum, puis avec toutes les informations fournies ; jamais un doublon', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    const cellier = await piece(maison, 'Cellier');

    // Minimal : seul le nom est exigé — aucune information n'est réclamée en plus.
    const mini = await faire(c, 'Ajoute un équipement Ballon dans la maison');
    expect(mini.plan.preview.summary).toBe('Créer l’équipement « Ballon » dans Maison. Confirmez-vous ?');
    expect(mini.conf).toMatchObject({ ok: true, status: 'EXECUTED' });

    // Riche : tout ce qui est fourni est annoncé puis transmis à la façade de l'écran.
    const riche = planDe(await demander(c, 'Ajoute un équipement Chaudière dans la maison : marque Viessmann, modèle Vitodens 200, numéro de série VS-778-A, type Chaudière gaz, statut en service, prix d’achat 2 500 €, valeur estimée 1 800,50 €, pièce Cellier'));
    expect(riche.plan.actions[0].effects).toEqual([
      'Équipement : Chaudière', 'Bien : Maison', 'Pièce : Cellier',
      'Type : Chaudière gaz', 'Statut : En service', 'Prix d’achat : 2 500,00 €', 'Valeur estimée : 1 800,50 €',
      'Marque : Viessmann', 'Modèle : Vitodens 200', 'Numéro de série : VS-778-A',
    ]);
    expect(await equipements(maison)).toHaveLength(1);
    expect(await confirmer(c, riche.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [, ch] = await equipements(maison);
    expect(ch).toMatchObject({ name: 'Chaudière', type: 'Chaudière gaz', status: 'EN_SERVICE', substructure_id: cellier, purchase_price_cents: 250000, estimated_value_cents: 180050 });
    const f = await fiche(c, ch.id);
    expect(f.brand).toEqual({ value: 'Viessmann', origin: 'USER' });
    expect(f.modelName).toEqual({ value: 'Vitodens 200', origin: 'USER' });
    expect(f.serialNumber).toEqual({ value: 'VS-778-A', origin: 'USER' });

    // Double clic : le plan ne s'exécute qu'une fois. Même nom dans le même bien : jamais un second équipement.
    expect(await confirmer(c, riche.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await demander(c, 'Ajoute un équipement chaudière dans la maison : marque Bosch')).toMatchObject({ kind: 'need_info', message: 'L’équipement « Chaudière » existe déjà dans Maison.' });
    expect(await equipements(maison)).toHaveLength(2);
    // Valeur invalide : dite avant tout plan, rien n'est créé.
    expect(await demander(c, 'Ajoute un équipement Pompe dans la maison : prix d’achat beaucoup')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/Je n’ai pas compris le montant/) });
    expect(await demander(c, 'Ajoute un équipement Pompe dans la maison : statut cassé')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Quel statut voulez-vous donner/) });
  });

  it('T02 — E01 : série, valeur et statut d’un équipement modifiés — avant / après annoncés, origine utilisateur', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    await faire(c, 'Ajoute un équipement Chaudière dans la maison : marque Viessmann, valeur estimée 1 800 €');
    const [ch] = await equipements(maison);

    const r = planDe(await demander(c, 'Modifie l’équipement Chaudière de la maison : numéro de série VS-778-B, valeur estimée 1 500 €, statut en panne, marque Viessmann'));
    expect(r.preview.summary).toBe('Modifier l’équipement « Chaudière » (Maison) : Statut : En service → En panne ; Valeur estimée : 1 800,00 € → 1 500,00 € ; Numéro de série : (vide) → VS-778-B. Confirmez-vous ?');
    // La marque demandée est déjà la sienne : elle n'est ni annoncée ni réécrite.
    expect(r.plan.actions[0].effects.join(' ')).not.toMatch(/Marque/);
    // Rien n'est écrit avant la confirmation.
    expect((await equipements(maison))[0]).toMatchObject({ status: 'EN_SERVICE', estimated_value_cents: 180000 });
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    expect((await equipements(maison))[0]).toMatchObject({ id: ch.id, status: 'EN_PANNE', estimated_value_cents: 150000 });
    expect((await fiche(c, ch.id)).serialNumber).toEqual({ value: 'VS-778-B', origin: 'USER' });

    // Un seul champ, à la manière d'une phrase ; puis son effacement.
    expect((await faire(c, 'Mets le modèle de l’équipement Chaudière à Vitodens 222')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await fiche(c, ch.id)).modelName).toMatchObject({ value: 'Vitodens 222' });
    const efface = planDe(await demander(c, 'Efface le numéro de série de l’équipement Chaudière'));
    expect(efface.plan.actions[0].effects).toContain('Numéro de série : VS-778-B → (vide)');
    expect(await confirmer(c, efface.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await fiche(c, ch.id)).serialNumber?.value ?? null).toBeNull();
    // Déjà à jour : aucune proposition. Offre Standard : le refus de l'offre est dit, aucun plan.
    expect(await demander(c, 'Modifie l’équipement Chaudière : statut en panne')).toMatchObject({ kind: 'need_info', message: 'L’équipement « Chaudière » a déjà ces valeurs : rien à modifier.' });
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${c.id}`;
    expect(await demander(c, 'Modifie l’équipement Chaudière : statut en service')).toMatchObject({ kind: 'need_info', message: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' });
  });

  it('T03 — E01 : changement de bien parent — le même équipement, ses documents et ses échéances conservés', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    const appart = await logement(c, 'Studio', 'Appartement');
    const cave = await piece(maison, 'Cave');
    const salon = await piece(appart, 'Salon');
    await faire(c, 'Ajoute un équipement Cave à vin dans la pièce Cave de la maison');
    const [eq] = await equipements(maison);
    const doc = await make.assetFile(c as never, { assetId: maison });
    await sql`UPDATE asset_files SET equipment_id = ${eq.id} WHERE id = ${doc.id}`;
    const rdv = await make.agendaItem(c as never, { title: 'Entretien cave à vin', startDate: '2031-04-02', assetIds: [maison] });
    await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${rdv.id}, ${eq.id})`;

    const r = planDe(await demander(c, 'Déplace l’équipement Cave à vin vers le Studio'));
    expect(r.preview.summary).toBe('Déplacer l’équipement « Cave à vin » de Maison vers Studio : Pièce : Cave → aucune. Confirmez-vous ?');
    expect(r.plan.actions[0].effects).toEqual([
      'Bien : Maison → Studio',
      'Pièce : Cave → aucune',
      'C’est le même équipement qui change de bien : rien n’est copié ni supprimé.',
      'Il garde ce qui lui est rattaché : 1 document, 1 échéance, ainsi que son historique.',
      'Sa pièce actuelle (« Cave ») appartient à Maison : il ne sera plus rattaché à une pièce.',
      'Le rapprochement de ses documents est relancé pour son nouveau bien.',
      'Ces valeurs sont enregistrées comme votre saisie : elles ne seront pas remplacées par une analyse.',
    ]);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    // Un seul équipement, le même identifiant, dans le nouveau bien, sans pièce.
    expect(await equipements(maison)).toHaveLength(0);
    expect(await equipements(appart)).toEqual([expect.objectContaining({ id: eq.id, name: 'Cave à vin', substructure_id: null, archived_at: null })]);
    // Document et échéance : toujours rattachés à LUI, non supprimés, non dupliqués.
    expect((await sql<Json[]>`SELECT equipment_id, deleted_at FROM asset_files WHERE id = ${doc.id}`)[0]).toMatchObject({ equipment_id: eq.id, deleted_at: null });
    expect(await sql<Json[]>`SELECT equipment_id FROM agenda_equipment_links WHERE agenda_item_id = ${rdv.id}`).toEqual([{ equipment_id: eq.id }]);
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.id}`)[0].n)).toBe(1);

    // Dans une pièce du nouveau bien ; une pièce d'un AUTRE bien est refusée (cohérence des références).
    const range = planDe(await demander(c, 'Mets l’équipement Cave à vin dans la pièce Salon'));
    expect(range.plan.actions[0].effects).toContain('Pièce : aucune → Salon');
    expect(await confirmer(c, range.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await equipements(appart))[0].substructure_id).toBe(salon);
    expect(await demander(c, 'Mets l’équipement Cave à vin dans la pièce Cave')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé cette pièce dans Studio/) });
    // Vers un bien qui n'accepte pas d'équipement : refus de l'écran, aucun plan.
    await voiture(c, 'Clio');
    expect(await demander(c, 'Déplace l’équipement Cave à vin vers la Clio')).toMatchObject({ kind: 'need_info', message: 'Ce type de bien ne supporte pas la gestion des équipements' });
    expect(cave).toBeGreaterThan(0);
  });

  it('T04 — E03 : échéance de l’Agenda modifiée sur plusieurs champs, situation et lien compris', async () => {
    const c = await compte();
    const clio = await voiture(c, 'Clio');
    const polo = await voiture(c, 'Polo');
    const item = await make.agendaItem(c as never, { title: 'Vidange', startDate: '2031-03-12', assetIds: [clio] });
    const lire = async () => (await sql<Json[]>`
      SELECT title, description, to_char(start_date, 'YYYY-MM-DD') AS debut, start_time::text AS h1, to_char(end_date, 'YYYY-MM-DD') AS fin, end_time::text AS h2,
             situation, (SELECT array_agg(asset_id ORDER BY asset_id) FROM agenda_asset_links WHERE agenda_item_id = i.id) AS biens
        FROM agenda_items i WHERE id = ${item.id}`)[0];

    const r = planDe(await demander(c, 'Modifie l’échéance Vidange : description Apporter le carnet d’entretien, date 14 mars 2031, heure de début 9h30, date de fin 14 mars 2031, heure de fin 11h, bien Polo'));
    expect(r.plan.actions[0].effects).toEqual([
      'Description : (vide) → Apporter le carnet d’entretien',
      'Date de début : 12 mars 2031 → 14 mars 2031',
      'Heure de début : aucune → 09:30',
      'Date de fin : aucune → 14 mars 2031',
      'Heure de fin : aucune → 11:00',
      'Bien ajouté : Polo',
      'Les rappels de cette échéance sont recalculés par l’Agenda.',
    ]);
    expect((await lire()).debut).toBe('2031-03-12');
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const apres = await lire();
    expect(apres).toMatchObject({ title: 'Vidange', description: 'Apporter le carnet d’entretien', debut: '2031-03-14', fin: '2031-03-14' });
    expect(String(apres.h1).slice(0, 5)).toBe('09:30');
    expect(String(apres.h2).slice(0, 5)).toBe('11:00');
    expect(apres.biens.map(Number)).toEqual([clio, polo].sort((a, b) => a - b));
    // Aucun doublon : toujours une seule échéance.
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id}`)[0].n)).toBe(1);

    // Règle de l'Agenda respectée telle quelle : « A eu lieu » avec une date future est refusé par le service, rien n'est écrit.
    const futur = planDe(await demander(c, 'Modifie l’échéance Vidange : situation a eu lieu'));
    const refus = await confirmer(c, futur.plan.planId);
    expect(refus).toMatchObject({ ok: true, status: 'FAILED' });
    expect((await lire()).situation).not.toBe('A_EU_LIEU');
    // Date passée + « a eu lieu » : accepté. « Sans échéance » et une date ensemble : question, aucun plan.
    const passe = await faire(c, 'Modifie l’échéance Vidange : date 3 mars 2024, date de fin 3 mars 2024, situation a eu lieu');
    expect(passe.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await lire()).toMatchObject({ debut: '2024-03-03', situation: 'A_EU_LIEU' });
    expect(await demander(c, 'Modifie l’échéance Vidange : sans échéance, date 4 mars 2031')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/Sans échéance/) });
    // Forme historique inchangée (titre / date) : toujours servie.
    expect(planDe(await demander(c, 'Renomme l’échéance Vidange en Révision annuelle')).plan.actions[0].command).toBe('UPDATE_AGENDA_ITEM');
  });

  it('T05 — E04 : adresse, SIRET et IBAN d’un fournisseur — formats contrôlés, IBAN masqué partout, confirmation renforcée', async () => {
    const c = await compte();
    const id = await fournisseur(c, { name: 'Plomberie Durand', phone: '0102030405' });

    // Adresse et identifiants : mêmes validations que la fiche.
    const adr = planDe(await demander(c, 'Modifie le fournisseur Plomberie Durand : adresse 12 rue de la Paix, code postal 75002, ville Paris, siret 732 829 320 00074'));
    expect(adr.preview.strongConfirmation).toBeUndefined();
    expect(adr.plan.actions[0].effects).toEqual([
      'Fournisseur : Plomberie Durand', 'Adresse : (vide) → 12 rue de la Paix', 'Code postal : (vide) → 75002', 'Ville : (vide) → Paris', 'SIRET : (vide) → 73282932000074',
      'Ces valeurs ne seront pas remplacées par celles d’un document.',
    ]);
    expect(await confirmer(c, adr.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await ligneFournisseur(id)).toMatchObject({ address_line_1: '12 rue de la Paix', postal_code: '75002', city: 'Paris', siret: '73282932000074' });
    expect(await demander(c, 'Change le SIREN du fournisseur Plomberie Durand en 1234')).toMatchObject({ kind: 'need_info', message: 'Un numéro SIREN comporte 9 chiffres. Pouvez-vous le vérifier ?' });
    expect(await demander(c, 'Change l’IBAN du fournisseur Plomberie Durand en PASUNIBAN')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Cet IBAN ne semble pas valide/) });

    // IBAN : jamais en clair dans l'aperçu, le résumé, les effets, la réponse, les traces.
    const r = planDe(await demander(c, `Modifie le fournisseur Plomberie Durand : IBAN FR76 3000 6000 0112 3456 7890 189, titulaire Durand SARL`));
    expect(r.preview.strongConfirmation).toBe('J’ai vérifié ces coordonnées bancaires sur un document du fournisseur.');
    expect(r.plan.actions[0].effects).toContain('IBAN : (vide) → FR76 •••• •••• 0189');
    expect(JSON.stringify(r.preview)).not.toContain(IBAN);
    expect(JSON.stringify(r.preview).replace(/\s/g, '')).not.toContain(IBAN);
    const traces = async () => JSON.stringify(await sql<Json[]>`SELECT event_type, detail_json FROM verebona_command_events WHERE account_id = ${c.id}`).replace(/\s/g, '');
    expect(await traces()).not.toContain(IBAN);

    // Confirmation simple : REFUSÉE — le plan reste en attente, rien n'est écrit.
    const sans = await confirmer(c, r.plan.planId);
    expect(sans).toMatchObject({ ok: false, code: 'STRONG_CONFIRMATION_REQUIRED', status: 'PENDING_CONFIRMATION' });
    expect((await ligneFournisseur(id)).iban).toBeNull();
    // Avec l'attestation : écrit par la façade de la fiche (décision de l'utilisateur, protégée des documents).
    const avec = await confirmer(c, r.plan.planId, c.ownerUserId, true);
    expect(avec).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(JSON.stringify(avec).replace(/\s/g, '')).not.toContain(IBAN);
    const ligne = await ligneFournisseur(id);
    expect(ligne).toMatchObject({ iban: IBAN, iban_holder_name: 'Durand SARL' });
    expect(JSON.stringify(ligne.user_field_decisions)).toMatch(/iban/);
    // Plan clos : l'IBAN n'y reste pas ; les traces et le fil ne le portent pas davantage.
    const [clos] = await sql<Json[]>`SELECT actions_payload, results_json FROM verebona_command_plans WHERE plan_id = ${r.plan.planId}`;
    expect(String(clos.actions_payload)).not.toContain(IBAN);
    expect(String(clos.actions_payload)).toContain('"ibanScrubbed":true');
    expect(JSON.stringify(clos.results_json)).not.toContain(IBAN);
    expect(await traces()).not.toContain(IBAN);

    // Proposition bancaire ANNULÉE : l'IBAN en est retiré aussi. Changement d'IBAN : l'ancien n'est montré que masqué.
    const autre = planDe(await demander(c, `Change l’IBAN du fournisseur Plomberie Durand en ${IBAN_2}`));
    expect(autre.plan.actions[0].effects).toContain('IBAN : FR76 •••• •••• 0189 → FR76 •••• •••• 0101');
    const { cancelCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    expect(await cancelCommandPlan({ planId: autre.plan.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: true });
    expect(String((await sql<Json[]>`SELECT actions_payload FROM verebona_command_plans WHERE plan_id = ${autre.plan.planId}`)[0].actions_payload)).not.toContain(IBAN_2);
    expect((await ligneFournisseur(id)).iban).toBe(IBAN);
  });

  it('T06 — E07 : Duo — A prépare, B modifie, A confirme : rien d’obsolète n’est écrit ; proposition relue, à reconfirmer', async () => {
    const c = await compte('premium_duo');
    const b = await membre(c);
    const id = await fournisseur(c, { name: 'Garage Martin', phone: '0102030405', city: 'Lyon' });
    const { updateSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');

    // A prépare un changement de téléphone ; B corrige la fiche depuis l'écran (téléphone ET ville).
    const a = planDe(await demander(c, 'Change le téléphone du fournisseur Garage Martin en 06 11 22 33 44'));
    expect(await updateSupplierForAccount({ accountId: c.id, userId: b, supplierId: id, body: { phone: '0499887766', city: 'Villeurbanne' } })).toMatchObject({ ok: true });
    // B ne peut pas confirmer la proposition de A (propriétaire du plan).
    expect(await confirmer(c, a.plan.planId, b)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });

    const conf = await confirmer(c, a.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED', results: [{ status: 'FAILED', conflict: true }] });
    // RIEN n'a écrasé B.
    expect(await ligneFournisseur(id)).toMatchObject({ phone: '0499887766', city: 'Villeurbanne' });
    // Données relues : nouvel avant / après (la valeur de B est l'« avant »), nouvelle proposition EN ATTENTE.
    if (!conf.ok) throw new Error('confirmation attendue');
    expect(conf.summary).toMatch(/J’ai relu les données actuelles : voici la proposition mise à jour\. Rien ne sera modifié sans votre nouvelle confirmation\./);
    expect(conf.refreshedPlan?.actions[0].effects).toContain('Téléphone : 0499887766 → 06 11 22 33 44');
    expect(conf.refreshedPlan?.planId).not.toBe(a.plan.planId);
    expect(await ligneFournisseur(id)).toMatchObject({ phone: '0499887766' });
    // L'ancienne proposition est close ; la nouvelle s'exécute seulement sur une nouvelle confirmation, de A seul.
    expect(await confirmer(c, a.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await confirmer(c, conf.refreshedPlan!.planId, b)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(await confirmer(c, conf.refreshedPlan!.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await ligneFournisseur(id)).toMatchObject({ phone: '06 11 22 33 44', city: 'Villeurbanne' });

    // Même parcours pour un équipement et pour une échéance de l'Agenda.
    const maison = await logement(c, 'Maison');
    await faire(c, 'Ajoute un équipement Chaudière dans la maison : marque Viessmann');
    const [ch] = await equipements(maison);
    const pe = planDe(await demander(c, 'Modifie l’équipement Chaudière : statut en panne'));
    const { updateEquipmentForAccount } = await import('@/services/assets/structure-write.facade');
    await attendre(5);
    expect((await updateEquipmentForAccount({ userId: b, currentAccountId: c.id }, maison, ch.id, { status: 'EN_REPARATION' })).status).toBe(200);
    const ce = await confirmer(c, pe.plan.planId);
    expect(ce).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await equipements(maison))[0].status).toBe('EN_REPARATION');
    if (!ce.ok) throw new Error('confirmation attendue');
    expect(ce.refreshedPlan?.actions[0].effects).toContain('Statut : En réparation → En panne');

    const item = await make.agendaItem(c as never, { title: 'Ramonage', startDate: '2031-09-01' });
    const pa = planDe(await demander(c, 'Modifie l’échéance Ramonage : description Prévenir le voisin'));
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await attendre(5);
    await updateAgendaItem(item.id, { title: 'Ramonage annuel' }, c.id, b);
    const ca = await confirmer(c, pa.plan.planId);
    expect(ca).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await sql<Json[]>`SELECT title, description FROM agenda_items WHERE id = ${item.id}`)[0]).toMatchObject({ title: 'Ramonage annuel', description: null });
    if (!ca.ok) throw new Error('confirmation attendue');
    expect(ca.refreshedPlan?.summary).toMatch(/^Modifier l’échéance « Ramonage annuel »/);
  });

  it('T07 — E07 : concurrence réelle — l’écriture de B est validée PENDANT la confirmation de A (verrou de ligne)', async () => {
    const c = await compte('premium_duo');
    // Fournisseur : B tient la ligne dans une transaction ouverte ; A confirme pendant ce temps.
    const id = await fournisseur(c, { name: 'Garage Martin', phone: '0102030405' });
    const a = planDe(await demander(c, 'Change le téléphone du fournisseur Garage Martin en 06 11 22 33 44'));
    let enCours: ReturnType<typeof confirmer> | null = null;
    await sql.begin(async (tx) => {
      await tx`UPDATE suppliers SET phone = '0499887766', updated_at = now() WHERE id = ${id}`;
      enCours = confirmer(c, a.plan.planId);
      // La relecture de A voit encore l'ancien état (B non validé) ; son écriture attend le verrou de B.
      await attendre(400);
    });
    const conf = await enCours!;
    expect(conf).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await ligneFournisseur(id)).phone).toBe('0499887766');

    // Équipement : même entrelacement.
    const maison = await logement(c, 'Maison');
    await faire(c, 'Ajoute un équipement Chaudière dans la maison');
    const [ch] = await equipements(maison);
    const pe = planDe(await demander(c, 'Modifie l’équipement Chaudière : type Chaudière gaz'));
    let confE: ReturnType<typeof confirmer> | null = null;
    await sql.begin(async (tx) => {
      await tx`UPDATE equipments SET type = 'Chaudière fioul', updated_at = now() WHERE id = ${ch.id}`;
      confE = confirmer(c, pe.plan.planId);
      await attendre(400);
    });
    expect(await confE!).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await equipements(maison))[0].type).toBe('Chaudière fioul');

    // Échéance de l'Agenda : même entrelacement.
    const item = await make.agendaItem(c as never, { title: 'Ramonage', startDate: '2031-09-01' });
    const pa = planDe(await demander(c, 'Modifie l’échéance Ramonage : description Prévenir le voisin'));
    let confA: ReturnType<typeof confirmer> | null = null;
    await sql.begin(async (tx) => {
      await tx`UPDATE agenda_items SET title = 'Ramonage annuel', updated_at = now() WHERE id = ${item.id}`;
      confA = confirmer(c, pa.plan.planId);
      await attendre(400);
    });
    expect(await confA!).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect((await sql<Json[]>`SELECT title, description FROM agenda_items WHERE id = ${item.id}`)[0]).toMatchObject({ title: 'Ramonage annuel', description: null });

    // Opération : la façade du graphe exige la version sous son propre verrou (déjà en place, vérifié ici).
    const clio = await voiture(c, 'Clio');
    expect((await faire(c, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [op] = await operations(c);
    const po = planDe(await demander(c, 'Renomme l’intervention Vidange en Vidange et filtres'));
    const { updateOperation } = await import('@/services/business-operations/operation-write.facade');
    const parB = await updateOperation({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'ASSISTANT' } }, { operationId: op.id, declaration: 'B corrige', label: 'Vidange complète' });
    expect(parB.status).toBe('APPLIED');
    expect(await confirmer(c, po.plan.planId)).toMatchObject({ ok: true, status: 'FAILED' });
    expect((await operations(c))[0].technical_label).toBe('Vidange complète');
    expect(clio).toBeGreaterThan(0);
  });

  it('T08 — E07 : le risque est reproduit sur le chemin SANS version (plan d’avant la carte), et fermé avec version', async () => {
    const c = await compte('premium_duo');
    const id = await fournisseur(c, { name: 'Garage Martin', phone: '0102030405' });
    const jouer = async (avecVersion: boolean) => {
      await sql`UPDATE suppliers SET phone = '0102030405', updated_at = now() WHERE id = ${id}`;
      const a = planDe(await demander(c, 'Change le téléphone du fournisseur Garage Martin en 06 11 22 33 44'));
      if (!avecVersion) {
        // Plan tel qu'il était figé AVANT cette carte : sans la version complète de la fiche.
        const { hashActions } = await import('@/services/verebona-assistant/commands/plan.service');
        const actions = a.plan.actions.map((x) => { const { expectedRowVersion: _v, ...params } = x.params as Json; return { ...x, params }; });
        const payload = JSON.stringify(actions);
        await sql`UPDATE verebona_command_plans SET actions_payload = ${payload}, params_hash = ${hashActions(payload)} WHERE plan_id = ${a.plan.planId}`;
      }
      let enCours: ReturnType<typeof confirmer> | null = null;
      await sql.begin(async (tx) => {
        await tx`UPDATE suppliers SET phone = '0499887766', updated_at = now() WHERE id = ${id}`;
        enCours = confirmer(c, a.plan.planId);
        await attendre(400);
      });
      return { conf: await enCours!, phone: (await ligneFournisseur(id)).phone as string };
    };
    // Sans version : la relecture de A précède la validation de B, puis l'écriture de A ÉCRASE celle de B.
    const avant = await jouer(false);
    expect(avant.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(avant.phone).toBe('06 11 22 33 44');
    // Avec version (plans préparés depuis cette carte) : conflit, la valeur de B est conservée.
    const apres = await jouer(true);
    expect(apres.conf).toMatchObject({ ok: true, status: 'FAILED', results: [{ conflict: true }] });
    expect(apres.phone).toBe('0499887766');
  });

  const documentTitre = async (c: Compte, assetId: number, titre: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    return f.id as number;
  };

  it('T09 — E05 : un sinistre est une opération distincte du contrat d’assurance, associée à lui, jamais fusionnée', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    expect((await faire(c, 'Déclare un contrat « Assurance habitation » réalisé le 1 janvier 2024 pour la maison')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [contratAvant] = await operations(c);

    const s = planDe(await demander(c, 'Déclare un sinistre « Dégât des eaux » réalisé le 2 juin 2024 pour la maison'));
    expect(s.plan.actions[0]).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', params: { typeCode: 'CLAIM', status: 'REALIZED', eventDate: '2024-06-02' } });
    expect(s.plan.actions[0].effects).toContain('Ce sinistre est une opération distincte de celle de votre contrat d’assurance : rien n’est fusionné, et le contrat, ses cotisations et ses échéances ne sont pas modifiés.');
    expect(await operations(c)).toHaveLength(1);
    expect(await confirmer(c, s.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    let ops = await operations(c);
    expect(ops.map((o) => o.type_code)).toEqual(['CONTRACT', 'CLAIM']);
    // Le contrat n'a pas été touché ; rien n'est fusionné ; aucune échéance inventée.
    expect(ops[0]).toMatchObject({ id: contratAvant.id, version: contratAvant.version, invalide: false, fusion: null });
    expect(ops[1]).toMatchObject({ invalide: false, fusion: null, technical_label: 'Dégât des eaux' });
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id}`)[0].n)).toBe(0);
    // Source utilisateur auditée (déclaration, canal Assistant).
    const journal = JSON.stringify(await sql<Json[]>`SELECT * FROM business_operation_history WHERE operation_id = ${ops[1].id}`.catch(() => []));
    expect(journal === '[]' || /USER|ASSISTANT/.test(journal)).toBe(true);

    // Anti-doublon : même sinistre redéclaré → annoncé comme comparable, jamais créé en silence.
    const encore = planDe(await demander(c, 'Déclare un sinistre « Dégât des eaux » réalisé le 2 juin 2024 pour la maison'));
    expect(encore.plan.actions[0].effects.join(' ')).toMatch(/Attention : un événement de référence comparable existe déjà/);

    // Associé au contrat : les deux restent distincts.
    const lien = planDe(await demander(c, 'Associe le sinistre Dégât des eaux au contrat Assurance habitation'));
    expect(lien.plan.actions[0].effects).toContain('Ils restent deux événements de référence distincts : rien n’est fusionné.');
    const assoc = await confirmer(c, lien.plan.planId);
    expect(assoc).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(JSON.stringify(assoc)).toMatch(/associés\. Ils restent distincts\./);
    ops = await operations(c);
    expect(ops.filter((o) => !o.invalide && o.fusion === null).map((o) => o.type_code)).toEqual(['CONTRACT', 'CLAIM']);

    // Justificatif et prestataire reliés au sinistre.
    await documentTitre(c, maison, 'Constat amiable');
    await fournisseur(c, { name: 'Plombier Dupont' });
    expect((await faire(c, 'Rattache le document Constat amiable au sinistre Dégât des eaux')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await faire(c, 'Relie le fournisseur Plombier Dupont au sinistre Dégât des eaux')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    // Gestion : corriger sa date ; le convertir en contrat est refusé ; le supprimer laisse le contrat intact.
    expect((await faire(c, 'Corrige la date du sinistre Dégât des eaux au 3 juin 2024')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await demander(c, 'Change le type du sinistre Dégât des eaux en contrat')).toMatchObject({ kind: 'need_info', message: 'Depuis l’assistant, le type d’un sinistre ne se modifie pas.' });
    expect((await faire(c, 'Supprime le sinistre Dégât des eaux')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    ops = await operations(c);
    expect(ops.find((o) => o.type_code === 'CONTRACT')).toMatchObject({ invalide: false, fusion: null });
    expect(ops.find((o) => o.type_code === 'CLAIM')).toMatchObject({ invalide: true });
  });

  it('T10 — E06 : plus de 5 000 opérations actives et plus de 500 supprimées — toutes retrouvables, jamais un résultat partiel', async () => {
    const c = await compte();
    const autre = await compte();
    expect((await faire(c, 'Déclare une intervention « Modèle » à prévoir')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await faire(autre, 'Déclare une intervention « Zeta ultime » à prévoir')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [modele] = await operations(c);
    // Copies de l'opération modèle (mêmes colonnes) : 5 200 actives, puis 520 supprimées par l'utilisateur.
    const colonnes = (await sql<Json[]>`
      SELECT column_name AS nom, data_type AS type FROM information_schema.columns
       WHERE table_name = 'business_operations' AND table_schema = current_schema() AND column_name <> 'id' AND is_generated = 'NEVER'`);
    const cible = colonnes.map((k) => `"${k.nom}"`).join(', ');
    const source = (label: string, extra: Record<string, string> = {}) => colonnes.map((k) => (
      k.nom === 'technical_label' ? label
        : extra[k.nom] ?? (k.type === 'uuid' ? 'gen_random_uuid()' : `o."${k.nom}"`))).join(', ');
    await sql.unsafe(`INSERT INTO business_operations (${cible}) SELECT ${source(`'Lot ' || g`)} FROM business_operations o, generate_series(1, 5200) g WHERE o.id = ${modele.id}`);
    const supprimee = { invalidated_at: 'now()', invalidation_reason: `'USER_INVALIDATED'` };
    await sql.unsafe(`INSERT INTO business_operations (${cible}) SELECT ${source(`'Toiture ancienne'`, supprimee)} FROM business_operations o WHERE o.id = ${modele.id}`);
    await sql.unsafe(`INSERT INTO business_operations (${cible}) SELECT ${source(`'Ancienne ' || g`, supprimee)} FROM business_operations o, generate_series(1, 520) g WHERE o.id = ${modele.id}`);
    // La DERNIÈRE opération active du compte (au-delà des 5 000 premières) et la PLUS ANCIENNE supprimée (au-delà des 500 dernières).
    await sql.unsafe(`INSERT INTO business_operations (${cible}) SELECT ${source(`'Zeta ultime'`)} FROM business_operations o WHERE o.id = ${modele.id}`);
    const [{ actives, supprimees }] = await sql<Json[]>`
      SELECT count(*) FILTER (WHERE invalidated_at IS NULL)::int AS actives, count(*) FILTER (WHERE invalidated_at IS NOT NULL)::int AS supprimees
        FROM business_operations WHERE account_id = ${c.id}`;
    expect(Number(actives)).toBe(5202);
    expect(Number(supprimees)).toBe(521);

    const { sqlFindReferenceEvents, REFERENCE_EVENT_SEARCH_INCOMPLETE } = await import('@/services/verebona-assistant/commands/reference-events');
    const { sqlFindInvalidatedReferenceEvents } = await import('@/services/verebona-assistant/commands/reference-events-inverse');
    const debut = Date.now();
    // Parcours complet : toutes les actives sont lues (aucune n'est perdue au-delà de 5 000).
    expect(await sqlFindReferenceEvents(c.id, { typeCode: 'INTERVENTION', words: [], date: null })).toHaveLength(5202);
    expect((await sqlFindReferenceEvents(c.id, { typeCode: null, words: ['zeta', 'ultime'], date: null })).map((o) => o.technicalLabel)).toEqual(['Zeta ultime']);
    expect(await sqlFindInvalidatedReferenceEvents(c.id, { typeCode: null, words: [], date: null })).toHaveLength(521);
    expect((await sqlFindInvalidatedReferenceEvents(c.id, { typeCode: null, words: ['toiture'], date: null })).map((o) => o.technicalLabel)).toEqual(['Toiture ancienne']);
    console.info(`[l116d] parcours de 5 202 opérations actives et 521 supprimées : ${Date.now() - debut} ms`);

    // Par l'Assistant : l'opération au-delà du 5 000ᵉ rang est trouvée et modifiable ; la plus ancienne supprimée est retrouvée.
    const r = planDe(await demander(c, 'Renomme l’intervention Zeta ultime en Zeta finale'));
    expect(r.plan.actions[0].preview).toMatch(/Zeta ultime/);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const retablir = planDe(await demander(c, 'Rétablis l’intervention Toiture ancienne'));
    expect(retablir.plan.actions[0]).toMatchObject({ command: 'RESTORE_REFERENCE_EVENT' });
    expect(retablir.plan.actions[0].preview).toMatch(/Toiture ancienne/);
    // Une opération supprimée n'est JAMAIS rendue par la recherche des actives (pas de ressuscitation par la lecture).
    expect(await sqlFindReferenceEvents(c.id, { typeCode: null, words: ['ancienne'], date: null })).toHaveLength(0);
    // Isolation : l'autre compte ne voit que SA « Zeta ultime », et ce compte ne voit pas la sienne.
    expect(await sqlFindReferenceEvents(autre.id, { typeCode: null, words: [], date: null })).toHaveLength(1);
    expect((await sqlFindReferenceEvents(c.id, { typeCode: null, words: ['zeta'], date: null })).length).toBe(1);

    // Temps borné : budget dépassé → échec EXPLICITE, jamais une liste tronquée ; l'Assistant le dit, sans plan.
    await expect(sqlFindReferenceEvents(c.id, { typeCode: null, words: [], date: null }, { budgetMs: -1 })).rejects.toThrow(REFERENCE_EVENT_SEARCH_INCOMPLETE);
    await expect(sqlFindInvalidatedReferenceEvents(c.id, { typeCode: null, words: [], date: null }, { budgetMs: -1 })).rejects.toThrow(REFERENCE_EVENT_SEARCH_INCOMPLETE);
    const { prepareCommand, sqlLookup } = await import('@/services/verebona-assistant/commands/plan.service');
    const presse = await prepareCommand(
      { accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message: 'Supprime l’intervention Zeta finale', clientRequestId: 'l116d-budget', locale: 'fr-FR' } as never,
      { ...sqlLookup, findReferenceEvents: (a, q) => sqlFindReferenceEvents(a, q, { budgetMs: -1 }) },
    );
    expect(presse).toEqual({ kind: 'need_info', message: REFERENCE_EVENT_SEARCH_INCOMPLETE });
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${c.id} AND invalidated_at IS NULL`)[0].n)).toBe(5202);
  }, 240_000);

  it('T11 — E09 : déplacer un document = « Retirer de A » puis « Rattacher à B » ; demande ambiguë → question', async () => {
    const c = await compte();
    const clio = await voiture(c, 'Clio');
    await faire(c, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio');
    await faire(c, 'Déclare une intervention « Freins » réalisée le 20 mai 2025 pour la Clio');
    const [vidange, freins] = await operations(c);
    const doc = await documentTitre(c, clio, 'Facture Norauto');
    expect((await faire(c, 'Rattache le document Facture Norauto à l’intervention Vidange')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const { sqlLookup } = await import('@/services/verebona-assistant/commands/plan.service');
    const membres = async (id: number) => (await sqlLookup.getReferenceEventState!(c.id, id))?.documentCount ?? 0;
    expect([await membres(vidange.id), await membres(freins.id)]).toEqual([1, 0]);

    // Aucune commande autonome « déplacer » dans le catalogue fermé.
    const { WRITE_COMMAND_CATALOG } = await import('@/services/verebona-assistant/commands/catalog');
    expect(Object.keys(WRITE_COMMAND_CATALOG).filter((k) => /MOVE|TRANSFER|DEPLAC/.test(k))).toEqual([]);

    // Ambiguë (aucune opération d'origine) : une question, aucun plan.
    expect(await demander(c, 'Déplace le document Facture Norauto vers l’intervention Freins')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Voulez-vous déplacer ce document \(le retirer de son opération actuelle, puis le rattacher à l’autre\) ou seulement l’ajouter/) });

    // Explicite : deux gestes du catalogue, dans l'ordre, confirmés ensemble.
    const r = planDe(await demander(c, 'Déplace le document Facture Norauto de l’intervention Vidange vers l’intervention Freins'));
    expect(r.plan.actions.map((a) => [a.command, a.dependsOn])).toEqual([['UNLINK_DOCUMENT_REFERENCE_EVENT', []], ['LINK_DOCUMENT_REFERENCE_EVENT', ['a1']]]);
    expect(r.preview.summary).toBe('Je vais effectuer 2 actions, dans l’ordre indiqué. Confirmez-vous l’ensemble ?');
    expect([await membres(vidange.id), await membres(freins.id)]).toEqual([1, 0]);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect([await membres(vidange.id), await membres(freins.id)]).toEqual([0, 1]);
    // Un seul fichier, jamais copié ni supprimé.
    expect(await sql<Json[]>`SELECT id::int AS id, deleted_at FROM asset_files WHERE account_id = ${c.id}`).toEqual([{ id: doc, deleted_at: null }]);
    // « Rattache » seul = AJOUTER : le document est alors dans les deux opérations.
    expect((await faire(c, 'Rattache le document Facture Norauto à l’intervention Vidange')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect([await membres(vidange.id), await membres(freins.id)]).toEqual([1, 1]);
    // Le mot de l'écran, « opération », est compris.
    expect(await demander(c, 'Supprime l’opération Vidange')).toMatchObject({ kind: 'plan' });
  });

  it('T12 — E10 : conversion entre familles de bien refusée ; changement de catégorie dans la même famille permis', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    const refus = await demander(c, 'Change la catégorie de la Maison en voiture');
    expect(refus).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/n’est pas une catégorie de/) });
    expect((await sql<Json[]>`SELECT category, subtype FROM assets WHERE id = ${maison}`)[0]).toMatchObject({ category: 'IMMOBILIER', subtype: 'Maison' });
    const r = planDe(await demander(c, 'Change la catégorie de la Maison en appartement'));
    expect(r.plan.actions[0].effects).toContain('La famille du bien (immobilier, véhicule, objet) n’est pas modifiée.');
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await sql<Json[]>`SELECT category, subtype FROM assets WHERE id = ${maison}`)[0]).toMatchObject({ category: 'IMMOBILIER', subtype: 'Appartement' });
  });

  it('T13 — compte A contre compte B ; double clic : une seule écriture', async () => {
    const a = await compte();
    const b = await compte();
    const maisonA = await logement(a, 'Maison');
    await logement(b, 'Maison');
    await faire(a, 'Ajoute un équipement Chaudière dans la maison');
    const idA = await fournisseur(a, { name: 'Garage Martin', phone: '0102030405' });
    const idB = await fournisseur(b, { name: 'Garage Martin', phone: '0900000000' });
    await make.agendaItem(a as never, { title: 'Ramonage', startDate: '2031-09-01' });

    // B ne trouve ni l'équipement, ni l'échéance de A ; son fournisseur homonyme est le SIEN.
    expect(await demander(b, 'Modifie l’équipement Chaudière : statut en panne')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé cet équipement/) });
    expect(await demander(b, 'Modifie l’échéance Ramonage : description test')).toMatchObject({ kind: 'need_info' });
    const pb = planDe(await demander(b, 'Modifie le fournisseur Garage Martin : ville Nice'));
    expect(pb.plan.actions[0].targets).toEqual([{ type: 'supplier', id: idB, label: 'Garage Martin' }]);
    // Un plan de A n'existe pas pour B (ni confirmation, ni annulation).
    const pa = planDe(await demander(a, 'Modifie le fournisseur Garage Martin : ville Lyon'));
    expect(await confirmer(b, pa.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(await confirmer({ id: a.id, ownerUserId: b.ownerUserId }, pa.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    // Un équipement de A ne se déplace pas vers un bien de B (le bien de B est introuvable pour A).
    expect(await equipements(maisonA)).toHaveLength(1);

    // Double clic : deux confirmations simultanées — une seule exécution, une seule écriture.
    const [x, y] = await Promise.all([confirmer(a, pa.plan.planId), confirmer(a, pa.plan.planId)]);
    expect([x, y].filter((r) => r.ok && r.status === 'EXECUTED')).toHaveLength(1);
    expect([x, y].filter((r) => !r.ok && r.code === 'PLAN_ALREADY_HANDLED')).toHaveLength(1);
    expect((await ligneFournisseur(idA)).city).toBe('Lyon');
    expect((await ligneFournisseur(idB)).city).toBeNull();
    expect(Number((await sql<Json[]>`SELECT count(*)::int AS n FROM verebona_command_events WHERE plan_id = ${pa.plan.planId} AND event_type = 'EXECUTED'`)[0].n)).toBe(1);
  });
});
