/**
 * Lot 109E — ticket « [P1] T6 EVALUATE — Corriger la perte de sens dans
 * l’empreinte des preuves » — de bout en bout sur PostgreSQL 16 réel : vrai
 * collecteur, vraie décision, vraie passerelle IA, vraie persistance, vraie
 * file de pré-génération. Modèle SIMULÉ (aucun réseau), qui juge selon
 * l’extrait qu’il REÇOIT ; appels EVALUATE COMPTÉS.
 *
 *  AC01/AC02  « et » → « ou » dans l’extrait (valeur, confiance, identifiants inchangés) :
 *             décision invalidée (CONTEXT_CHANGED, cause tracée), jamais affichée avant sa
 *             réévaluation, remplacée, puis réutilisée (accueil et pré-génération)
 *  AC04       relecture, réextraction identique, casse et espaces : aucun appel
 *  AC05       décision v4 persistée : jamais réutilisée ni rebasée, réévaluée UNE fois
 *             (FINGERPRINT_UPGRADE) ; reprise bornée par le budget, pré-génération différée
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

interface Fait { ref: string; excerpt: string | null; value: string | null }
interface Candidat { subjectId: string; title: string; facts?: Fait[]; evidence: Array<{ ref: string; kind: string }> }

const modele = vi.hoisted(() => ({
  juger: (_c: Candidat): Record<string, unknown> | null => null,
  candidats: [] as Candidat[][],
}));

function provider() {
  return {
    name: 'simule-l109e',
    isConfigured: () => true,
    async call(input: { prompt: string }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      if (mode === 'EVALUATE') {
        const ctx = JSON.parse(/Candidats à évaluer : (.*)\n/.exec(input.prompt)![1]) as { candidates: Candidat[] };
        modele.candidats.push(ctx.candidates);
        const decisions = ctx.candidates.map((c) => ({
          subjectId: c.subjectId, expectedAction: null, actionDeadline: null, suggestedReviewAt: null, uncertainties: [],
          evidenceRefs: [c.evidence.find((x) => x.kind === 'DUE_DATE')?.ref ?? c.evidence[0].ref],
          ...(modele.juger(c) ?? AUCUNE),
        }));
        return { rawText: JSON.stringify({ schemaVersion: 't6-evaluation-v1', decisions }), inputTokens: 200, outputTokens: 60 };
      }
      if (mode !== 'FORMULATE') throw new Error('appel inattendu');
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      return {
        rawText: JSON.stringify({ schemaVersion: 't6-output-v2', messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })), suggestions: [] }),
        inputTokens: 200, outputTokens: 60,
      };
    },
  };
}

const AUCUNE = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.', priorityHint: 'LOW' };
const AGIR = { decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire à court terme.', expectedAction: 'Prendre rendez-vous avec le prestataire', priorityHint: 'MEDIUM' };
/** Le modèle juge sur l'extrait reçu : cumul (« et ») → agir ; alternative (« ou ») → rien. */
const surConjonction = (c: Candidat) => ((c.facts ?? []).some((f) => /\bou\b/i.test(f.excerpt ?? '')) ? AUCUNE : AGIR);

const ET = 'L’entretien et la réparation sont inclus.';
const OU = 'L’entretien ou la réparation sont inclus.';

scenario('L109E-T6', 'Lot 109E — empreinte EVALUATE v5 sans perte de sens', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.juger = surConjonction; modele.candidats.length = 0;
    delete process.env.MASCOT_T6_UPGRADE_PER_MINUTE;
    (await import('@/services/home/mascot/t6-fingerprint-upgrade')).resetT6UpgradeBudget();
    const R = await import('@/services/home/mascot/t6-runner');
    R.resetT6Breaker(); R.resetT6EvaluationState(); R.resetT6EvaluationBaselines();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    await sql`DELETE FROM home_mascot_pregen_requests`;
  });
  afterEach(async () => {
    delete process.env.MASCOT_T6_UPGRADE_PER_MINUTE;
    (await import('@/services/home/mascot/t6-fingerprint-upgrade')).resetT6UpgradeBudget();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
  });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');
  const passer = async (accountId: number, userId: number | null = null) => (await svc()).getMascotPresentation(accountId, 'pregen', userId);
  const afficher = async (accountId: number, userId: number) => (await svc()).getMascotPresentation(accountId, 'display', userId);
  const affichees = (p: import('@/services/home/mascot/types').MascotPresentation) => p.paragraphs.filter((x) => x.reminder != null).map((x) => x.reminder!.agendaItemId);
  const evalues = () => modele.candidats.flat();
  const attendreAppel = async (avant: number) => {
    for (let i = 0; i < 100 && modele.candidats.length === avant; i += 1) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 150));
  };

  async function compte() {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: 'Maison Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    return { ...a, maison: maison.id };
  }
  async function echeance(c: { id: number; ownerUserId: number; maison: number }, titre: string, date: string) {
    const e = await make.agendaItem(c as never, { title: titre, startDate: date, assetIds: [c.maison] });
    await sql`UPDATE agenda_items SET home_category = 'action' WHERE id = ${e.id}`;
    return e.id;
  }
  async function contrat(c: { id: number; ownerUserId: number; maison: number }, agendaItemId: number) {
    const f = await make.assetFile(c as never, { assetId: c.maison });
    await sql`UPDATE asset_files SET retained_title = 'Contrat d’entretien', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${agendaItemId}, ${f.id})`;
    const [x] = await sql<[{ id: number }]>`INSERT INTO document_extractions (account_id, file_id, title) VALUES (${c.id}, ${f.id}, 'Contrat d’entretien') RETURNING id`;
    return { fileId: f.id, extractionId: Number(x.id) };
  }
  /** (Ré)extraction : faits précédents remplacés par un NOUVEAU fait (nouvel identifiant), même clé, valeur et confiance. */
  async function extraire(c: { id: number }, doc: { fileId: number; extractionId: number }, excerpt: string) {
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${doc.fileId} AND account_id = ${c.id}`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt)
              VALUES (${c.id}, ${doc.fileId}, ${doc.extractionId}, 'maintenanceCoverage', 'Prestations d’entretien incluses', 'Inclus', 'Inclus', 'certain', ${excerpt})`;
  }
  const decision = async (accountId: number, agendaItemId: number) => (await sql<Array<{
    decision: string; context_fingerprint: string; reevaluation_reason: string | null; evidence_snapshot: { components?: Record<string, string> } | null;
  }>>`SELECT decision, context_fingerprint, reevaluation_reason, evidence_snapshot FROM t6_interpellation_assessments
       WHERE account_id = ${accountId} AND agenda_item_id = ${agendaItemId}`)[0] ?? null;
  /** Empreinte v4 (lot 76A) du contexte COURANT — même lecture que la mascotte. */
  async function empreinteV4(accountId: number, agendaItemId: number) {
    const { readAgendaRowsByIds } = await import('@/services/home/mascot/collector');
    const S = await import('@/services/home/mascot/t6-interpellation.service');
    const [ligne] = await readAgendaRowsByIds(accountId, [agendaItemId]);
    return S.t6ContextFingerprintV4(ligne, (await S.loadT6Evidence(accountId, [agendaItemId])).get(agendaItemId));
  }

  it('AC01/AC02/AC04 — « et » → « ou » : invalidée (cause tracée), remplacée, réutilisée ; cosmétique et réextraction identique : aucun appel', async () => {
    const c = await compte();
    const id = await echeance(c, 'Entretien chaudière', await plus(20));
    const doc = await contrat(c, id);
    await extraire(c, doc, ET);
    const p1 = await passer(c.id);
    expect(evalues()).toHaveLength(1);
    expect(evalues()[0].facts![0].excerpt).toBe(ET);
    expect(affichees(p1)).toEqual([id]);
    const d1 = (await decision(c.id, id))!;
    expect(d1.context_fingerprint.startsWith('v5:')).toBe(true);
    expect(Object.keys(d1.evidence_snapshot?.components ?? {}).sort()).toEqual(['dates', 'description', 'documents', 'facts', 'subject']);

    // AC04 : relecture, réextraction identique (nouvel identifiant), casse et espaces : aucun appel.
    await passer(c.id);
    await extraire(c, doc, ET);
    await passer(c.id);
    await extraire(c, doc, '  L’ENTRETIEN ET LA RÉPARATION   sont inclus');
    const p2 = await afficher(c.id, c.ownerUserId);
    await new Promise((r) => setTimeout(r, 150));
    expect(evalues()).toHaveLength(1);
    expect(affichees(p2)).toEqual([id]);
    expect((await decision(c.id, id))!.context_fingerprint).toBe(d1.context_fingerprint);

    // AC01/AC02 : « et » → « ou », valeur, confiance, clé, document identiques.
    await extraire(c, doc, OU);
    const avant = modele.candidats.length;
    const affichage = await afficher(c.id, c.ownerUserId);
    expect(affichees(affichage)).toEqual([]); // l'ancienne décision n'interpelle plus
    await attendreAppel(avant);
    expect(evalues()).toHaveLength(2);
    expect(evalues()[1].facts![0].excerpt).toBe(OU);
    const d2 = (await decision(c.id, id))!;
    expect(d2).toMatchObject({ decision: 'SUPPRESS', reevaluation_reason: 'CONTEXT_CHANGED' });
    expect(d2.context_fingerprint).not.toBe(d1.context_fingerprint);
    // Seule la partie « faits » a changé (cause conservée avec les décisions).
    expect(Object.keys(d1.evidence_snapshot!.components!).filter((k) => d1.evidence_snapshot!.components![k] !== d2.evidence_snapshot!.components![k])).toEqual(['facts']);
    // Nouvelle décision réutilisée : accueil et pré-génération, aucun appel.
    expect(affichees(await passer(c.id))).toEqual([]);
    expect(affichees(await afficher(c.id, c.ownerUserId))).toEqual([]);
    await new Promise((r) => setTimeout(r, 150));
    expect(evalues()).toHaveLength(2);
    // Trace : changement d'empreinte et cause dans le rapport T6.
    const rapports = await sql<Array<{ counters: Record<string, number> }>>`
      SELECT counters FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T6' ORDER BY id`;
    expect(rapports.some((r) => (r.counters.invalidatedContent ?? 0) >= 1)).toBe(true);
  });

  it('AC05 — décision v4 persistée : jamais réutilisée ni rebasée ; réévaluée une fois ; reprise bornée et différée', async () => {
    const c = await compte();
    const ids = [await echeance(c, 'Entretien chaudière', await plus(20)), await echeance(c, 'Révision pompe', await plus(25)), await echeance(c, 'Ramonage', await plus(30))];
    for (const id of ids) await extraire(c, await contrat(c, id), ET);
    await passer(c.id);
    expect(evalues()).toHaveLength(3);
    // Décisions « du lot 76A » : empreinte v4 du MÊME contexte (assimilerait « et » / « ou »).
    for (const id of ids) {
      await sql`UPDATE t6_interpellation_assessments SET context_fingerprint = ${await empreinteV4(c.id, id)} WHERE account_id = ${c.id} AND agenda_item_id = ${id}`;
    }
    // Budget de reprise : 1 par minute.
    process.env.MASCOT_T6_UPGRADE_PER_MINUTE = '1';
    (await import('@/services/home/mascot/t6-fingerprint-upgrade')).resetT6UpgradeBudget();
    (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
    await sql`DELETE FROM home_mascot_pregen_requests`;
    const p = await passer(c.id);
    expect(evalues()).toHaveLength(4); // une seule reprise dans la minute
    expect(affichees(p)).toHaveLength(1); // seules les décisions réévaluées sont présentées
    const reprises = await Promise.all(ids.map((id) => decision(c.id, id)));
    expect(reprises.filter((d) => d!.context_fingerprint.startsWith('v5:'))).toHaveLength(1);
    expect(reprises.find((d) => d!.context_fingerprint.startsWith('v5:'))!.reevaluation_reason).toBe('FINGERPRINT_UPGRADE');
    expect(reprises.filter((d) => d!.context_fingerprint.startsWith('v4:'))).toHaveLength(2); // jamais rebasées
    // Pré-génération DIFFÉRÉE à la libération du budget (jamais une reprise immédiate en boucle).
    const [demande] = await sql<Array<{ reason: string; futur: boolean }>>`
      SELECT reason, requested_at > clock_timestamp() + interval '20 seconds' AS futur FROM home_mascot_pregen_requests WHERE account_id = ${c.id}`;
    expect(demande).toMatchObject({ reason: 't6-upgrade', futur: true });
    // Passages répétés dans la minute : aucun appel, rien d'ambigu présenté.
    for (let k = 0; k < 3; k++) {
      expect(affichees(await passer(c.id))).toHaveLength(1);
      expect(affichees(await afficher(c.id, c.ownerUserId))).toHaveLength(1);
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(evalues()).toHaveLength(4);
    // Budget libéré : reprise des autres, puis stabilité (aucune réévaluation répétitive).
    delete process.env.MASCOT_T6_UPGRADE_PER_MINUTE;
    (await import('@/services/home/mascot/t6-fingerprint-upgrade')).resetT6UpgradeBudget();
    const fin = await passer(c.id);
    expect(evalues()).toHaveLength(6);
    expect(affichees(fin).length).toBeGreaterThanOrEqual(1); // la bulle limite le nombre de sujets présentés
    expect((await Promise.all(ids.map((id) => decision(c.id, id)))).every((d) => d!.decision === 'SHOW_NOW')).toBe(true);
    for (let k = 0; k < 2; k++) await passer(c.id);
    expect(evalues()).toHaveLength(6);
    for (const id of ids) expect((await decision(c.id, id))!.context_fingerprint.startsWith('v5:')).toBe(true);
  });
});
