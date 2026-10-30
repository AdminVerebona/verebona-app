/**
 * Lot 101A — ticket « Continuité conversationnelle et série d'un
 * équipement », de bout en bout sur PostgreSQL réel : `runAssistant` + PORTS
 * RÉELS (`buildOrchestratorPorts`), fil persisté (mémoire du fil réelle),
 * passerelle de REJEU (aucun réseau : `replay.calls` compte les appels LLM),
 * point d'entrée T1 de production, contrôle de cohérence réel.
 *
 * JEU DU CAS RÉEL (30/10/2026) : un micro-onde Samsung (marque, modèle
 * MG23K3515AK) et, sur le compte, des documents PARASITES qui contiennent le
 * mot « série » ou des numéros : tickets Decathlon (« Article série », 29,99 €),
 * facture Orange (« Série Spéciale Livebox Lite Fibre »), facture EDF (numéro
 * de série du compteur), carte grise (VIN). Avant le lot 101A, « Et la série ? »
 * remontait 10 de ces valeurs.
 *
 * Tests de non-régression OBLIGATOIRES du ticket : L101A-E2E-01 à 12.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { analyserDocument, demander, sortieT1, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
const PARASITES = ['Decathlon', '29,99', 'Livebox', 'EDF', 'VF1RFB00X56123456', '021529000123', '0042'];
const sansParasite = (t: string) => { for (const p of PARASITES) expect(t, p).not.toContain(p); };
const understand = (output: Record<string, unknown>) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND',
  output: { mode: 'UNDERSTAND', confidence: 'exact', requestedTopics: [], filters: {}, reason: 'e2e', ...output },
});

scenario('L101A-T2', 'Lot 101A — continuité conversationnelle et série d’un équipement', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let entite: typeof import('@/services/canonical/entity-state');
  beforeAll(async () => { entite = await import('@/services/canonical/entity-state'); });

  const equipement = async (assetId: number, name: string, type: string) => {
    const [e] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${assetId}, ${name}, ${type}) RETURNING id`;
    return Number(e.id);
  };
  const ecrire = async (c: Compte, id: number, valeurs: Record<string, unknown>, origin: 'DOCUMENT_EXTRACTION' | 'USER' = 'DOCUMENT_EXTRACTION') => {
    const r = await entite.writeCanonicalEntityFields({ target: { type: 'EQUIPMENT', id }, accountId: c.id, origin,
      writes: Object.entries(valeurs).map(([key, value]) => ({ key, value })) });
    expect(r.fields.every((f) => f.outcome === 'written' || f.outcome === 'unchanged'), JSON.stringify(r.fields.map((f) => [f.key, f.outcome, f.reason]))).toBe(true);
  };
  const document = async (c: Compte, assetId: number | null, titre: string, faits: Array<{ key: string; attribute: string; value: string; canonical?: string | null; unit?: string | null; target?: [string, number] | null }>, sourceType = 'asset_file') => {
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId, name: `${titre}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${titre}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const [ext] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, full_text, source_type)
      VALUES (${c.id}, ${f.id}, ${titre}, ${faits.map((x) => `${x.attribute} : ${x.value}`).join('\n')}, ${sourceType}) RETURNING id`;
    for (const x of faits) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, subject, attribute, label, value_text, value_unit, confidence, excerpt,
                                            canonical_key, target_type, target_entity_id)
                VALUES (${c.id}, ${f.id}, ${ext.id}, ${x.canonical ?? x.attribute}, ${titre}, ${x.attribute}, ${x.attribute}, ${x.value}, ${x.unit ?? null}, 'certain',
                        ${`${x.attribute} : ${x.value}`}, ${x.canonical ?? null}, ${x.target?.[0] ?? null}, ${x.target?.[1] || null})`;
    }
    return f.id;
  };

  /** Compte du cas réel : micro-onde Samsung, four Bosch, documents parasites. */
  const compteReel = async () => {
    const a = await make.account({ plan: 'premium' });
    const c = { id: a.id, ownerUserId: a.ownerUserId };
    const maison = await make.asset(c as never, { category: 'IMMOBILIER', name: 'Maison' });
    const velo = await make.asset(c as never, { category: 'OBJET', name: 'Vélo' });
    const voiture = await make.asset(c as never, { category: 'VEHICULE', name: 'Clio' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ANY(${[maison.id, velo.id, voiture.id]}::int[])`;
    const micro = await equipement(maison.id, 'Micro-onde', 'Micro-onde');
    const four = await equipement(maison.id, 'Four', 'Four');
    await ecrire(c, micro, { brand: 'Samsung', modelName: 'MG23K3515AK' });
    await ecrire(c, four, { brand: 'Bosch', modelName: 'HBA534BS0' });
    await document(c, velo.id, 'Ticket Decathlon', [
      { key: 'x', attribute: 'Article série', value: '29,99', unit: 'EUR' },
      { key: 'x', attribute: 'N° de série transaction', value: '0042 7781 2231' },
    ]);
    await document(c, maison.id, 'Facture Orange', [{ key: 'x', attribute: 'Offre série', value: 'Série Spéciale Livebox Lite Fibre' }]);
    await document(c, maison.id, 'Facture EDF', [{ key: 'x', attribute: 'Numéro de série du compteur', value: '021529000123', canonical: 'serialNumber', target: ['GENERIC', 0] }]);
    await document(c, voiture.id, 'Carte grise Clio', [{ key: 'x', attribute: 'VIN série', value: 'VF1RFB00X56123456', canonical: 'vin', target: ['ASSET', voiture.id] }]);
    return { c, maison: maison.id, micro, four, voiture: voiture.id };
  };

  it('L101A-E2E-01 — cas réel : « C’est quoi la marque de mon micro-onde ? » puis « Et la série ? » → equipment_id du micro-onde, aucune valeur parasite, 0 appel LLM', async () => {
    const { c, micro } = await compteReel();
    const replay = await useRecordings([]);
    const r1 = await demander(c, 'C’est quoi la marque de mon micro-onde ?');
    expect(r1.answer).toBe('Marque de Micro-onde : Samsung.');
    expect(r1.conversationId).toBeTruthy();
    const r2 = await demander(c, 'Et la série ?', { conversationId: r1.conversationId });
    expect(r2.answer).toBe('L’information « Série du produit » n’est pas renseignée pour Micro-onde.');
    sansParasite(r2.answer);
    expect(r2.answer).not.toContain('MG23K3515AK');
    expect(JSON.stringify(r2.sources)).not.toMatch(/Decathlon|Orange|EDF|Carte grise/);
    expect(r2.cascade?.reference).toMatchObject({ outcome: 'resolved', method: 'ellipsis', entity: { type: 'equipment', id: micro } });
    expect(replay.calls).toHaveLength(0);
    // Diagnostic du tour persisté (BO « Routage T2 », diagnostic global) : rien d'autre à chercher.
    const [run] = await sql<{ t: Record<string, unknown> }[]>`
      SELECT retrieval_methods_json->'turn' AS t FROM verebona_request_runs WHERE account_id = ${c.id} ORDER BY id DESC LIMIT 1`;
    expect(run.t).toMatchObject({
      contextMessages: 2, elliptical: true, activeObjectsBefore: [{ type: 'equipment', id: micro, via: 'lastSelected' }],
      resolvedTargets: [{ type: 'equipment', id: micro, origin: 'thread' }], requestedProperty: ['productSeries'],
      routing: { decision: 'DETERMINISTIC_BOUNDED' }, understandCalled: false, anomalies: [],
    });
  });

  it('L101A-E2E-02/03/12 — marque → « Et le modèle ? » → « Et son numéro de série ? » (absent : information non disponible, aucun candidat parasite)', async () => {
    const { c, micro } = await compteReel();
    const replay = await useRecordings([]);
    const r1 = await demander(c, 'C’est quoi la marque de mon micro-onde ?');
    const r2 = await demander(c, 'Et le modèle ?', { conversationId: r1.conversationId });
    expect(r2.answer).toBe('Modèle de Micro-onde : MG23K3515AK.');
    const r3 = await demander(c, 'Et son numéro de série ?', { conversationId: r1.conversationId });
    expect(r3.answer).toBe('L’information « Numéro de série » n’est pas renseignée pour Micro-onde.');
    sansParasite(r3.answer);
    expect(r3.answer).not.toContain('MG23K3515');
    for (const r of [r2, r3]) expect(r.cascade?.reference?.entity).toEqual({ type: 'equipment', id: micro });
    expect(replay.calls).toHaveLength(0);
  });

  it('L101A-E2E-04 — équipement A puis équipement B puis « Et la marque ? » : le dernier objet actif', async () => {
    const { c, four } = await compteReel();
    await useRecordings([]);
    const r1 = await demander(c, 'C’est quoi la marque de mon micro-onde ?');
    const r2 = await demander(c, 'Quel est le modèle du four ?', { conversationId: r1.conversationId });
    expect(r2.answer).toBe('Modèle de Four : HBA534BS0.');
    const r3 = await demander(c, 'Et la marque ?', { conversationId: r1.conversationId });
    expect(r3.answer).toBe('Marque de Four : Bosch.');
    expect(r3.cascade?.reference?.entity).toEqual({ type: 'equipment', id: four });
  });

  it('L101A-E2E-05 — ambiguïté réelle (deux micro-ondes) : clarification, aucune sélection arbitraire', async () => {
    const { c, maison } = await compteReel();
    const chalet = await make.asset(c as never, { category: 'IMMOBILIER', name: 'Chalet' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${chalet.id}`;
    const autre = await equipement(chalet.id, 'Micro-onde', 'Micro-onde');
    await ecrire(c, autre, { brand: 'Whirlpool' });
    await useRecordings([]);
    const r = await demander(c, 'C’est quoi la marque de mon micro-onde ?');
    // Question de précision (avec les biens parents), jamais une valeur choisie au hasard.
    expect(r.answer).toMatch(/parlez-vous/);
    expect(r.answer).toContain('Maison');
    expect(r.answer).toContain('Chalet');
    expect(r.answer).not.toMatch(/Samsung|Whirlpool/);
    expect(r.cascade?.diagnostic).toBe('TARGET_AMBIGUOUS');
    expect(maison).toBeGreaterThan(0);
    expect(autre).toBeGreaterThan(0);
  });

  it('L101A-E2E-06/07/08 — documents « série » sans rapport, prix « série », VIN et numéros contractuels : jamais candidats (périmètre de l’objet, candidats tracés)', async () => {
    const { c, micro } = await compteReel();
    await useRecordings([]);
    const r1 = await demander(c, 'C’est quoi la marque de mon micro-onde ?');
    // Propriété hors vocabulaire déterministe, sans compréhension disponible : retrieval BORNÉ au micro-onde.
    const r2 = await demander(c, 'Et son prix ?', { conversationId: r1.conversationId });
    sansParasite(r2.answer);
    expect(r2.answer).not.toBe('Voici « Micro-onde ».');
    expect(r2.cascade?.reference?.entity).toEqual({ type: 'equipment', id: micro });
    const t = r2.cascade?.turn;
    expect(t?.routing?.decision).toBe('UNDERSTAND_FIRST');
    if (t?.retrievalScope) expect(t.retrievalScope).toMatchObject({ kind: 'OBJECT', objectType: 'equipment', objectId: micro });
    expect(t?.anomalies ?? []).not.toContain('ACCOUNT_SEARCH_WITH_ACTIVE_OBJECT');
  });

  it('L101A-E2E-06 bis — « Et son prix ? » compris par UNDERSTAND (rejeu) : prix d’achat du micro-onde seulement', async () => {
    const { c, micro } = await compteReel();
    await ecrire(c, micro, { acquisitionPrice: 149 });
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'equipment', value: 'micro-onde' }], requestedFacts: ['acquisitionPrice'] })]);
    const r1 = await demander(c, 'C’est quoi la marque de mon micro-onde ?');
    const r2 = await demander(c, 'Et son prix ?', { conversationId: r1.conversationId });
    expect(r2.answer).toContain('149');
    sansParasite(r2.answer);
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(r2.cascade?.turn?.understandCalled).toBe(true);
  });

  it('L101A-E2E-09/10/11 — page fournisseur (produit principal + recommandés) par le point d’entrée T1 : MC32J7035AK jamais « certain » sur le micro-onde, libellé générique hors modèle', async () => {
    const { c, maison, micro } = await compteReel();
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId: maison, name: 'samsung-mg23k3515ak.html' });
    const out = sortieT1({
      title: 'Micro-Ondes Gril 23L MG23K3515AK', date: '2026-10-01', documentTypeCode: 'USER_MANUAL', supplier: 'Samsung',
      assets: [{ id: maison, label: 'Maison' }], equipments: [{ id: micro, label: 'Micro-onde' }],
      facts: [
        { canonicalKey: 'modelName', value: 'MG23K3515AK', valueType: 'string', excerpt: 'Modèle MG23K3515AK', assetId: maison, targetType: 'EQUIPMENT', equipmentId: micro },
        { canonicalKey: 'modelName', value: 'MG23K3515**', valueType: 'string', excerpt: 'Gamme MG23K3515**', assetId: maison, targetType: 'EQUIPMENT', equipmentId: micro },
        { canonicalKey: 'modelName', value: 'MC32J7035AK(MC32J7035AK_EF)', valueType: 'string', excerpt: 'Vous aimerez aussi MC32J7035AK(MC32J7035AK_EF)', assetId: maison, targetType: 'EQUIPMENT', equipmentId: micro },
        { canonicalKey: 'modelName', value: 'Micro-Ondes Gril 23L', valueType: 'string', excerpt: 'Micro-Ondes Gril 23L', assetId: maison, targetType: 'EQUIPMENT', equipmentId: micro },
      ],
    });
    await analyserDocument(sql, useRecordings, { accountId: c.id, userId: c.ownerUserId, fileId: f.id, linkedAssetId: maison, output: out });
    const faits = await sql<{ canonical_key: string | null; raw_key: string | null; value_text: string; confidence: string; target_type: string | null; target_entity_id: number | null }[]>`
      SELECT canonical_key, raw_key, value_text, confidence, target_type, target_entity_id FROM document_facts WHERE file_id = ${f.id} AND status = 'active' ORDER BY id`;
    const mc = faits.find((x) => x.value_text?.includes('MC32J7035AK'))!;
    expect(mc.confidence).not.toBe('certain');
    const libelle = faits.find((x) => x.value_text === 'Micro-Ondes Gril 23L')!;
    expect(libelle.canonical_key).not.toBe('modelName');
    // Le modèle de la fiche n'est jamais remplacé par celui d'un produit connexe.
    const etat = await entite.getCanonicalEntityState({ type: 'EQUIPMENT', id: micro }, c.id);
    expect(String(etat?.fields.modelName?.value ?? '')).not.toContain('MC32J7035AK');
    expect(String(etat?.fields.modelName?.value ?? '')).not.toBe('Micro-Ondes Gril 23L');
  });

  it('L101A-E2E-COH — contrôle COH-EQUIPMENT-IDENTITY : n° de série « prix » automatique réparé, valeur utilisateur protégée, modèles incompatibles en constat', async () => {
    const { c, micro, four } = await compteReel();
    const { equipmentIdentityCheck } = await import('@/services/coherence/registry/checks/equipment-identity');
    // Données héritées d'avant le lot (écrites hors writer : la normalisation les refuserait désormais).
    await sql`UPDATE equipments SET key_characteristics = coalesce(key_characteristics, '{}'::jsonb)
              || '{"serialNumber": "29,99 EUR", "serialNumber__origin": "DOCUMENT_EXTRACTION"}'::jsonb WHERE id = ${micro}`;
    await sql`UPDATE equipments SET key_characteristics = coalesce(key_characteristics, '{}'::jsonb)
              || '{"serialNumber": "29,99 EUR", "serialNumber__origin": "USER"}'::jsonb WHERE id = ${four}`;
    const ctx = { sql, now: new Date(), today: '2026-10-30', mode: 'CORRECTIVE' as const, correlationId: 'coherence:e2e:l101a' };
    const avant = await equipmentIdentityCheck.inspect!(ctx as never, c.id, [micro, four]);
    expect(avant.get(micro)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'IDENTITY_VALUE_INCOMPATIBLE' });
    expect(avant.get(four)).toMatchObject({ verdict: 'FINDING', anomaly: 'IDENTITY_VALUE_INCOMPATIBLE' });
    const rep = await equipmentIdentityCheck.repair!(ctx as never, c.id, [{ id: micro, inspection: avant.get(micro)! }]);
    expect(rep.get(micro)).toMatchObject({ called: true, service: 'writeCanonicalEntityFields' });
    const apres = await equipmentIdentityCheck.inspect!(ctx as never, c.id, [micro, four]);
    expect(apres.get(micro)).toEqual({ verdict: 'CONSISTENT' });
    expect(apres.get(four)?.verdict).toBe('FINDING');
    const [kc] = await sql<{ micro: string | null; four: string | null }[]>`
      SELECT (SELECT key_characteristics->>'serialNumber' FROM equipments WHERE id = ${micro}) AS micro,
             (SELECT key_characteristics->>'serialNumber' FROM equipments WHERE id = ${four}) AS four`;
    expect(kc.micro).toBeNull();
    expect(kc.four).toBe('29,99 EUR');
    // Deux modèles incompatibles établis par des documents : conflit conservé, aucune valeur choisie.
    const page = await document(c, null, 'Fiche Samsung', [
      { key: 'x', attribute: 'Modèle', value: 'MG23K3515AK', canonical: 'modelName', target: ['EQUIPMENT', micro] },
      { key: 'x', attribute: 'Modèle', value: 'MC32J7035AK', canonical: 'modelName', target: ['EQUIPMENT', micro] },
    ], 'web_link');
    await sql`INSERT INTO document_asset_links (account_id, file_id, equipment_id, link_role, origin, status) VALUES (${c.id}, ${page}, ${micro}, 'PRIMARY', 'USER', 'ACTIVE')`;
    const conflit = await equipmentIdentityCheck.inspect!(ctx as never, c.id, [micro]);
    expect(conflit.get(micro)).toMatchObject({ anomaly: 'SECONDARY_PRODUCT_ON_PAGE' });
    expect(['FINDING', 'AMBIGUOUS']).toContain(conflit.get(micro)!.verdict);
  });
});
