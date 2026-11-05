/**
 * Lot 109J — T3 DOCUMENT_NAMING, rejeu ISOLÉ de la situation T3:6033 sur
 * PostgreSQL réel : vraie phase de nommage, vraie passerelle IA (contrat
 * runtime, schéma fournisseur, politique de secours), vrai journal d'usage ;
 * fournisseur SIMULÉ (aucun réseau).
 *
 *   · L109J-E2E-01 — 25 titres déjà conformes : zéro appel IA, zéro renommage ;
 *   · L109J-E2E-02 — sortie TRONQUÉE (plafond atteint, raisonnement compris) :
 *     re-partition automatique, aucun appel identique rejoué, progression
 *     mesurable, lot terminé, réponses `document_renames: []` acceptées ;
 *   · L109J-E2E-03 — échec persistant : reprise bornée et croissante,
 *     `nextRetryAt` visible, anomalie BO après N échecs, résolue au succès ;
 *   · L109J-E2E-04 — plusieurs familles sous un même assureur, titre USER :
 *     pas de fusion, titre USER intact, aucun doublon de renommage à la reprise.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { scenario } from '../scenario';

interface DocIA { documentId: number; role: 'TO_EXAMINE' | 'REFERENCE'; currentName: string; nameOrigin: string; renameAllowed: boolean; facts?: unknown[] }
type Reponse = { rawText: string; inputTokens: number; outputTokens: number; meta?: Record<string, unknown> } | Error;

const modele = {
  repondre: (_docs: DocIA[]): Reponse => ({ rawText: JSON.stringify({ task: 'DOCUMENT_NAMING', families: [], document_renames: [] }), inputTokens: 300, outputTokens: 40 }),
  appels: [] as Array<{ ids: string; docs: DocIA[]; structured: boolean }>,
  /** Requêtes sans liste de candidats (passe de réparation) : comptées à part. */
  autres: 0,
};
/** Refus 400 nommant un paramètre : récupérable, sans effet sur le disjoncteur (tests indépendants). */
const refus400 = () => Object.assign(new Error('{"error":{"code":400,"message":"Invalid value at \'generation_config.max_output_tokens\'","status":"INVALID_ARGUMENT"}}'), { status: 400 });

function fournisseur() {
  return {
    name: 'simule-l109j',
    isConfigured: () => true,
    async call(input: { prompt: string; operationCode?: string; responseSchema?: unknown; model?: string; maxOutputTokens?: number }) {
      if (input.operationCode !== 't3_document_naming') throw new Error(`appel inattendu : ${input.operationCode}`);
      const m = /^Candidats : (.*)$/m.exec(input.prompt);
      if (!m) { modele.autres++; return { rawText: '{"task":"DOCUMENT_NAMING"', inputTokens: 100, outputTokens: 10, meta: { finishReason: 'MAX_TOKENS' } }; }
      const docs = JSON.parse(m[1]) as DocIA[];
      modele.appels.push({
        ids: `${input.model}|${input.maxOutputTokens ?? '-'}|${docs.map((d) => `${d.role[0]}${d.documentId}`).sort().join(',')}`, docs, structured: input.responseSchema !== undefined,
      });
      const r = modele.repondre(docs);
      if (r instanceof Error) throw (r as { status?: number }).status ? r : Object.assign(r, { status: 500 });
      return r;
    },
  };
}
const vide = (familles: unknown[] = []) => JSON.stringify({ task: 'DOCUMENT_NAMING', families: familles, document_renames: [] });

scenario('L109J-T3-NOM', 'Lot 109J — T3 DOCUMENT_NAMING : lots adaptatifs, préfiltre, reprise bornée (cas 6033)', ({ sql, make }) => {
  const env0 = { ...process.env };
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(fournisseur() as never);
  });
  beforeEach(async () => {
    modele.repondre = () => ({ rawText: vide(), inputTokens: 300, outputTokens: 40 });
    modele.appels.length = 0;
    modele.autres = 0;
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    process.env.T3_NAMING_MAX_CALLS_PER_PASS = '20';
    process.env.T3_NAMING_MAX_CALLS_PER_DAY = '200';
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('T3_NAMING_') && env0[k] === undefined) delete process.env[k];
  });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  async function document(c: { id: number; ownerUserId: number }, o: {
    nom: string; fournisseur?: string; type?: string; date: string; source?: 'SYSTEM' | 'USER'; origineT1?: boolean; contrat?: string;
  }) {
    const fournisseurNom = o.fournisseur ?? 'Assurances des Alpes';
    const [f] = await sql<Array<{ id: number }>>`
      INSERT INTO asset_files (user_id, account_id, s3_key, mime_type, retained_title, supplier, document_type_code, document_date,
                               analysis_state, last_analysis_at, title_source, title_rule_version, title_context_fingerprint, title_checked_at)
      VALUES (${c.ownerUserId}, ${c.id}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'application/pdf', ${o.nom},
              ${fournisseurNom}, ${o.type ?? 'INVOICE'}, ${o.date}, 'ANALYZED', now() - interval '1 hour', ${o.source ?? 'SYSTEM'}, 2, 'e2e', now())
      RETURNING id`;
    const [e] = await sql<Array<{ id: number }>>`
      INSERT INTO document_extractions (account_id, file_id, title, supplier_name, document_date, document_type_code, full_text, full_text_chars, extracted_at)
      VALUES (${c.id}, ${f.id}, ${o.nom}, ${fournisseurNom}, ${o.date}, ${o.type ?? 'INVOICE'}, ${`Document ${fournisseurNom}`}, 30, now() - interval '1 hour')
      RETURNING id`;
    if (o.origineT1 !== false) {
      await sql`INSERT INTO document_title_events (account_id, file_id, origin, outcome, old_title, new_title, created_at)
                VALUES (${c.id}, ${f.id}, 'T1', 'UPDATED', 'scan.pdf', ${o.nom}, now() - interval '2 hours')`;
    }
    if (o.contrat) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, canonical_key)
                VALUES (${c.id}, ${f.id}, ${e.id}, 'contractNumber', 'contractNumber', ${o.contrat}, 'high', ${o.contrat}, 'contractNumber')`;
    }
    return Number(f.id);
  }
  const passer = async (accountId: number) => (await import('@/services/ai/reconciliation/document-naming/phase')).runDocumentNamingPhase(accountId);
  const etats = (accountId: number) => sql<Array<{ group_key: string; status: string; retry_after: Date | null; attempts: number; progress: Record<string, unknown> | null; last_error: string | null }>>`
    SELECT group_key, status, retry_after, attempts, progress, last_error FROM document_naming_groups WHERE account_id = ${accountId} AND group_key <> '*' ORDER BY group_key`;
  const nom = async (id: number) => (await sql<Array<{ t: string }>>`SELECT retained_title AS t FROM asset_files WHERE id = ${id}`)[0].t;
  const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

  it('L109J-E2E-01 — 25 titres déjà conformes (origine T1) : zéro appel IA, zéro renommage, lot terminé', async () => {
    const c = await make.account();
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(await document(c, { nom: `Facture Homiris — ${MOIS[i % 12]} ${2024 + Math.floor(i / 12)}`, fournisseur: 'Homiris', date: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-05` }));
    }
    const avant = await Promise.all(ids.map(nom));
    const r = await passer(c.id);
    expect(modele.appels).toHaveLength(0);
    expect(r).toMatchObject({ aiCalls: 0, applied: 0, proposals: 0, documentsPrefiltered: 25 });
    expect(await Promise.all(ids.map(nom))).toEqual(avant);
    expect((await etats(c.id)).map((s) => s.status)).toEqual(['DONE']);
    expect(r.status).toBe('DONE');
  });

  it('L109J-E2E-02 — sortie tronquée au plafond : lot redécoupé et rejoué, jamais un appel identique, progression jusqu’au terme', async () => {
    const c = await make.account();
    // 25 pièces d'un même assureur, noms hétérogènes (aucun préfiltre), origine inconnue.
    for (let i = 0; i < 25; i++) await document(c, { nom: i % 2 ? `avis echeance ${i}` : `Assurance ${i} - echeance`, date: `2026-01-${String(i + 1).padStart(2, '0')}`, origineT1: false });
    // Le simulateur tronque toute réponse portant plus de 5 documents (raisonnement : 7 800 jetons).
    modele.repondre = (docs) => (docs.length > 5
      ? { rawText: '{"task":"DOCUMENT_NAMING","families":[{"label":"Avis', inputTokens: 48_312, outputTokens: 324, meta: { finishReason: 'MAX_TOKENS', thoughtsTokens: 7_868 } }
      : { rawText: vide(), inputTokens: 4_000, outputTokens: 60, meta: { finishReason: 'STOP' } });
    const r = await passer(c.id);
    // Aucun appel identique rejoué : un même jeu de documents n'est jamais renvoyé au même modèle avec le
    // même plafond (un secours de plafond SUPÉRIEUR, capable de traiter la cause, reste admis par la politique 87A).
    const jeux = modele.appels.map((a) => a.ids);
    expect(new Set(jeux).size).toBe(jeux.length);
    // Tailles décroissantes jusqu'à un lot accepté.
    const tailles = modele.appels.map((a) => a.docs.length);
    expect(tailles[0]).toBeGreaterThan(5);
    expect(tailles.some((t) => t <= 5)).toBe(true);
    expect(r.repartitions ?? 0).toBeGreaterThan(0);
    expect(r.documentsExamined).toBe(25);
    expect((await etats(c.id)).map((s) => s.status)).toEqual(['DONE']);
    // Journal d'usage : sortie visible et raisonnement distincts ; secours non sollicités jamais comptés comme générations.
    const usage = await sql<Array<{ status: string; error_code: string | null; output_tokens: number; metadata: { providerMeta?: { finishReason?: string; thoughtsTokens?: number } } }>>`
      SELECT status, error_code, output_tokens, metadata FROM ai_usage_event WHERE account_id = ${c.id} AND operation_code = 't3_document_naming' ORDER BY id`;
    const tronque = usage.find((u) => u.metadata.providerMeta?.finishReason === 'MAX_TOKENS');
    expect(tronque).toMatchObject({ output_tokens: 324, metadata: { providerMeta: { thoughtsTokens: 7_868 } } });
    const requetes = usage.filter((u) => !['FALLBACK_NOT_ADMISSIBLE', 'MODEL_KNOWN_UNAVAILABLE'].includes(u.error_code ?? '')).length;
    expect(requetes).toBe(modele.appels.length + modele.autres);
  });

  it('L109J-E2E-03 — échec persistant : reprise bornée (30 min, 1 h…), nextRetryAt visible, anomalie BO au 4e échec puis résolue', async () => {
    const c = await make.account();
    for (let i = 0; i < 3; i++) await document(c, { nom: `pièce ${i} alpes`, date: `2026-02-0${i + 1}`, origineT1: false });
    modele.repondre = () => refus400();
    const delais: number[] = [];
    let r = await passer(c.id);
    for (let k = 0; k < 4; k++) {
      const [st] = await etats(c.id);
      expect(st.status).toBe('ERROR');
      const retry = new Date(st.retry_after as unknown as string);
      expect(r.remaining.nextRetryAt).toBe(retry.toISOString());
      delais.push(retry.getTime() - Date.now());
      // Reprise échue : le lot redevient dû (simulation du temps écoulé).
      await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id} AND group_key <> '*'`;
      if (k < 3) r = await passer(c.id);
    }
    expect(delais[1]).toBeGreaterThan(delais[0]);
    expect(delais[0]).toBeLessThanOrEqual(31 * 60_000);
    const anomalies = await sql<Array<{ status: string }>>`SELECT status FROM admin_anomalies WHERE account_id = ${c.id} AND domain = 'ai' AND fingerprint LIKE '%t3-document-naming%'`;
    expect(anomalies.map((a) => a.status)).toEqual(['open']);
    expect(r.persistentFailures).toBe(1);
    // Retour à la normale : lot terminé, anomalie résolue automatiquement.
    modele.repondre = () => ({ rawText: vide(), inputTokens: 300, outputTokens: 40 });
    const fin = await passer(c.id);
    expect(fin.status).toBe('DONE');
    const apres = await sql<Array<{ status: string }>>`SELECT status FROM admin_anomalies WHERE account_id = ${c.id} AND domain = 'ai' AND fingerprint LIKE '%t3-document-naming%'`;
    expect(apres.map((a) => a.status)).toEqual(['resolved']);
  });

  it('L109J-E2E-04 — même assureur, contrats distincts, titre USER : USER intact, renommages uniques après reprise', async () => {
    const c = await make.account();
    const pno = await document(c, { nom: 'pno echeance', date: '2026-01-10', contrat: 'PNO-21', origineT1: false });
    const pno2 = await document(c, { nom: 'Avis d’échéance PNO n°21 — 2025', date: '2025-01-10', contrat: 'PNO-21', origineT1: false });
    const auto = await document(c, { nom: 'Mon contrat voiture', date: '2026-02-01', contrat: 'AUTO-31', source: 'USER' });
    const auto2 = await document(c, { nom: 'auto 31 echeance', date: '2026-03-01', contrat: 'AUTO-31', origineT1: false });
    let enPanne = true;
    modele.repondre = (docs) => {
      const cibles = docs.filter((d) => d.role === 'TO_EXAMINE');
      const props = cibles.filter((d) => [pno, auto, auto2].includes(d.documentId)).map((d) => ({
        document_id: d.documentId, expected_current_name: d.currentName,
        proposed_name: d.documentId === pno ? 'Avis d’échéance PNO n°21 — 2026' : d.documentId === auto ? 'Contrat auto n°31' : 'Avis d’échéance auto n°31 — 2026',
        reason: 'Convention de la famille', confidence: 'certain',
      }));
      if (enPanne) return refus400();
      return { rawText: JSON.stringify({ task: 'DOCUMENT_NAMING', document_renames: props }), inputTokens: 900, outputTokens: 200 };
    };
    const r1 = await passer(c.id);
    expect(r1.errors).toBeGreaterThan(0);
    expect(r1.applied).toBe(0);
    enPanne = false;
    await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id} AND group_key <> '*'`;
    await passer(c.id);
    await passer(c.id);
    expect(await nom(auto)).toBe('Mon contrat voiture');
    expect(await nom(pno)).toBe('Avis d’échéance PNO n°21 — 2026');
    expect(await nom(pno2)).toBe('Avis d’échéance PNO n°21 — 2025');
    const ev = await sql<Array<{ file_id: number; outcome: string }>>`SELECT file_id, outcome FROM document_rename_events WHERE account_id = ${c.id} AND outcome = 'APPLIED'`;
    const parDoc = new Map<number, number>();
    for (const e of ev) parDoc.set(e.file_id, (parDoc.get(e.file_id) ?? 0) + 1);
    for (const n of parDoc.values()) expect(n).toBe(1);
    expect(parDoc.has(auto)).toBe(false);
  });

  it('L111A-E1-02 — famille dont tous les titres sont « conformes », puis nouvelle donnée discriminante sur UN document : ce document est examiné (les autres en référence), jamais préfiltré à tort ; puis stable', async () => {
    const c = await make.account();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(await document(c, { nom: `Facture Homiris — ${MOIS[i]} 2024`, fournisseur: 'Homiris', date: `2024-${String(i + 1).padStart(2, '0')}-05` }));
    const r1 = await passer(c.id);
    expect(r1).toMatchObject({ aiCalls: 0, documentsPrefiltered: 4, status: 'DONE' });
    const [e] = await sql<Array<{ id: number }>>`SELECT id FROM document_extractions WHERE file_id = ${ids[2]}`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, canonical_key)
              VALUES (${c.id}, ${ids[2]}, ${e.id}, 'avenant', 'avenant', 'Avenant n° AV-2024-7788', 'high', 'Avenant n° AV-2024-7788', NULL)`;
    const r2 = await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    const docs = modele.appels[0].docs;
    expect(docs.filter((d) => d.role === 'TO_EXAMINE').map((d) => d.documentId)).toEqual([ids[2]]);
    expect(docs.filter((d) => d.role === 'REFERENCE').map((d) => d.documentId).sort((a, b) => a - b)).toEqual([ids[0], ids[1], ids[3]].sort((a, b) => a - b));
    expect(r2).toMatchObject({ aiCalls: 1, documentsPrefiltered: 3, status: 'DONE' });
    expect((await etats(c.id)).map((s) => s.status)).toEqual(['DONE']);
    const r3 = await passer(c.id);
    expect(r3.aiCalls).toBe(0);
    expect(modele.appels).toHaveLength(1);
  });
});
