/**
 * Lot 105D — ticket P1 « T3 / Cohérence / À traiter — Rattachement
 * rétroactif après création d'un bien » (§H), sur PostgreSQL réel.
 *
 * Données SYNTHÉTIQUES équivalentes au compte de test 10 (pas d'accès à la
 * préprod ni à l'archive) : Skoda Karoq rattaché à 11 documents, « Maison »
 * créée APRÈS l'import, sans adresse ; taxe foncière, acquisition, DPE,
 * assurance / sinistre, travaux citant le même logement fictif ; appareils
 * Bosch / Brandt / Rowenta ; adresse de facturation distincte ; deux logements
 * de la même ville.
 *
 * Chaîne de PRODUCTION : `analyzeFileSources` (sortie T1 rejouée) → file T3
 * vidée ; passage T3 du compte (`reconcileAccount`) ; carte « À traiter »
 * résolue par `resolveArbitration` / `undoArbitration` ; contrôle de
 * cohérence ciblé (`requestTargetedChecks` + `runTargetedChecks`) et campagne.
 * Appels modèle COMPTÉS par opération (passerelle rejouée).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, preuves, sortieT1, useTargetState, type FaitT1 } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

const ADR = '12 rue des Érables Fictifs, 69000 Lyon';
const ADR2 = '8 avenue des Tilleuls, 69000 Lyon';

scenario('L105D', 'T3 : rattachement rétroactif après création d’un bien (identités documentaires, carte groupée, cohérence)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const T3_ABS: RecordedOutput = { operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true };
  const fait = (canonicalKey: string, value: string | number, excerpt: string, valueType: FaitT1['valueType'] = 'string'): FaitT1 => ({ canonicalKey, value, valueType, excerpt, assetId: null });
  const sortie = (p: { title: string; type?: string; texte?: string[]; facts?: FaitT1[]; supplier?: string | null }) => sortieT1({
    title: p.title, date: '2025-09-15', documentTypeCode: p.type ?? 'OTHER', rubricCode: 'PROPERTY_MANAGEMENT', supplier: p.supplier ?? null,
    assets: [], facts: p.facts ?? [], texte: p.texte, multiAsset: false,
  });
  const analyser = async (compte: Compte, out: Record<string, unknown>, opts: { assetId?: number | null } = {}) => {
    const doc = await make.assetFile(compte, { assetId: opts.assetId ?? null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${doc.id}.pdf`}, analysis_state = NULL WHERE id = ${doc.id}`;
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: out }, T3_ABS]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([doc.id], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l105d' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${doc.id} en échec`);
    await drainQueues();
    return doc.id;
  };
  const passage = async (compte: Compte, recordings: RecordedOutput[] = [T3_ABS]) => {
    const replay = await rejouer(recordings);
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const run = await reconcileAccount(compte.id, { type: 'scheduled' }, { triggerCode: 'asset_updated' });
    await drainQueues();
    return { run, replay };
  };
  const appels = (replay: { calls: Array<{ operationCode?: string }> }, op: string) => replay.calls.filter((c) => c.operationCode === op).length;
  const principal = async (fileId: number) => (await sql<{ a: number | null }[]>`
    SELECT COALESCE(f.asset_id, (SELECT l.asset_id FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role = 'PRIMARY' ORDER BY l.id LIMIT 1)) AS a
      FROM asset_files f WHERE f.id = ${fileId}`)[0].a;
  const cartesOuvertes = async (compte: Compte, rule: string) => sql<{ id: number; public_id: string; target_id: number; question: string; ctx: Record<string, unknown> }[]>`
    SELECT id, public_id, target_id, question, trigger_context AS ctx FROM to_process_actions
     WHERE account_id = ${compte.id} AND rule_code = ${rule} AND resolved_at IS NULL ORDER BY id`;
  const lienIndividuel = async (fileId: number) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET' AND resolved_at IS NULL`)[0].n;
  // Lot 108E : groupes de LOGEMENT / véhicule (les groupes d'appareils, ajoutés au lot 108E, sont vérifiés à part).
  const groupes = async (compte: Compte) => sql<{ group_key: string; status: string; identity_label: string; member_file_ids: number[]; excluded: Array<{ fileId: number; reason: string }>; target_asset_id: number | null; active: boolean; card_action_id: number | null }[]>`
    SELECT group_key, status, identity_label, member_file_ids, excluded, target_asset_id, active, card_action_id FROM document_identity_groups
     WHERE account_id = ${compte.id} AND active AND identity_family <> 'EQUIPMENT' ORDER BY id`;
  const evaluation = async (fileId: number) => (await sql<{ status: string; reason_code: string | null; e: Record<string, unknown> | null }[]>`
    SELECT status, reason_code, last_evaluation AS e FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0];

  /** Monde synthétique équivalent au compte 10. */
  async function compte10(o: { maisonAvant?: Record<string, unknown> | null } = {}) {
    const compte = await make.account();
    const karoq = await make.asset(compte, { category: 'VEHICULE', name: 'Skoda Karoq', registrationNumber: 'FG-123-HJ' });
    const karoqDocs: number[] = [];
    const titresKaroq = ['Carte grise', 'Facture entretien 30 000 km', 'Facture pneus', 'Contrôle technique', 'Attestation assurance auto', 'Facture vidange',
      'Bon de commande véhicule', 'Facture carrosserie', 'Avis d’échéance assurance auto', 'Facture plaquettes', 'Certificat de cession'];
    for (const [i, t] of titresKaroq.entries()) {
      karoqDocs.push(await analyser(compte, sortie({
        title: `${t} Skoda Karoq`, texte: [`Véhicule immatriculé FG-123-HJ`, ...(i === 0 ? [`Titulaire : M. Exemple, domicilié ${ADR}`] : [])],
        facts: [fait('registrationNumber', 'FG-123-HJ', 'Immatriculation : FG-123-HJ')],
      })));
    }
    const maisonAvant = o.maisonAvant !== undefined && o.maisonAvant !== null
      ? await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: o.maisonAvant }) : null;
    const d = {
      tf24: await analyser(compte, sortie({ title: 'Avis de taxe foncière 2024', type: 'PROPERTY_TAX', texte: [`Adresse du bien : ${ADR}`],
        facts: [fait('address1', '12 rue des Érables Fictifs', 'Adresse du bien : 12 rue des Érables Fictifs'), fait('postalCode', '69000', 'Code postal : 69000'), fait('city', 'Lyon', 'Commune : Lyon')] })),
      tf25: await analyser(compte, sortie({ title: 'Avis de taxe foncière 2025', type: 'PROPERTY_TAX', texte: [`Adresse du bien : ${ADR}`] })),
      acte: await analyser(compte, sortie({ title: 'Acte d’acquisition', type: 'ACTE_AUTHENTIQUE', texte: [`Désignation du bien : ${ADR}`],
        facts: [fait('acquisitionPrice', 285000, 'Prix : 285 000 €', 'money_eur'), fait('acquisitionDate', '2019-06-14', 'Signé le 14/06/2019', 'date'), fait('livingArea', 112, 'Surface habitable : 112 m²', 'number')] })),
      dpe: await analyser(compte, sortie({ title: 'Diagnostic de performance énergétique', type: 'DPE', texte: [`Adresse du logement : ${ADR}`],
        facts: [fait('dpeAdemeNumber', '2569E1234567X', 'N° ADEME : 2569E1234567X')] })),
      assur: await analyser(compte, sortie({ title: 'Attestation assurance habitation', type: 'INSURANCE_CERTIFICATE', supplier: 'Assur Fictive', texte: [`Adresse du risque : ${ADR}`],
        facts: [fait('insuranceContractNumber', 'HAB-778899', 'Contrat n° HAB-778899')] })),
      avenant: await analyser(compte, sortie({ title: 'Avenant contrat habitation', type: 'INSURANCE_AMENDMENT', supplier: 'Assur Fictive', texte: ['Garantie dégâts des eaux étendue'],
        facts: [fait('insuranceContractNumber', 'HAB-778899', 'Contrat n° HAB-778899')] })),
      sinistre: await analyser(compte, sortie({ title: 'Déclaration de sinistre', type: 'CLAIM', supplier: 'Assur Fictive', texte: [`Lieu du sinistre : ${ADR}`] })),
      devis: await analyser(compte, sortie({ title: 'Devis travaux toiture', type: 'QUOTE', supplier: 'Toitures du Rhône', texte: [`Lieu des travaux : ${ADR}`] })),
      travaux: await analyser(compte, sortie({ title: 'Facture travaux toiture', type: 'MAINTENANCE_INVOICE', supplier: 'Toitures du Rhône', texte: [`Adresse du chantier : ${ADR}`] })),
      bosch1: await analyser(compte, sortie({ title: 'Facture lave-vaisselle Bosch', type: 'PURCHASE_INVOICE', supplier: 'Bosch', texte: [`Adresse de livraison : ${ADR}`],
        facts: [fait('serialNumber', 'FD9811-0456', 'N° de série : FD9811-0456'), fait('brand', 'Bosch', 'Marque : Bosch')] })),
      bosch2: await analyser(compte, sortie({ title: 'Garantie lave-vaisselle Bosch', type: 'WARRANTY_CERTIFICATE', supplier: 'Bosch', facts: [fait('serialNumber', 'FD9811-0456', 'N° de série : FD9811-0456')] })),
      bosch3: await analyser(compte, sortie({ title: 'Notice Bosch Serie 4', type: 'USER_MANUAL', supplier: 'Bosch', facts: [fait('modelName', 'SMV4HTX31E', 'Modèle : SMV4HTX31E')] })),
      brandt1: await analyser(compte, sortie({ title: 'Facture four Brandt', type: 'PURCHASE_INVOICE', supplier: 'Darty', texte: [`Adresse de facturation : ${ADR}`], facts: [fait('brand', 'Brandt', 'Marque : Brandt')] })),
      brandt2: await analyser(compte, sortie({ title: 'Garantie four Brandt', type: 'WARRANTY_CERTIFICATE', supplier: 'Brandt', facts: [fait('brand', 'Brandt', 'Marque : Brandt')] })),
      rowenta: await analyser(compte, sortie({ title: 'Ticket fer à repasser Rowenta', type: 'RECEIPT', supplier: 'Rowenta', facts: [fait('brand', 'Rowenta', 'Marque : Rowenta')] })),
    };
    const membres = [d.tf24, d.tf25, d.acte, d.dpe, d.assur, d.avenant, d.sinistre, d.devis, d.travaux];
    return { compte, karoq, karoqDocs, d, membres, maisonAvant };
  }

  it('H1 / T3SU-AC1 — document importé AVANT le bien ; bien créé avec son adresse → rattachement au passage suivant, sans T1 ni IA, LINK-ASSET fermé', async () => {
    const compte = await make.account();
    await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const doc = await analyser(compte, sortie({ title: 'Facture plomberie', texte: [`Intervention au ${ADR}`, `Adresse du chantier : ${ADR}`] }));
    expect(await principal(doc)).toBeNull();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { address1: '12 rue des Érables Fictifs', postalCode: '69000', city: 'Lyon' } });
    const { replay } = await passage(compte, []);
    expect(appels(replay, 't1_analyze_document') + appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await principal(doc)).toBe(maison.id);
    expect(await lienIndividuel(doc)).toBe(0);
  }, 120_000);

  it('H2 / H6 / H7 / H11 — compte 10 : « Maison » sans adresse créée après l’import → UN groupe, UNE carte groupée, aucune association implicite, Karoq intact, Bosch / Brandt exclus ; même contexte rejoué → aucun appel IA ni doublon', async () => {
    const w = await compte10();
    const maison = await make.asset(w.compte, { category: 'IMMOBILIER', name: 'Maison' });
    const p1 = await passage(w.compte);
    const [g] = await groupes(w.compte);
    expect(g).toMatchObject({ status: 'TO_CONFIRM', identity_label: ADR, target_asset_id: null });
    expect([...g.member_file_ids].sort((a, b) => a - b)).toEqual([...w.membres].sort((a, b) => a - b));
    expect(g.excluded).toEqual(expect.arrayContaining([{ fileId: w.d.bosch1, reason: 'EQUIPMENT_DOCUMENT' }, { fileId: w.d.brandt1, reason: 'ADDRESS_ROLE_BILLING' }]));
    // UNE carte groupée, périmètre visible, aucune carte individuelle doublon pour les membres.
    const cg = await cartesOuvertes(w.compte, 'LINK-ASSET-GROUP');
    expect(cg).toHaveLength(1);
    expect(cg[0].question).toBe(`Le logement du ${ADR} est-il votre bien « Maison » ?`);
    expect((cg[0].ctx.scope as { documents: unknown[] }).documents).toHaveLength(9);
    for (const m of w.membres) expect(await lienIndividuel(m), `carte individuelle ${m}`).toBe(0);
    // Aucune association implicite au seul bien immobilier ; Bosch / Brandt / Rowenta jamais affectés au logement.
    for (const f of [...w.membres, w.d.bosch1, w.d.bosch2, w.d.bosch3, w.d.brandt1, w.d.brandt2, w.d.rowenta]) expect(await principal(f), `doc ${f}`).not.toBe(maison.id);
    // Karoq : 11 liens conservés, aucun mélange véhicule / immobilier.
    for (const k of w.karoqDocs) expect(await principal(k)).toBe(w.karoq.id);
    // Membres : abstention SANS IA (la relation groupe → bien appartient à l'utilisateur).
    for (const m of w.membres) {
      const e = await evaluation(m);
      expect(e.reason_code, `doc ${m}`).toBe('GROUP_CONFIRMATION_PENDING');
    }
    // Lot 108E : le logement (à confirmer) + l'appareil Bosch (facture + garantie, même série, aucune fiche d'équipement).
    expect(p1.run.phases?.OPEN_KNOWLEDGE?.counts).toMatchObject({ identityGroups: 2, identityToConfirm: 1 });
    expect(p1.run.phases?.IDENTITY_GROUPS).toMatchObject({ status: 'DONE', state: 'DONE', counts: expect.objectContaining({ family_PROPERTY: 1, family_EQUIPMENT: 1 }) });
    // Même contexte rejoué : aucun appel modèle, aucune carte de plus.
    const p2 = await passage(w.compte);
    expect(appels(p2.replay, 't3_link_ambiguity')).toBe(0);
    expect((await cartesOuvertes(w.compte, 'LINK-ASSET-GROUP')).map((c) => c.id)).toEqual(cg.map((c) => c.id));
  }, 300_000);

  it('H3 — confirmation explicite : rattachement des SEULS documents démontrés (contrat à un saut compris), exceptions conservées, propagation (prix, date, surface), LINK-ASSET obsolètes fermés, sans T1 ; « Annuler » retire les liens et rouvre la carte', async () => {
    const w = await compte10();
    const maison = await make.asset(w.compte, { category: 'IMMOBILIER', name: 'Maison' });
    await passage(w.compte);
    const [carte] = await cartesOuvertes(w.compte, 'LINK-ASSET-GROUP');
    const replay = await rejouer([T3_ABS]);
    const { resolveArbitration, undoArbitration } = await import('@/services/to-process/resolve-action.service');
    const r = await resolveArbitration(w.compte.id, carte.public_id, `CONFIRM:${maison.id}`, { userId: w.compte.ownerUserId });
    expect(r.ok).toBe(true);
    await drainQueues();
    expect(appels(replay, 't1_analyze_document')).toBe(0);
    for (const m of w.membres) expect(await principal(m), `membre ${m}`).toBe(maison.id);
    for (const x of [w.d.bosch1, w.d.bosch2, w.d.bosch3, w.d.brandt1, w.d.brandt2, w.d.rowenta]) expect(await principal(x), `exception ${x}`).not.toBe(maison.id);
    for (const k of w.karoqDocs) expect(await principal(k)).toBe(w.karoq.id);
    const e = await evaluation(w.d.avenant);
    expect(e).toMatchObject({ status: 'RESOLVED' });
    // Contrat à un saut : règle de groupe, ou règle existante « référence partagée » si l'attestation est déjà rattachée (ordre de la file).
    expect(['GROUP_IDENTITY_CONFIRMED:CONTRACT', 'SHARED_REFERENCE']).toContain(e.reason_code);
    // Propagation par la chaîne existante (projection des faits du document rattaché).
    const p = await preuves(sql, maison.id);
    expect(p.map((x) => x.key)).toEqual(expect.arrayContaining(['address1', 'postalCode', 'livingArea']));
    // Prix et date d'acquisition : preuve du bien OU événement de référence (Opérations) issu de l'acte rattaché — jamais recopiés ailleurs.
    const ops = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_documents WHERE file_id = ${w.d.acte} AND active`;
    expect(p.some((x) => x.key === 'acquisitionPrice') || ops[0].n > 0).toBe(true);
    // Aucun prix / garantie d'appareil recopié sur la Maison (Bosch / Brandt non rattachés).
    expect(p.every((x) => ![w.d.bosch1, w.d.bosch2, w.d.brandt1, w.d.brandt2].includes(x.sourceId))).toBe(true);
    expect(await cartesOuvertes(w.compte, 'LINK-ASSET-GROUP')).toHaveLength(0);
    const [dec] = await sql<{ decision: string; status: string }[]>`SELECT decision, status FROM document_identity_decisions WHERE account_id = ${w.compte.id}`;
    expect(dec).toEqual({ decision: 'CONFIRMED', status: 'ACTIVE' });
    // Passage suivant : groupe CONFIRMED au journal, rien de plus (idempotence).
    await passage(w.compte);
    // Lot 108E (A9, assertion stricte) : tous les membres sont rattachés — plus aucun groupe de documents SANS bien
    // n'est actif (le journal ne garde que les groupes qui ont encore des membres) ; la décision reste ACTIVE.
    expect(await groupes(w.compte)).toEqual([]);
    expect((await sql<{ status: string }[]>`SELECT status FROM document_identity_decisions WHERE account_id = ${w.compte.id}`).map((x) => x.status)).toEqual(['ACTIVE']);
    // Annuler : décision UNDONE, liens d'origine IA posés par la confirmation retirés, même carte rouverte.
    const u = await undoArbitration(w.compte.id, carte.public_id, r.previousValue);
    expect(u.ok).toBe(true);
    for (const m of w.membres) expect(await principal(m), `annulation ${m}`).toBeNull();
    expect((await cartesOuvertes(w.compte, 'LINK-ASSET-GROUP')).map((c) => c.id)).toEqual([carte.id]);
  }, 300_000);

  it('H4 — refus : aucune liaison, refus conservé, aucune question répétée à contexte inchangé (ni groupée, ni individuelle, ni IA) ; bien renommé → nouvelle question', async () => {
    const compte = await make.account();
    const docs = [
      await analyser(compte, sortie({ title: 'Taxe foncière', texte: [`Adresse du bien : ${ADR}`] })),
      await analyser(compte, sortie({ title: 'DPE', texte: [`Adresse du logement : ${ADR}`] })),
      await analyser(compte, sortie({ title: 'Devis toiture', texte: [`Lieu des travaux : ${ADR}`] })),
    ];
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await passage(compte);
    const [carte] = await cartesOuvertes(compte, 'LINK-ASSET-GROUP');
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect((await resolveArbitration(compte.id, carte.public_id, 'REFUSE', { userId: compte.ownerUserId })).ok).toBe(true);
    await drainQueues();
    const p = await passage(compte);
    expect(appels(p.replay, 't3_link_ambiguity')).toBe(0);
    expect(await cartesOuvertes(compte, 'LINK-ASSET-GROUP')).toHaveLength(0);
    for (const d of docs) {
      expect(await principal(d)).toBeNull();
      expect(await lienIndividuel(d)).toBe(0);
      expect((await evaluation(d)).reason_code).toBe('GROUP_REFUSED');
    }
    expect((await groupes(compte))[0]).toMatchObject({ status: 'REFUSED' });
    // Contexte du refus modifié (bien renommé) : la question peut revenir.
    await sql`UPDATE assets SET name = 'Maison de Lyon' WHERE id = ${maison.id}`;
    await passage(compte);
    expect(await cartesOuvertes(compte, 'LINK-ASSET-GROUP')).toHaveLength(1);
  }, 240_000);

  it('H5 / H8 — deux logements de la même ville, fournisseur commun, facturation à la résidence ≠ adresse du bien, contrat partagé par deux logements → zéro faux rattachement', async () => {
    const compte = await make.account();
    const a = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { address1: '12 rue des Érables Fictifs', postalCode: '69000', city: 'Lyon' } });
    const b = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement', keyCharacteristics: { address1: '8 avenue des Tilleuls', postalCode: '69000', city: 'Lyon' } });
    const loue = await analyser(compte, sortie({ title: 'Quittance de loyer', supplier: 'Régie Lyonnaise', texte: [`Adresse de facturation : ${ADR}`, `Adresse du bien loué : ${ADR2}`] }));
    const edf = await analyser(compte, sortie({ title: 'Facture électricité', supplier: 'EDF', texte: ['Lyon 69000 — consommation annuelle'] }));
    const contrat = await analyser(compte, sortie({ title: 'Avenant multirisque', supplier: 'Assur Fictive', facts: [fait('contractNumber', 'CTR-123456', 'Contrat CTR-123456')] }));
    await analyser(compte, sortie({ title: 'Attestation A', texte: [`Adresse du risque : ${ADR}`], facts: [fait('contractNumber', 'CTR-123456', 'Contrat CTR-123456')] }));
    await analyser(compte, sortie({ title: 'Attestation B', texte: [`Adresse du risque : ${ADR2}`], facts: [fait('contractNumber', 'CTR-123456', 'Contrat CTR-123456')] }));
    await passage(compte);
    // Le logement LOUÉ (adresse du bien) — jamais la résidence de facturation.
    expect(await principal(loue)).toBe(b.id);
    expect(await principal(edf)).toBeNull();
    expect(await principal(contrat)).toBeNull();
    expect(await principal(contrat)).not.toBe(a.id);
  }, 240_000);

  it('H9 — décisions USER protégées, isolation des comptes (Duo / autre compte) : jamais écrasées, jamais mélangées', async () => {
    const compte = await make.account();
    const autre = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const user = await analyser(compte, sortie({ title: 'Taxe foncière', texte: [`Adresse du bien : ${ADR}`] }));
    const dpe = await analyser(compte, sortie({ title: 'DPE', texte: [`Adresse du logement : ${ADR}`] }));
    const assu = await analyser(compte, sortie({ title: 'Assurance', texte: [`Adresse du risque : ${ADR}`] }));
    // L'utilisateur a rattaché lui-même un document au Studio : intouchable.
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: user, target: { assetId: autre.id }, role: 'PRIMARY', origin: 'USER' });
    // Second compte : mêmes adresses, son propre bien — aucun partage de groupe ni de décision.
    const voisin = await make.account();
    const vDoc = await analyser(voisin, sortie({ title: 'Taxe foncière voisin', texte: [`Adresse du bien : ${ADR}`] }));
    await analyser(voisin, sortie({ title: 'DPE voisin', texte: [`Adresse du logement : ${ADR}`] }));
    const vMaison = await make.asset(voisin, { category: 'IMMOBILIER', name: 'Maison' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await passage(compte);
    await passage(voisin);
    const [carte] = await cartesOuvertes(compte, 'LINK-ASSET-GROUP');
    // Le document rattaché par l'utilisateur est une ANCRE (Studio) : groupe attesté pour le Studio, jamais déplacé vers Maison.
    expect(await principal(user)).toBe(autre.id);
    // Lot 108E (A9, assertion stricte) : le document de l'utilisateur ATTESTE le logement « Studio » — aucune
    // carte groupée vers « Maison », les autres documents du logement suivent le Studio, jamais la Maison.
    expect(carte).toBeUndefined();
    await drainQueues();
    expect(await principal(user)).toBe(autre.id);
    expect(await principal(dpe)).toBe(autre.id);
    expect(await principal(assu)).toBe(autre.id);
    void maison;
    // Isolation : rien dans l'autre compte n'a bougé.
    expect(await principal(vDoc)).toBeNull();
    expect(await principal(vDoc)).not.toBe(maison.id);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_identity_decisions WHERE account_id = ${voisin.id}`)[0].n).toBe(0);
    expect((await cartesOuvertes(voisin, 'LINK-ASSET-GROUP')).every((c) => (c.ctx.memberFileIds as number[]).every((f) => f !== user))).toBe(true);
    void vMaison;
  }, 300_000);

  it('H10 — identifiant ajouté tardivement sur le bien : groupe DÉMONTRÉ, membres rattachés (contrat à un saut compris) sans carte, carte groupée fermée ; nouveau document arrivé ensuite → rattaché', async () => {
    const compte = await make.account();
    const tf = await analyser(compte, sortie({ title: 'Taxe foncière', texte: [`Adresse du bien : ${ADR}`] }));
    const assur = await analyser(compte, sortie({ title: 'Attestation habitation', texte: [`Adresse du risque : ${ADR}`], facts: [fait('insuranceContractNumber', 'HAB-445566', 'Contrat HAB-445566')] }));
    const avenant = await analyser(compte, sortie({ title: 'Avenant', facts: [fait('insuranceContractNumber', 'HAB-445566', 'Contrat HAB-445566')] }));
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await passage(compte);
    expect(await cartesOuvertes(compte, 'LINK-ASSET-GROUP')).toHaveLength(1);
    // L'utilisateur complète l'adresse de la Maison.
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ address1: '12 rue des Érables Fictifs', postalCode: '69000', city: 'Lyon' })}::jsonb WHERE id = ${maison.id}`;
    const p = await passage(compte, []);
    expect(appels(p.replay, 't3_link_ambiguity') + appels(p.replay, 't1_analyze_document')).toBe(0);
    for (const d of [tf, assur, avenant]) expect(await principal(d), `doc ${d}`).toBe(maison.id);
    expect(await cartesOuvertes(compte, 'LINK-ASSET-GROUP')).toHaveLength(0);
    const tardif = await analyser(compte, sortie({ title: 'Facture ramonage', texte: [`Lieu d’intervention : chaudière. Adresse du bien : ${ADR}`] }));
    expect(await principal(tardif)).toBe(maison.id);
  }, 240_000);

  it('H12 / G — ASSET_CREATED : le contrôle ciblé couvre TOUS les orphelins historiques, états distincts (plus de CONSISTENT trompeur) ; campagne quotidienne cohérente avec l’état réel', async () => {
    const compte = await make.account();
    const docs = [
      await analyser(compte, sortie({ title: 'Taxe foncière', texte: [`Adresse du bien : ${ADR}`] })),
      await analyser(compte, sortie({ title: 'DPE', texte: [`Adresse du logement : ${ADR}`] })),
    ];
    const ticket = await analyser(compte, sortie({ title: 'Ticket de caisse', supplier: 'Supermarché' }));
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { requestTargetedChecks, runTargetedChecks } = await import('@/services/coherence/orchestrator');
    const demande = await requestTargetedChecks({ accountId: compte.id, event: { type: 'ASSET_CREATED', entityId: maison.id } });
    expect(demande['COH-DOC-PRIMARY-LINK']).toBe(3);
    // Avant le passage T3 : jamais examinés dans ce contexte → réparables (remise en file T3), pas CONSISTENT.
    await runTargetedChecks({ mode: 'DRY_RUN', now: new Date(Date.now() + 3_600_000), deadline: Date.now() + 120_000 });
    const preuve = async (id: number, check = 'COH-DOC-PRIMARY-LINK') => (await sql<{ last_result: string; finding: Record<string, unknown> | null }[]>`
      SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${compte.id} AND check_id = ${check} AND object_id = ${id}`)[0];
    for (const d of docs) expect((await preuve(d)).last_result).not.toBe('CONSISTENT');
    // Passage T3 : groupe à confirmer → AMBIGUOUS « identité à confirmer » ; ticket → aucun candidat / décision attendue.
    await passage(compte);
    const { runCoherenceFor } = await import('../coherence-run');
    await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN' });
    for (const d of docs) expect((await preuve(d)).finding).toMatchObject({ anomaly: 'PRIMARY_LINK_IDENTITY_TO_CONFIRM' });
    expect((await preuve(ticket)).last_result).toBe('AMBIGUOUS');
    // COH-DOC-LINKS ne déclare plus le bien principal « conforme » : renvoi explicite.
    const dl = await preuve(docs[0], 'COH-DOC-LINKS');
    expect(dl).toBeDefined();
    expect(JSON.stringify(dl.finding ?? {})).not.toMatch(/PRIMARY_PRESENT/);
  }, 240_000);

  it('H13 — panne technique : échec T3 → constat Supervision (FINDING), jamais une question métier ; coupure T3_IDENTITY_GROUPS_ENABLED=0 → comportement antérieur', async () => {
    const compte = await make.account();
    const d1 = await analyser(compte, sortie({ title: 'Taxe foncière', texte: [`Adresse du bien : ${ADR}`] }));
    const d2 = await analyser(compte, sortie({ title: 'DPE', texte: [`Adresse du logement : ${ADR}`] }));
    await sql`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, trigger_code, status, attempts, payload, finished_at, dedupe_key)
              VALUES ('T3', ${compte.id}, 'document', ${String(d1)}, 'e2e', 'FAILED', 5, '{"payloadVersion":1,"kind":"document_asset"}'::jsonb, now(), ${`e2e-l105d-${d1}`})`;
    const { documentPrimaryLinkCheck } = await import('@/services/coherence/registry/checks/document-primary-link');
    const { pgClient } = await import('@/db');
    const cartesAvant = await lienIndividuel(d1);
    const insp = await documentPrimaryLinkCheck.inspect!({ sql: pgClient as never, now: new Date(), today: '2026-11-02', mode: 'DRY_RUN', correlationId: 'e2e' }, compte.id, [d1, d2]);
    expect(insp.get(d1)).toMatchObject({ verdict: 'FINDING', anomaly: 'PRIMARY_LINK_TREATMENT_FAILED' });
    // Lot 108E (A9) : ZÉRO carte engendrée par la panne (plus de tolérance « ≤ 1 ») — la carte « aucun bien »
    // éventuelle préexiste à la panne (compte sans bien lors de l'analyse) ; le constat n'en crée aucune.
    expect(await lienIndividuel(d1)).toBe(cartesAvant);
    process.env.T3_IDENTITY_GROUPS_ENABLED = '0';
    try {
      await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
      await passage(compte);
      expect(await cartesOuvertes(compte, 'LINK-ASSET-GROUP')).toHaveLength(0);
    } finally {
      delete process.env.T3_IDENTITY_GROUPS_ENABLED;
    }
  }, 240_000);

  it('§E — contrat « preuves croisées » actif : variables enrichies (fileId, crossDocument, aucune adresse), ancien contrat : variables d’avant ; garde serveur inchangée', async () => {
    const w = await compte10();
    await make.asset(w.compte, { category: 'IMMOBILIER', name: 'Maison' });
    await passage(w.compte);
    const { resolveDocumentAsset } = await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service');
    const vus: Array<Record<string, unknown>> = [];
    const callModel = async (p: { variables: Record<string, unknown> }) => { vus.push(p.variables); return { task: 'LINK_AMBIGUITY' as const, matches: [] }; };
    // Bosch (exclu du groupe) : candidats sémantiques → appel ; contrat actif → contexte croisé.
    await resolveDocumentAsset({ accountId: w.compte.id, fileId: w.d.bosch1, triggerCode: 'manual' }, { callModel, crossContractActive: async () => true, aiConfigSignature: async () => 'sig' });
    await resolveDocumentAsset({ accountId: w.compte.id, fileId: w.d.brandt1, triggerCode: 'manual' }, { callModel, crossContractActive: async () => false, aiConfigSignature: async () => 'sig' });
    const avec = vus.find((v) => String(v.SUBJECT_CONTEXT).includes('crossDocument'));
    const sans = vus.filter((v) => !String(v.SUBJECT_CONTEXT).includes('crossDocument'));
    // Lot 108E (A3, A9) : transmission OBLIGATOIRE (recherche sémantique comprise) — plus de vérification sous condition.
    expect(avec).toBeDefined();
    expect(String(avec!.SUBJECT_CONTEXT)).not.toMatch(/rables|69000/i);
    expect(JSON.parse(String(avec!.SUBJECT_CONTEXT)).document.fileId).toBe(w.d.bosch1);
    expect(JSON.parse(String(avec!.SUBJECT_CONTEXT)).crossDocument.documentIdentity).toMatchObject({ status: 'EXCLUDED', exclusionReason: 'EQUIPMENT_DOCUMENT' });
    expect(sans.length).toBeGreaterThan(0);
    for (const v of sans) expect(JSON.parse(String(v.SUBJECT_CONTEXT)).document.fileId).toBeUndefined();
  }, 300_000);
});
