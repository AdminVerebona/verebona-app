/**
 * Lot 76A — ticket « [P1] T6 — Compléter l’invalidation EVALUATE et empêcher
 * les suggestions contradictoires » — de bout en bout sur PostgreSQL 16 réel :
 * vrai collecteur, vraie décision, vraie passerelle IA (profil de génération
 * réellement appliqué), vraie persistance, vraie migration 0575. Modèle
 * SIMULÉ (aucun réseau) : il juge selon ce qu'il REÇOIT.
 *
 *  AC01/AC02  extrait changé (valeur « Annuel » et confiance identiques) :
 *             décision invalidée, jamais affichée avant sa réévaluation
 *  AC03       relecture, réextraction identique, variation cosmétique : aucun appel
 *  AC01       échéance rattachée à un autre bien : réévaluée
 *  AC04       replis, ordre, niveau de raisonnement, limite de sortie : invalidation
 *  AC05       FORMULATE seule : aucune réévaluation
 *  AC06–AC09  suggestions : échéance exclue sous une référence autorisée,
 *             incitation déclarée CONSULT, bien incohérent — jamais proposées,
 *             à la génération comme à la relecture du cache — lot 87C :
 *             contrat des questions fondées (version du prompt SIMULÉE),
 *             « préparer » étayée par une description, 3 premières questions
 *             seulement, rejets tracés sur la génération
 *  AC10       transition : empreintes v3 et signatures e1 enregistrées relues
 *             sans réévaluation de masse, rebasées ; référence 0575 concurrente
 *             sans doublon ; migration rejouable
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { activerContratQuestions, fondee } from '../t6-suggestions-v3';

interface Fait { ref: string; excerpt: string | null; value: string | null }
interface Candidat { subjectId: string; title: string; assetName: string | null; facts?: Fait[]; evidence: Array<{ ref: string; kind: string }> }

const modele = vi.hoisted(() => ({
  juger: (_c: Candidat): Record<string, unknown> | null => null,
  /** Questions rendues par FORMULATE — lot 87C : liste, ou fonction du contexte transmis. */
  questions: [] as unknown[] | ((ctx: Record<string, unknown>) => unknown[]),
  candidats: [] as Candidat[][],
  formulations: 0,
  /** Profil réellement reçu par le fournisseur (modèle, raisonnement, limite). */
  appels: [] as Array<{ model: string; reasoning: unknown; maxOutputTokens: unknown; mode: string | undefined }>,
}));

function provider() {
  return {
    name: 'simule-l76a',
    isConfigured: () => true,
    async call(input: { prompt: string; model: string; reasoning?: unknown; maxOutputTokens?: unknown }) {
      const mode = /^MODE = (\w+)$/m.exec(input.prompt)?.[1];
      modele.appels.push({ model: input.model, reasoning: input.reasoning ?? null, maxOutputTokens: input.maxOutputTokens ?? null, mode });
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
      modele.formulations += 1;
      const entree = JSON.parse(/Entrée structurée : (.*)\n/.exec(input.prompt)![1]) as { subjects: Array<{ subjectId: string; fallbackText: string }> };
      const q = /Contexte des questions suggérées : (.*)\n/.exec(input.prompt)?.[1];
      return {
        rawText: JSON.stringify({
          schemaVersion: 't6-output-v2', messages: entree.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })),
          suggestions: typeof modele.questions === 'function' ? (q && q !== 'null' ? modele.questions(JSON.parse(q)) : []) : modele.questions,
        }),
        inputTokens: 200, outputTokens: 60,
      };
    },
  };
}

const AUCUNE = { decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', reason: 'Échéance connue et suivie : aucune démarche à engager.', priorityHint: 'LOW' };
const AGIR = { decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', reason: 'Une démarche est nécessaire à court terme.', expectedAction: 'Prendre rendez-vous avec le prestataire', priorityHint: 'MEDIUM' };
/** Le modèle simulé juge sur l'extrait reçu : entretien à organiser par le client → agir. */
const surExtrait = (c: Candidat) => ((c.facts ?? []).some((f) => /client/i.test(f.excerpt ?? '')) ? AGIR : AUCUNE);

scenario('L76A-T6', 'Lot 76A — invalidation EVALUATE complète et suggestions contradictoires', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(provider() as never);
  });
  beforeEach(async () => {
    modele.juger = () => AGIR; modele.questions = []; modele.candidats.length = 0; modele.formulations = 0; modele.appels.length = 0;
    const R = await import('@/services/home/mascot/t6-runner');
    R.resetT6Breaker(); R.resetT6EvaluationState(); R.resetT6EvaluationBaselines();
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    await sql`DELETE FROM home_mascot_pregen_requests`;
  });
  afterEach(async () => {
    (await import('@/services/home/mascot/mascot.service')).cancelPendingPregenerations();
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  const jour = async () => (await import('@/services/home/mascot/collector')).todayParis();
  const plus = async (n: number) => (await import('@/services/home/mascot/t6-interpellation')).addDays(await jour(), n);
  const svc = () => import('@/services/home/mascot/mascot.service');
  const passer = async (accountId: number, userId: number | null = null) => (await svc()).getMascotPresentation(accountId, 'pregen', userId);
  const affichees = (p: import('@/services/home/mascot/types').MascotPresentation) => p.paragraphs.filter((x) => x.reminder != null).map((x) => x.reminder!.agendaItemId);
  const evalues = () => modele.candidats.flat();
  const questions = (p: import('@/services/home/mascot/types').MascotPresentation) => p.secondaries.filter((s) => s.action.target.kind === 'ask').map((s) => s.action.label);

  async function compte(nom = 'Maison Lilas') {
    const a = await make.account({ plan: 'premium' });
    const maison = await make.asset(a, { category: 'LOGEMENT', name: nom });
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
  /** (Ré)extraction : faits précédents remplacés par un NOUVEAU fait (nouvel identifiant). */
  async function extraire(c: { id: number }, doc: { fileId: number; extractionId: number }, excerpt: string) {
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${doc.fileId} AND account_id = ${c.id}`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt)
              VALUES (${c.id}, ${doc.fileId}, ${doc.extractionId}, 'maintenanceFrequency', 'Périodicité de l’entretien', 'Annuel', 'Annuel', 'certain', ${excerpt})`;
  }
  const decision = async (accountId: number, agendaItemId: number) => (await sql<Array<{ decision: string; context_fingerprint: string; evaluation_signature: string | null }>>`
    SELECT decision, context_fingerprint, evaluation_signature FROM t6_interpellation_assessments WHERE account_id = ${accountId} AND agenda_item_id = ${agendaItemId}`)[0] ?? null;

  /** Version de configuration T6 simulée (replis, raisonnement, limite) — T1/T2 inchangés. */
  async function configurerT6(o: Partial<import('@/services/ai/config/config-types').TreatmentConfig>) {
    const cfg = await import('@/services/ai/config/config-resolver');
    const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
    const [v] = await sql<[{ id: number }]>`INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'l76a (e2e)') RETURNING id`;
    const entries = [
      ...(['T1', 'T2'] as const).map((t) => ({ ...emptyTreatmentConfig(t), promptArchitecture: 'master' as const })),
      { ...emptyTreatmentConfig('T6'), promptArchitecture: 'master' as const, primaryModel: 'gemini-2.5-pro', ...o },
    ];
    cfg.__setConfigForTests({ versionId: Number(v.id), entries }, [{ versionId: Number(v.id), entries }]);
  }
  async function retablir() {
    const cfg = await import('@/services/ai/config/config-resolver');
    const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
    const [v] = await sql<[{ id: number }]>`INSERT INTO ai_config_versions (environment, status, label) VALUES ('local', 'DRAFT', 'l76a retour (e2e)') RETURNING id`;
    const entries = (['T1', 'T2'] as const).map((t) => ({ ...emptyTreatmentConfig(t), promptArchitecture: 'master' as const }));
    cfg.__setConfigForTests({ versionId: Number(v.id), entries }, [{ versionId: Number(v.id), entries }]);
  }

  it('AC01/AC02/AC03 — extrait changé : invalidée, jamais affichée avant réévaluation ; réextraction identique et cosmétique : aucun appel', async () => {
    modele.juger = surExtrait;
    const c = await compte();
    const id = await echeance(c, 'Entretien chaudière', await plus(20));
    const doc = await contrat(c, id);
    await extraire(c, doc, 'Entretien à organiser par le client ; aucune prise en charge.');
    const p1 = await passer(c.id);
    expect(evalues()).toHaveLength(1);
    expect(evalues()[0].facts![0]).toMatchObject({ value: 'Annuel', excerpt: 'Entretien à organiser par le client ; aucune prise en charge.' });
    expect(affichees(p1)).toEqual([id]);
    const d1 = (await decision(c.id, id))!;
    expect(d1.context_fingerprint.startsWith('v4:')).toBe(true);
    expect(d1.evaluation_signature!.startsWith('e2:')).toBe(true);

    // AC03 : relecture, réextraction identique (nouveaux identifiants), variation cosmétique : aucun appel.
    await passer(c.id);
    await extraire(c, doc, 'Entretien à organiser par le client ; aucune prise en charge.');
    await passer(c.id);
    await extraire(c, doc, '  ENTRETIEN à organiser par le CLIENT, aucune prise en charge !');
    const p2 = await passer(c.id);
    expect(evalues()).toHaveLength(1);
    expect(affichees(p2)).toEqual([id]);
    expect((await decision(c.id, id))!.context_fingerprint).toBe(d1.context_fingerprint);

    // AC01/AC02 : extrait changé, valeur « Annuel » et confiance identiques.
    await extraire(c, doc, 'Entretien déjà pris en charge par le prestataire.');
    // À l'affichage (évaluation en arrière-plan) : l'ancienne décision n'est jamais utilisée.
    const avant = modele.candidats.length;
    const affichage = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(affichees(affichage)).toEqual([]);
    for (let i = 0; i < 50 && modele.candidats.length === avant; i += 1) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    expect(evalues().at(-1)!.facts![0]).toMatchObject({ value: 'Annuel', excerpt: 'Entretien déjà pris en charge par le prestataire.' });
    const d2 = (await decision(c.id, id))!;
    expect(d2.context_fingerprint).not.toBe(d1.context_fingerprint);
    expect(d2.decision).toBe('SUPPRESS');
    expect(affichees(await passer(c.id))).toEqual([]);
  });

  it('AC01 — rattachement : échéance rattachée à un autre bien → réévaluée ; inchangée → aucun appel', async () => {
    const c = await compte();
    const id = await echeance(c, 'Contrôle annuel', await plus(25));
    await passer(c.id);
    expect(evalues()).toHaveLength(1);
    await passer(c.id);
    expect(evalues()).toHaveLength(1);
    const autre = await make.asset(c as never, { category: 'VEHICULE', name: 'Clio' });
    await sql`UPDATE agenda_asset_links SET asset_id = ${autre.id} WHERE agenda_item_id = ${id}`;
    await passer(c.id);
    expect(evalues()).toHaveLength(2);
    expect(evalues()[1].assetName).toBe('Clio');
    const p = await passer(c.id);
    expect(evalues()).toHaveLength(2);
    expect(affichees(p)).toEqual([id]);
  });

  it('AC04/AC05 — replis, ordre, raisonnement, limite de sortie : invalidation ; FORMULATE seule : aucune', async () => {
    try {
      await configurerT6({ fallback1: 'gemini-3.1-flash-lite', fallback2: 'gemini-3.5-flash-lite', reasoningPrimary: 'standard', maxOutputTokens: 4096 });
      const c = await compte();
      const id = await echeance(c, 'Ramonage', await plus(15));
      await passer(c.id);
      expect(evalues()).toHaveLength(1);
      // Profil réellement appliqué par la passerelle (principal, raisonnement, limite).
      expect(modele.appels.find((a) => a.mode === 'EVALUATE')).toMatchObject({ model: 'gemini-2.5-pro', reasoning: 'standard', maxOutputTokens: 4096 });
      const s0 = (await decision(c.id, id))!.evaluation_signature;
      await passer(c.id);
      expect(evalues()).toHaveLength(1);

      // AC05 : version BO dont seule la branche FORMULATE change — aucune réévaluation.
      const master = await (await import('@/services/ai/governance/master-corpus/cases')).readMasterFileFromRepo('t6_master_v1');
      (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests([
        { id: 7601, treatment: 'T6' as never, versionNumber: 7601, content: master.replace('R12 — Questions suggérées.', 'R12 — Questions suggérées (révisée 76A).') },
      ]);
      (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
      await passer(c.id);
      expect(evalues()).toHaveLength(1);
      (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);

      // AC04 : chacun de ces changements invalide la décision et la fait réévaluer.
      let n = 1;
      for (const o of [
        { fallback1: 'gemini-3.5-flash-lite', fallback2: 'gemini-3.1-flash-lite' }, // ordre des replis
        { fallback1: 'gemini-3.5-flash-lite', fallback2: null }, // repli retiré
        { fallback1: 'gemini-3.5-flash-lite', reasoningFallback1: 'étendu' as const }, // niveau d'un repli
        { fallback1: 'gemini-3.5-flash-lite', reasoningFallback1: 'étendu' as const, maxOutputTokens: 2048 }, // limite de sortie
      ]) {
        await configurerT6({ reasoningPrimary: 'standard', maxOutputTokens: 4096, ...o });
        (await import('@/services/home/mascot/t6-runner')).resetT6EvaluationState();
        const p = await passer(c.id);
        n += 1;
        expect(evalues()).toHaveLength(n);
        const d = (await decision(c.id, id))!;
        expect(d.evaluation_signature).not.toBe(s0);
        expect(affichees(p)).toEqual([id]);
        // Même configuration au passage suivant : aucun appel.
        await passer(c.id);
        expect(evalues()).toHaveLength(n);
      }
    } finally {
      await retablir();
    }
  });

  it('AC10 — transition : signature e1 et empreinte v3 enregistrées — aucune réévaluation de masse, rebasage, puis invalidation au changement', async () => {
    try {
      await configurerT6({ fallback1: 'gemini-3.1-flash-lite', reasoningPrimary: 'minimal', maxOutputTokens: 3000 });
      const R = await import('@/services/home/mascot/t6-runner');
      const cfg0 = (await R.t6EvaluationConfig(60))!;
      await sql`DELETE FROM t6_evaluation_signature_baselines WHERE legacy_signature = ${cfg0.legacySignature!}`;
      R.resetT6EvaluationBaselines();
      const c = await compte();
      const id = await echeance(c, 'Révision chaudière', await plus(18));
      const doc = await contrat(c, id);
      await extraire(c, doc, 'Révision annuelle à la charge du client.');
      await passer(c.id);
      expect(evalues()).toHaveLength(1);
      // Décision « du lot 75 » : signature e1 (lot 72A) et empreinte v3 (lot 75E) du MÊME contexte.
      const S = await import('@/services/home/mascot/t6-interpellation.service');
      const ev = (await S.loadT6Evidence(c.id, [id])).get(id);
      const [ligne] = await sql<[{ title: string; date: string }]>`SELECT title, to_char(start_date, 'YYYY-MM-DD') AS date FROM agenda_items WHERE id = ${id}`;
      const v3 = S.fingerprintWithEvidence({ title: ligne.title, date: ligne.date, forecast: false, requiresQualification: false }, ev);
      await sql`UPDATE t6_interpellation_assessments SET context_fingerprint = ${v3}, evaluation_signature = ${cfg0.legacySignature!} WHERE account_id = ${c.id} AND agenda_item_id = ${id}`;
      R.resetT6EvaluationState();
      const p = await passer(c.id);
      expect(evalues()).toHaveLength(1); // aucune réévaluation au déploiement
      expect(affichees(p)).toEqual([id]);
      const d = (await decision(c.id, id))!;
      expect(d.context_fingerprint.startsWith('v4:')).toBe(true); // rebasée
      expect(d.evaluation_signature).toBe(cfg0.legacySignature);
      const [ref] = await sql<[{ signature: string }]>`SELECT signature FROM t6_evaluation_signature_baselines WHERE legacy_signature = ${cfg0.legacySignature!}`;
      expect(ref.signature).toBe(cfg0.signature);
      // Après rebasage : une modification que v3 ne voyait pas (ordre des mots) invalide.
      await extraire(c, doc, 'Révision annuelle à la charge du prestataire et non du client.');
      await passer(c.id);
      expect(evalues()).toHaveLength(2);
      // Décision e1 et repli changé depuis la référence : invalidée (CONFIG_CHANGED).
      await sql`UPDATE t6_interpellation_assessments SET evaluation_signature = ${cfg0.legacySignature!} WHERE account_id = ${c.id} AND agenda_item_id = ${id}`;
      await configurerT6({ fallback1: 'gemini-3.5-flash-lite', reasoningPrimary: 'minimal', maxOutputTokens: 3000 });
      R.resetT6EvaluationState();
      const prep = await passer(c.id);
      expect(evalues()).toHaveLength(3);
      expect(affichees(prep)).toEqual([id]);
      expect((await decision(c.id, id))!.evaluation_signature!.startsWith('e2:')).toBe(true);
    } finally {
      await retablir();
    }
  });

  it('AC10 — référence 0575 : premières observations concurrentes sans doublon ; migration rejouable', async () => {
    try {
      await configurerT6({ fallback1: 'gemini-3.1-flash-lite', reasoningPrimary: 'étendu', maxOutputTokens: 5000 });
      const R = await import('@/services/home/mascot/t6-runner');
      const cfg = (await R.t6EvaluationConfig(45))!;
      await sql`DELETE FROM t6_evaluation_signature_baselines WHERE legacy_signature = ${cfg.legacySignature!}`;
      R.resetT6EvaluationBaselines();
      const res = await Promise.all(Array.from({ length: 6 }, () => R.t6EvaluationConfig(45)));
      expect(new Set(res.map((x) => x!.legacyBaseline))).toEqual(new Set([cfg.signature]));
      const lignes = await sql`SELECT 1 FROM t6_evaluation_signature_baselines WHERE legacy_signature = ${cfg.legacySignature!}`;
      expect(lignes).toHaveLength(1);
      // Première observation conservée : un changement ultérieur ne la réécrit pas.
      await configurerT6({ fallback1: 'gemini-3.5-flash-lite', reasoningPrimary: 'étendu', maxOutputTokens: 5000 });
      R.resetT6EvaluationBaselines();
      const apres = (await R.t6EvaluationConfig(45))!;
      expect(apres.legacySignature).toBe(cfg.legacySignature);
      expect(apres.legacyBaseline).toBe(cfg.signature);
      expect(apres.signature).not.toBe(cfg.signature);
      const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0575_l76a_t6_evaluation_baselines.sql'), 'utf8');
      await sql.begin(async (tx) => { await tx.unsafe(mig); });
      await sql.begin(async (tx) => { await tx.unsafe(mig); });
      expect(await sql`SELECT 1 FROM t6_evaluation_signature_baselines WHERE legacy_signature = ${cfg.legacySignature!}`).toHaveLength(1);
    } finally {
      await retablir();
    }
  });

  it('AC06–AC09 — suggestions : exclue sous D1, incitation CONSULT, bien incohérent : jamais proposées (génération et cache)', async () => {
    const c = await compte();
    const ct = await echeance(c, 'Contrôle technique', await plus(12));
    await echeance(c, 'Assurance habitation', await plus(14));
    const ramonage = await echeance(c, 'Ramonage', await plus(200)); // hors horizon : jamais évalué, consultable, non signalé
    modele.juger = (x) => (x.title === 'Contrôle technique' ? AGIR : AUCUNE);
    // Lot 87C : la démarche du contrôle technique est étayée par une description concrète (fondement D1.DESC).
    await sql`UPDATE agenda_items SET description = 'Contre-visite exigée : rendez-vous à prendre au centre agréé.' WHERE id = ${ct}`;
    await activerContratQuestions(true);
    const D = (ctx: Record<string, unknown>, label: string) => (ctx.nextDeadlines as Array<{ ref: string; label: string; identifiedAction: { ref: string } | null; description: { ref: string } | null }>)
      .find((x) => x.label === label)!;
    const preparerCT = (ctx: Record<string, unknown>, question: string, o: { assetRef?: string | null } = {}) => {
      const d = D(ctx, 'Contrôle technique');
      return fondee(ctx, question, [d.ref, ...(d.identifiedAction ? [d.identifiedAction.ref] : []), ...(d.description ? [d.description.ref] : [])],
        { purpose: 'PREPARE', deadlineRef: d.ref, ...o });
    };
    modele.questions = (ctx) => [
      // Cas du ticket 76A : texte sur l'échéance exclue, référence autorisée vers une autre.
      preparerCT(ctx, 'Comment préparer le renouvellement de l’assurance habitation ?'),
      // Préparation étayée (démarche identifiée + description) : légitime, conservée.
      preparerCT(ctx, 'Que dois-je préparer pour le contrôle technique ?', { assetRef: 'A1' }),
      fondee(ctx, 'Quand est prévu le ramonage ?', [D(ctx, 'Ramonage').ref]),
    ];
    await passer(c.id);
    const p = await passer(c.id);
    expect(affichees(p)).toEqual([ct]);
    const attendues = ['Que dois-je préparer pour le contrôle technique ?', 'Quand est prévu le ramonage ?'];
    expect(questions(p)).toEqual(attendues);
    // Relecture du cache (aucune nouvelle formulation) : mêmes contrôles.
    const n = modele.formulations;
    const relue = await (await svc()).getMascotPresentation(c.id, 'display', c.ownerUserId);
    expect(modele.formulations).toBe(n);
    expect(questions(relue)).toEqual(attendues);
    // Bien incohérent (autre bien du compte), incitation CONSULT, paraphrase : rejetées.
    const clio = await make.asset(c as never, { category: 'VEHICULE', name: 'Clio' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${clio.id}`;
    modele.questions = (ctx) => [
      preparerCT(ctx, 'Que dois-je préparer pour le contrôle technique de la Clio ?', { assetRef: null }),
      fondee(ctx, 'Comment préparer le ramonage ?', [D(ctx, 'Ramonage').ref]),
      fondee(ctx, 'Quand passer le CT ?', [D(ctx, 'Contrôle technique').ref]),
    ];
    // (le nouveau bien change le contexte des questions : nouvelle formulation, mêmes contrôles)
    const q = await passer(c.id);
    expect(questions(q)).toEqual([]);
    // Lot 87C (AC14) : rejets distinctement tracés sur la génération, sans texte.
    // (journal T6 écrit en arrière-plan : attente bornée de la ligne de cette génération)
    const derniere = async () => (await sql<Array<{ r: { accepted: number; rejected: number; reasons: Record<string, number> } }>>`
      SELECT suggestion_report AS r FROM home_mascot_generations WHERE account_id = ${c.id} AND status = 'generated' AND suggestion_report IS NOT NULL ORDER BY id DESC LIMIT 1`)[0];
    for (let i = 0; i < 100 && (await derniere())?.r.accepted !== 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    const g = await derniere();
    expect(g.r).toMatchObject({ accepted: 0, rejected: 3, reasons: { other_asset_cited: 1, consult_incites_unsignaled: 1, label_not_cited: 1 } });
    expect(JSON.stringify(g.r)).not.toMatch(/Clio|ramonage|Quand passer/);
    expect(ramonage).toBeGreaterThan(0);
  });
});
