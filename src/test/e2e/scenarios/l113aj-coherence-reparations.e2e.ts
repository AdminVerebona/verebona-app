/**
 * Lot 113AJ — Trello #735 « [P1][Pré-MEP] Cohérence — Ne plus déclarer
 * « réparé » sans modification réelle (alerte #89) », sur PostgreSQL 16 réel :
 * orchestrateur de cohérence (campagnes manuelles), collecte réelle,
 * passerelle IA réelle avec T3 KNOWLEDGE_QUERY SIMULÉ, writer canonique réel,
 * journaux 0216 / 0770 / 0790, migration 1635, Supervision réelle.
 *
 * REPRODUCTION NEUTRE du constat du compte 10 (biens 31 et 32) : une analyse T3
 * qui s'abstient sur toutes les propriétés vides, ou une 3e panne IA, était
 * journalisée REPAIRED (recontrôle cohérent ou anomalie différente) sans
 * aucune clé dans `result.written`, et l'alerte « objets réparés de façon
 * répétée » comptait ces lignes.
 *
 *  L113AJ-E2E-01  analyse avec N abstentions (toutes les propriétés vides du bien, et d'un équipement) et 0 écrit :
 *                 0 réparation, issue ABSTAINED tracée (décisions, cause), preuve CONSISTENT ; trois contrôles à contexte
 *                 identique : aucun appel IA, aucune nouvelle ligne ; trois contextes successifs : pas d'alerte « réparé trois fois »
 *  L113AJ-E2E-02  au moins une écriture : une réparation REPAIRED avec la référence EXACTE de la ligne canonical_field_writes
 *  L113AJ-E2E-03  panne IA (fournisseur / disjoncteur), 3e panne (avant : REPAIRED), budget épuisé : FAILED explicite,
 *                 aucune réparation réussie, aucun appel artificiel
 *  L113AJ-E2E-04  historique : anciens REPAIRED sans écriture (dont un AI_FAILED) requalifiés à la lecture, journal intact ;
 *                 alerte ouverte AVANT → résolue APRÈS ; un résultat tronqué avec écriture compte toujours
 *  L113AJ-E2E-05  vraie valeur effacée puis restaurée trois fois : alerte pertinente, champ réécrit, même valeur, lignes
 *                 canonical_field_writes des restaurations et ÉCRIVAIN de l'effacement
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';
import { runCoherenceFor, proofOf } from '../coherence-run';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
type Preuve = { ref: string; layer: string; label: string | null; value: string | null; text: string | null };
type Candidat = { role: string; key: string };

const AUJ = '2026-11-10';
const CHECK = 'COH-MISSING-PROPERTIES';
const CHECK_EQ = 'COH-MISSING-PROPERTIES-EQUIPMENT';
const FP_REPETE = 'other:coherence:coh-missing-properties:repeated_repairs';
/** Valeur NEUTRE du test. */
const V = { ecrit: '246 802,00', nombre: 246802 };

const ligne = (prompt: string, etiquette: string): unknown => {
  const m = new RegExp(`^${etiquette} : (.*)$`, 'm').exec(prompt);
  return m ? JSON.parse(m[1]) : null;
};
const texteDe = (p: Preuve) => [p.label, p.value, p.text].filter(Boolean).join(' \n ');

/** T3 simulé générique : établit la valeur neutre de `cle` si un élément la porte ; sinon « non trouvé » pour toutes les propriétés. */
const modele = { appels: 0, candidats: [] as string[], cle: '', panne: null as string | null };
function repondre(input: { prompt: string }): unknown {
  const preuves = (ligne(input.prompt, 'Preuves candidates') ?? []) as Preuve[];
  const candidats = (ligne(input.prompt, 'Candidats') ?? []) as Candidat[];
  modele.appels += 1;
  modele.candidats.push(...candidats.map((c) => c.key));
  if (modele.panne) throw new Error(modele.panne);
  const vide = { task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'simulé' };
  if (!modele.cle || !candidats.some((c) => c.key === modele.cle)) return vide;
  const hits = preuves.filter((p) => texteDe(p).includes(V.ecrit));
  if (!hits.length) return vide;
  return {
    task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'simulé',
    findings: hits.slice(0, 5).map((h) => ({ target: modele.cle, rawValue: V.ecrit, evidenceRefs: [h.ref], excerpt: V.ecrit, confidence: 'certain', meaning: 'simulé (e2e)' })),
  };
}

scenario('L113AJ-COHERENCE-REPARATIONS', 'Cohérence : « réparé » seulement avec une modification réelle (lot 113AJ, alerte #89)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  const fichierT3 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
  let PRIX: { key: string };
  let enVigueur: Record<string, string | undefined> = {};

  const capacite = async () => {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: 99113, treatment: 'T3', versionNumber: 1131,
      content: `${fichierT3}\n\nBRANCHE TASK = KNOWLEDGE_QUERY\n\nContrat d’entrée accepté : t3-knowledge-query-v2.\n(Section de test e2e : réponse simulée.)\n` }]);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  };

  beforeAll(async () => {
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', repondre);
    const cat = await import('@/services/ai/reconciliation/missing-properties/catalog');
    const { listFields } = await import('@/services/canonical/registry');
    const sujet = { type: 'ASSET' as const, category: 'IMMOBILIER', subtype: null };
    PRIX = listFields('IMMOBILIER').find((d) => d.valueType === 'money_eur' && !cat.exclusionOf(d, sujet))!;
    expect(PRIX).toBeTruthy();
  });
  beforeEach(async () => {
    Object.assign(modele, { appels: 0, candidats: [], cle: '', panne: null });
    enVigueur = { b: process.env.T3_KNOWLEDGE_QUERY_DAILY_MAX, p: process.env.T3_MISSING_PROPERTIES_PER_CALL };
    process.env.T3_MISSING_PROPERTIES_PER_CALL = '40';
    await capacite();
  });
  afterAll(async () => {
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', null);
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  });
  const restaurerEnv = () => {
    for (const [cle, v] of [['T3_KNOWLEDGE_QUERY_DAILY_MAX', enVigueur.b], ['T3_MISSING_PROPERTIES_PER_CALL', enVigueur.p]] as const) {
      if (v === undefined) delete process.env[cle]; else process.env[cle] = v;
    }
  };

  // ── Outils ────────────────────────────────────────────────────────────────
  const compte = () => make.account({ plan: 'premium' });
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
  /** Document rattaché (bien ou équipement) dont la connaissance T1 porte la valeur neutre. */
  async function document(c: AccountRow, cible: { assetId: number } | { assetId: number; equipmentId: number }, title: string) {
    const f = await make.assetFile(c, { assetId: 'equipmentId' in cible ? null : cible.assetId });
    await sql`UPDATE asset_files SET retained_title = ${title}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    if ('equipmentId' in cible) {
      await sql`INSERT INTO document_asset_links (account_id, file_id, equipment_id, link_role, origin, status) VALUES (${c.id}, ${f.id}, ${cible.equipmentId}, 'PRIMARY', 'USER', 'ACTIVE')`;
    }
    const [{ id: ext }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${c.id}, ${f.id}, ${title}, NULL, '', 0) RETURNING id`;
    await sql`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, value_number, value_unit, confidence, excerpt)
      VALUES (${c.id}, ${f.id}, ${ext}, 'montant_convenu', 'Montant', ${V.ecrit}, ${V.nombre}, 'EUR', 'certain', ${`Montant convenu : ${V.ecrit} EUR`})`;
    return f.id;
  }
  const valeur = async (c: AccountRow, assetId: number) => {
    const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
    return (await getCanonicalAssetState(assetId, c.id))!.fields[PRIX.key]?.value ?? null;
  };
  const reparations = (c: AccountRow, check = CHECK) => sql<Json[]>`
    SELECT id::int AS id, object_id::int AS object_id, outcome, recheck_verdict, error, result, rollback_ref, ai_calls
      FROM coherence_repairs WHERE account_id = ${c.id} AND check_id = ${check} ORDER BY id`;
  const runs = (c: AccountRow) => sql<Json[]>`SELECT id::int AS id, status, cause, calls, attempts FROM property_recovery_runs WHERE account_id = ${c.id} ORDER BY id`;
  const decisions = (c: AccountRow) => sql<Json[]>`SELECT id::int AS id, field_key, decision, cause FROM property_recovery_decisions WHERE account_id = ${c.id} ORDER BY id`;
  const campagne = (c: AccountRow, today = AUJ) => runCoherenceFor(sql, [c.id], { mode: 'CORRECTIVE', today });
  const alertes = async () => (await import('@/services/coherence/supervision')).computeCoherenceAlerts(new Date(), sql);
  const repetee = async () => (await alertes()).find((a) => a.fingerprint === FP_REPETE) ?? null;
  const vise = (a: { detail: Record<string, unknown> } | null, c: AccountRow) => !!a && String(a.detail.accountIds ?? '').split(', ').includes(String(c.id));

  // ══ L113AJ-E2E-01 ═════════════════════════════════════════════════════════

  it('L113AJ-E2E-01 — N abstentions, 0 écrit : 0 réparation, issue tracée ; contexte inchangé sans IA ; jamais « réparé trois fois »', async () => {
    const c = await compte();
    const m = await maison(c);
    await document(c, { assetId: m.id }, 'Pièce 1');
    const r1 = await campagne(c);
    expect(r1.status).toBe('COMPLETE');
    expect(modele.appels).toBeGreaterThanOrEqual(1);
    expect(await valeur(c, m.id)).toBeNull();

    const [rep, ...autres] = await reparations(c);
    expect(autres).toEqual([]);
    const abstentions = (await decisions(c)).filter((d) => d.decision === 'ABSTAINED');
    expect(abstentions.length).toBeGreaterThanOrEqual(10);
    expect((await decisions(c)).filter((d) => d.decision === 'WRITTEN')).toEqual([]);
    // Avant 113AJ : outcome REPAIRED, result.written = []. Désormais : abstention justifiée, aucune réparation.
    expect(rep).toMatchObject({ outcome: 'ABSTAINED', recheck_verdict: 'CONSISTENT', error: null });
    expect(rep.result).toMatchObject({ effect: 'ABSTAINED', written: [], writes: [], status: 'ANSWERED', counts: { written: 0, abstained: abstentions.length, undecided: 0 } });
    expect(rep.result.abstained[0]).toEqual({ key: expect.any(String), cause: expect.any(String) });
    expect(rep.rollback_ref).toMatch(/^property_recovery_runs:ids=\d+/);
    expect((await runs(c)).find((r) => r.status === 'ANSWERED')).toBeTruthy();
    expect(await proofOf(sql, c.id, CHECK, m.id)).toMatchObject({ last_result: 'CONSISTENT' });
    expect(r1.results[CHECK]).toEqual({ CONSISTENT: 1 });

    // Trois contrôles successifs, contexte identique : aucun appel IA, aucune nouvelle réparation ni décision.
    const n = { appels: modele.appels, reps: (await reparations(c)).length, dec: (await decisions(c)).length, runs: (await runs(c)).length };
    for (let i = 0; i < 3; i++) await campagne(c, `2026-11-1${1 + i}`);
    expect({ appels: modele.appels, reps: (await reparations(c)).length, dec: (await decisions(c)).length, runs: (await runs(c)).length }).toEqual(n);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toMatchObject({ last_result: 'CONSISTENT' });

    // Trois contextes successifs (nouveau document à chaque fois), toujours sans valeur établie : 3 analyses, 0 réparation, pas d'alerte.
    await document(c, { assetId: m.id }, 'Pièce 2');
    await campagne(c);
    await document(c, { assetId: m.id }, 'Pièce 3');
    await campagne(c);
    const toutes = await reparations(c);
    expect(toutes.map((r) => r.outcome)).toEqual(['ABSTAINED', 'ABSTAINED', 'ABSTAINED']);
    expect(vise(await repetee(), c)).toBe(false);

    // Variante ÉQUIPEMENTS : même qualification.
    const ce = await compte();
    const me = await maison(ce);
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${me.id}, 'Appareil') RETURNING id`;
    await document(ce, { assetId: me.id, equipmentId: eq }, 'Pièce de l’appareil');
    await campagne(ce);
    const [repEq] = await reparations(ce, CHECK_EQ);
    expect(repEq).toMatchObject({ object_id: eq, outcome: 'ABSTAINED' });
    expect(repEq.result).toMatchObject({ effect: 'ABSTAINED', written: [] });
    expect(await proofOf(sql, ce.id, CHECK_EQ, eq)).toMatchObject({ last_result: 'CONSISTENT' });
  });

  // ══ L113AJ-E2E-02 ═════════════════════════════════════════════════════════

  it('L113AJ-E2E-02 — au moins une écriture : une réparation réelle, référence exacte à canonical_field_writes', async () => {
    const c = await compte();
    const m = await maison(c);
    await document(c, { assetId: m.id }, 'Pièce 1');
    modele.cle = PRIX.key;
    await campagne(c);
    expect(await valeur(c, m.id)).toBe(V.nombre);
    const [rep, ...autres] = await reparations(c);
    expect(autres).toEqual([]);
    const ecritures = await sql<Json[]>`
      SELECT id::int AS id, canonical_key, new_value, origin, source_type, source_id FROM canonical_field_writes
       WHERE account_id = ${c.id} AND asset_id = ${m.id} AND outcome = 'written' ORDER BY id`;
    expect(ecritures).toHaveLength(1);
    const [d] = (await decisions(c)).filter((x) => x.decision === 'WRITTEN');
    expect(rep).toMatchObject({ outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT' });
    expect(rep.result).toMatchObject({
      effect: 'WRITTEN', written: [PRIX.key], counts: { written: 1 },
      writes: [{ key: PRIX.key, canonicalWriteId: ecritures[0].id, decisionId: d.id, runId: expect.any(Number) }],
    });
    expect(ecritures[0]).toMatchObject({ canonical_key: PRIX.key, new_value: V.nombre, origin: 'RECONCILIATION', source_type: 'coherence_missing_property',
      source_id: `COH-MISSING-PROPERTIES:${rep.result.writes[0].runId}` });
    expect(rep.rollback_ref).toBe(`canonical_field_writes:ids=${ecritures[0].id};property_recovery_decisions:ids=${d.id}`);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toMatchObject({ last_result: 'REPAIRED' });
    // Idempotence : contrôle suivant, rien de nouveau.
    const appels = modele.appels;
    await campagne(c);
    expect(modele.appels).toBe(appels);
    expect(await reparations(c)).toHaveLength(1);
  });

  // ══ L113AJ-E2E-03 ═════════════════════════════════════════════════════════

  it('L113AJ-E2E-03 — panne IA / disjoncteur / 3e panne / budget : FAILED explicite, jamais une réparation réussie', async () => {
    try {
      // Panne du fournisseur (même chemin que l'ouverture du disjoncteur : l'appel modèle lève).
      const c = await compte();
      const m = await maison(c);
      await document(c, { assetId: m.id }, 'Pièce 1');
      modele.panne = 'fournisseur indisponible (simulé) — disjoncteur ouvert';
      await campagne(c, '2037-09-15');
      const [r1] = await reparations(c);
      expect(r1).toMatchObject({ outcome: 'FAILED' });
      expect(r1.error).toMatch(/^AI_FAILED: AI_CALL_FAILED/);
      expect(r1.result).toMatchObject({ effect: 'TECHNICAL_FAILURE', status: 'AI_FAILED', written: [] });
      expect(await proofOf(sql, c.id, CHECK, m.id)).not.toMatchObject({ last_result: 'REPAIRED' });

      // 3e panne sur le même contexte : avant 113AJ, recontrôle « ARBITRATION_FAILED » ≠ anomalie d'origine → REPAIRED.
      await sql`UPDATE property_recovery_runs SET attempts = 2, retry_at = now() - interval '1 minute' WHERE account_id = ${c.id} AND status = 'AI_FAILED'`;
      await campagne(c, '2037-09-16');
      const [, r2] = await reparations(c);
      expect(r2).toMatchObject({ outcome: 'FAILED', recheck_verdict: 'FINDING' });
      expect(r2.result).toMatchObject({ effect: 'TECHNICAL_FAILURE', status: 'AI_FAILED' });
      const p = (await proofOf(sql, c.id, CHECK, m.id))!;
      expect(p).toMatchObject({ last_result: 'FINDING' });
      expect(p.finding).toMatchObject({ anomaly: 'MISSING_PROPERTY_ARBITRATION_FAILED' });
      // Tentatives épuisées : aucun appel artificiel ensuite.
      const appels = modele.appels;
      modele.panne = null;
      await campagne(c, '2037-09-17');
      expect(modele.appels).toBe(appels);
      expect((await reparations(c)).filter((r) => r.outcome === 'REPAIRED')).toEqual([]);
      expect(await valeur(c, m.id)).toBeNull();

      // Budget épuisé : aucun appel, état technique explicite.
      process.env.T3_KNOWLEDGE_QUERY_DAILY_MAX = '0';
      const cb = await compte();
      const mb = await maison(cb);
      await document(cb, { assetId: mb.id }, 'Pièce 1');
      const avant = modele.appels;
      await campagne(cb);
      expect(modele.appels).toBe(avant);
      const [rb] = await reparations(cb);
      expect(rb).toMatchObject({ outcome: 'FAILED', ai_calls: 0 });
      expect(rb.error).toMatch(/^BUDGET_EXHAUSTED: DAILY_BUDGET/);
      expect(rb.result).toMatchObject({ effect: 'TECHNICAL_FAILURE', status: 'BUDGET_EXHAUSTED', written: [] });
    } finally {
      restaurerEnv();
    }
  });

  // ══ L113AJ-E2E-04 ═════════════════════════════════════════════════════════

  it('L113AJ-E2E-04 — historique : anciens REPAIRED sans écriture requalifiés à la lecture, journal intact ; alerte avant → résolue après', async () => {
    const c = await compte();
    const m = await maison(c);
    const ancien = (result: unknown, jours: number) => sql`
      INSERT INTO coherence_repairs (account_id, check_id, check_version, object_type, object_id, trigger_code, anomaly, service, result, outcome, recheck_verdict, created_at)
      VALUES (${c.id}, ${CHECK}, 2, 'asset', ${m.id}, 'DAILY', 'MISSING_PROPERTIES_UNEXAMINED', 'recoverMissingProperties', ${JSON.stringify(result)}::jsonb, 'REPAIRED', 'CONSISTENT',
              now() - make_interval(days => ${jours}))`;
    // Comme la Maison #32 : 7 REPAIRED en 7 jours, dont 1 seule écriture et 1 AI_FAILED.
    for (let i = 0; i < 5; i++) await ancien({ status: 'ANSWERED', written: [], abstained: [{ key: `k${i}`, cause: 'NOT_FOUND' }], undecided: [] }, i);
    await ancien({ status: 'AI_FAILED', cause: 'AI_CALL_FAILED: simulé', written: [], abstained: [], undecided: ['k'] }, 5);
    await ancien({ status: 'ANSWERED', written: [PRIX.key], abstained: [], undecided: [] }, 6);
    const journal = async () => sql<Json[]>`SELECT id, outcome, result FROM coherence_repairs WHERE account_id = ${c.id} ORDER BY id`;
    const avant = await journal();
    expect(avant).toHaveLength(7);

    // AVANT 113AJ (décompte brut des lignes REPAIRED) : l'objet aurait déclenché l'alerte.
    const [brut] = await sql<Json[]>`SELECT count(*)::int AS n FROM coherence_repairs WHERE account_id = ${c.id} AND outcome = 'REPAIRED' AND created_at >= now() - interval '7 days'`;
    expect(brut.n).toBeGreaterThanOrEqual(3);
    const { reportAnomaly } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({ domain: 'other', fingerprint: FP_REPETE, title: `Cohérence ${CHECK} : objets réparés de façon répétée (1)`, detail: { checkId: CHECK, accountIds: String(c.id) } });
    const ouverte = async () => (await sql<Json[]>`SELECT status FROM admin_anomalies WHERE fingerprint = ${FP_REPETE} ORDER BY id DESC LIMIT 1`)[0]?.status ?? null;
    expect(await ouverte()).toBe('open');

    // APRÈS : requalifié à la lecture — pas d'alerte pour ce compte ; Supervision : alerte résolue (décompte revenu à zéro).
    expect(vise(await repetee(), c)).toBe(false);
    const { syncCoherenceSupervision } = await import('@/services/coherence/supervision');
    // Aucune vraie réparation répétée dans ce scénario à ce stade (E2E-01 à 03 : abstentions, une écriture, échecs).
    expect(await repetee()).toBeNull();
    await syncCoherenceSupervision({ sql });
    expect(await ouverte()).not.toBe('open');
    // Journal d'audit intact (aucune ligne modifiée ni supprimée).
    expect(await journal()).toEqual(avant);

    // Un résultat BORNÉ (tronqué) portant une écriture compte toujours comme réparation réelle.
    const ct = await compte();
    const mt = await maison(ct);
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO coherence_repairs (account_id, check_id, check_version, object_type, object_id, trigger_code, anomaly, service, result, outcome)
        VALUES (${ct.id}, ${CHECK}, 2, 'asset', ${mt.id}, 'DAILY', 'MISSING_PROPERTIES_UNEXAMINED', 'recoverMissingProperties',
                ${JSON.stringify({ truncated: true, excerpt: `{"status":"ANSWERED","cause":null,"persisted":true,"written":["${PRIX.key}"],"abstained":[` })}::jsonb, 'REPAIRED') RETURNING id`;
      ids.push(Number(id));
    }
    expect(vise(await repetee(), ct)).toBe(true);
    await sql`DELETE FROM coherence_repairs WHERE id = ANY(${ids}::bigint[])`;
  });

  // ══ L113AJ-E2E-05 ═════════════════════════════════════════════════════════

  it('L113AJ-E2E-05 — vraie valeur effacée puis restaurée trois fois : alerte pertinente avec preuves avant / après et origine', async () => {
    const c = await compte();
    const m = await maison(c);
    modele.cle = PRIX.key;
    const canon = await import('@/services/canonical/asset-state');
    const effaceurs: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const doc = await document(c, { assetId: m.id }, `Pièce ${i}`);
      await campagne(c);
      expect(await valeur(c, m.id)).toBe(V.nombre);
      if (i < 3) {
        // Un traitement automatique remet la valeur à vide (écrivain journalisé dans canonical_field_writes).
        const w = await canon.writeCanonicalAssetFields({ assetId: m.id, accountId: c.id, origin: 'DOCUMENT_EXTRACTION', source: { type: 'document', id: doc }, writes: [{ key: PRIX.key, value: null }] });
        expect(w.fields[0]).toMatchObject({ outcome: 'written' });
        effaceurs.push(doc);
        expect(await valeur(c, m.id)).toBeNull();
      }
    }
    const reps = await reparations(c);
    expect(reps.map((r) => r.outcome)).toEqual(['REPAIRED', 'REPAIRED', 'REPAIRED']);
    const restaurations = await sql<Json[]>`
      SELECT id::int AS id FROM canonical_field_writes WHERE account_id = ${c.id} AND asset_id = ${m.id} AND source_type = 'coherence_missing_property' AND outcome = 'written' ORDER BY id`;
    const effacements = await sql<Json[]>`
      SELECT id::int AS id FROM canonical_field_writes WHERE account_id = ${c.id} AND asset_id = ${m.id} AND origin = 'DOCUMENT_EXTRACTION' AND outcome = 'written' ORDER BY id`;
    expect(reps.map((r) => r.result.writes[0].canonicalWriteId)).toEqual(restaurations.map((r) => r.id));

    const a = (await repetee())!;
    expect(a).toBeTruthy();
    expect(vise(a, c)).toBe(true);
    expect(a.title).toMatch(/^Cohérence COH-MISSING-PROPERTIES : objets réparés de façon répétée \(\d+\)$/);
    expect(a.detail.counting).toMatch(/réparations réelles seulement/);
    const preuve = (a.detail.evidence as Json[]).find((o) => o.accountId === c.id && o.objectId === m.id)!;
    expect(preuve).toMatchObject({ realRepairs: 3 });
    expect(preuve.fields).toEqual([expect.objectContaining({
      key: PRIX.key, restorations: 3, sameValue: true, values: [String(V.nombre)], canonicalWriteIds: restaurations.map((r) => r.id), erasure: 'JOURNALED',
      erasedBy: effacements.map((e, i) => expect.objectContaining({ canonicalWriteId: e.id, origin: 'DOCUMENT_EXTRACTION', source: `document:${effaceurs[i]}`, byUser: false, before: String(V.nombre) })),
    })]);
    expect(String(a.detail.summary)).toContain(`Compte ${c.id} · bien ${m.id} : « ${PRIX.key} » restauré 3 fois (même valeur ${V.nombre})`);
    expect(String(a.detail.summary)).toContain(`remis à vide par DOCUMENT_EXTRACTION (document:${effaceurs[0]})`);
  });
});
