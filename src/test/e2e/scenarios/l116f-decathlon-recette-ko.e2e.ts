/**
 * Carte Trello #812 (lot 116F) — REPRISE APRÈS LA RECETTE KO DU 21/11/2026, PostgreSQL réel.
 *
 * NON-RÉGRESSION « DECATHLON » (demandée par le PO, à conserver). Le cas réel : bon de commande Decathlon
 * France du 17/11/2026 (« Votre commande est validée ! »), coussin Polisport groovy gris, 9,99 €, rattaché
 * au vélo « Jean Fourche ». Le correctif du 20/11 était en préproduction depuis la veille ; le 21/11 à
 * 08 h 48 la fiche affichait toujours « Début de validité : 17/11/2026 » : la validité d'un jour était DÉJÀ
 * dans le stock (`document_business_periods`), et rien ne l'en retirait avant le second passage du contrôle
 * de cohérence — ni jamais si T1 avait cité la date dans une « mention propre ».
 *
 * Chemins de PRODUCTION, aucun appel à un fournisseur d'IA (sorties T1 simulées par des faits, des candidats
 * et une analyse de référence persistés) : route `GET /api/documents/:id/periodes`, lectures groupées
 * (listes, dépense, Assistant, dossiers), contexte de qualification T3, titrage, qualification des périodes
 * (`refreshDocumentBusinessPeriods`, étape du pipeline T1), consolidation T3 (`consolidateAccountOperations`),
 * projection T4 (`projectAccountOperations`), contrôle de cohérence (orchestrateur de la tâche planifiée),
 * reprise de l'exploitant (`reprisePointDateValidities`, service du script `reprise-812-…`).
 *
 *   L116F-E2E-DECATHLON (× 2 variantes d'extrait : la mention même de la date du document ; une « mention
 *                 propre » — l'ancien cas « à réexaminer »)
 *                 AVANT : la ligne du stock est celle que la fiche restituait ;
 *                 APRÈS, IMMÉDIATEMENT (aucune campagne, aucune écriture, aucune IA) : l'API, les listes, la
 *                 dépense, l'Assistant, les dossiers et le contexte T3 ne la restituent plus ; une première
 *                 campagne « à blanc » n'y change rien ;
 *                 REPRISE : à blanc (rapport), réelle (ligne retirée avec motif, jamais supprimée), rejouée ;
 *                 INTACTS : date du document, titre, montant, faits T1, garantie du même document, garantie
 *                 d'une autre pièce, validité réelle d'un devis du compte, correction de l'utilisateur ;
 *                 RÉINTRODUCTION : deux nouvelles analyses T1 (validité d'un jour rendue de nouveau, sans puis
 *                 avec « mention propre »), passage T3, projection T4, contrôle de cohérence correctif — ni
 *                 période, ni ligne, ni fait donné à T3, ni élément d'Agenda, ni date d'opération ;
 *   L116F-E2E-11  autres états du stock : fait T1 disparu, fin seule « à réexaminer », validité à une autre
 *                 date, titrage, isolation des comptes, ciblage d'un document, pagination de la reprise ;
 *   L116F-E2E-12  aucun cache : deux lectures successives de la route rendent l'état courant ;
 *   L116F-E2E-13  les six requêtes de diagnostic de la fiche de recette, exécutées telles quelles ;
 *   L116F-E2E-14  le SCRIPT de l'exploitant lui-même (`scripts/reprise-812-validites-artificielles.ts`), lancé
 *                 en sous-processus : usage, à blanc par défaut, `--file`, `--apply`, rejeu, rapport écrit ;
 *   L116F-E2E-15  LE DÉLAI du moteur de cohérence (règle A6), sans réglage de mode (AUTO) : tant qu'aucune
 *                 campagne QUOTIDIENNE complète n'a exécuté la version 2 du contrôle, une campagne — même
 *                 manuelle — l'exécute à blanc et ne retire rien ; elle corrige ensuite. La lecture, elle, est
 *                 correcte pendant tout ce délai.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, fh, operationsKit, type OperationsKit } from '../datasets/operations-v1';
import { proofOf, runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    tryGetSession: async () => (session.userId ? { userId: session.userId, currentAccountId: session.currentAccountId } : null),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const CHECK = 'COH-DOC-BUSINESS-PERIODS';
const AUJ = '2026-11-21';
const JOUR = '2026-11-17';
const TITRE = 'Bon de commande Polisport groovy coussin gris';
const MENTION_DATE = 'Commande du 17/11/2026';
const MENTION_PROPRE = 'Votre commande du 17/11/2026 est validée !';
const LIGNE_KO = 'Début de validité : 17/11/2026';
type Json = Record<string, any>;
type Fait = { key: string; value: string; excerpt: string; start?: string; end?: string };

/** Sortie T1 du bon de commande : achat rattaché au vélo, daté du jour de la commande, 9,99 €. */
const commande = (veloId: number): AnchoredOperationCandidate => cand({
  typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'ORDER', provider: 'Decathlon France',
  summary: 'Coussin Polisport groovy gris', targetHints: [cible(veloId)], temporalHints: { realizedDate: JOUR },
  financialHints: [fh('REALIZED_COST', 999)],
});
const factureVelo = (veloId: number): AnchoredOperationCandidate => cand({
  typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Cycles Exemple',
  summary: 'Vélo', targetHints: [cible(veloId)], temporalHints: { realizedDate: '2026-03-02' }, financialHints: [],
});
const devisRevision = (veloId: number): AnchoredOperationCandidate => cand({
  typeHint: 'INTERVENTION', statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', provider: 'Atelier Exemple',
  summary: 'Révision du vélo', targetHints: [cible(veloId)], temporalHints: {}, financialHints: [],
});

scenario('L116FK', 'Recette KO du 21/11 (#812) — bon de commande Decathlon : règle à la lecture, reprise immédiate, non-réintroduction', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(() => { k = operationsKit(sql, make); });
  afterAll(() => { session.currentAccountId = null; });

  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const reprise = () => import('@/services/documents/business-periods/point-date-reprise');
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

  // ── Outils ────────────────────────────────────────────────────────────────
  /** Faits génériques T1 persistés (`document_facts`). Rend leurs identifiants. */
  const faits = async (c: AccountRow, fileId: number, liste: Fait[]): Promise<number[]> => {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    const ids: number[] = [];
    for (const f of liste) {
      const [r] = await sql<{ id: number }[]>`
        INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, normalized_value, confidence, excerpt, status, period_start, period_end)
        VALUES (${c.id}, ${fileId}, ${x.id}, ${f.key}, ${f.key}, ${f.value}, 'certain', ${f.excerpt}, 'active', ${f.start ?? null}, ${f.end ?? null}) RETURNING id::int AS id`;
      ids.push(r.id);
    }
    return ids;
  };
  /** Analyse T1 de référence (remplace la précédente) : titre, type, date du document lue par T1 avec sa mention. */
  const analyse = async (c: AccountRow, fileId: number, o: { jour: string; extrait: string; titre: string; type: string }) => {
    const raw = { task: 'ANALYZE_DOCUMENT', document: {
      title: { value: o.titre, confidence: 'certain' }, type: { value: o.type, confidence: 'certain' },
      date: { value: o.jour, confidence: 'certain' }, documentDate: { value: o.jour, confidence: 'certain', evidence: { excerpt: o.extrait } },
    } };
    await sql`UPDATE document_analysis_runs SET is_current_reference = false WHERE asset_file_id = ${fileId}`;
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_analysis_runs WHERE asset_file_id = ${fileId}`;
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${fileId}, ${`h${fileId}-${n}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${c.id}, ${JSON.stringify(raw)})`;
  };
  /** Ligne du STOCK, telle que la qualification d'avant la carte l'enregistrait pour un fait T1. */
  const stock = async (c: AccountRow, fileId: number, o: { kind: string; start: string | null; end: string | null; factId: number; quote: string }) => {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO document_business_periods (account_id, file_id, period_kind, segment_index, start_on, end_on, principal_hint, origin, basis, evidence, created_at)
      VALUES (${c.id}, ${fileId}, ${o.kind}, 0, ${o.start}, ${o.end}, false, 'T1', 'T1_PERIOD_FACT',
              ${JSON.stringify({ quote: o.quote, page: null, factIds: [o.factId] })}::jsonb, '2026-11-17T10:00:00Z') RETURNING id::int AS id`;
    return r.id;
  };
  const periodes = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, period_kind AS kind, status, start_on AS s, end_on AS e, origin, user_locked AS locked, superseded_reason AS reason,
           superseded_detail AS detail, superseded_correlation_id AS correlation, updated_at::text AS maj
      FROM document_business_periods WHERE file_id = ${fileId} ORDER BY period_kind, id`;
  const actives = async (fileId: number) => (await periodes(fileId)).filter((p) => p.status === 'ACTIVE').map((p) => [p.kind, p.s, p.e, p.origin, p.locked]);
  const lire = async (c: AccountRow, id: number): Promise<{ principal: string | null; lignes: string[]; brut: Json }> => {
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), ctx(id));
    expect(r.status).toBe(200);
    const p = (await r.json() as { periods: Json }).periods;
    const lignes = [...(p.principal ? [p.principal.line, ...p.principal.segments.map((x: Json) => x.line)] : []), ...p.secondary.map((x: Json) => x.line)];
    return { principal: p.principal?.line ?? null, lignes, brut: p };
  };
  const appelsIa = async (c: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_usage_events WHERE account_id = ${c.id}`)[0].n;
  const agenda = (c: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, title, start_date::text AS debut, end_date::text AS fin, business_operation_id::int AS op FROM agenda_items WHERE account_id = ${c.id} ORDER BY id`;
  /** Éléments d'Agenda induits par un document : par ses opérations, par un lien de fichier, ou par son origine. */
  const agendaDe = (c: AccountRow, fileId: number) => sql<Json[]>`
    SELECT ai.id::int AS id, ai.title, ai.start_date::text AS debut FROM agenda_items ai
     WHERE ai.account_id = ${c.id}
       AND (ai.business_operation_id IN (SELECT d.operation_id FROM business_operation_documents d WHERE d.account_id = ${c.id} AND d.file_id = ${fileId} AND d.active)
            OR ai.id IN (SELECT l.agenda_item_id FROM agenda_file_links l WHERE l.asset_file_id = ${fileId})
            OR (ai.origin_ref_type = 'asset_file' AND ai.origin_ref_id = ${fileId}))`;
  const operationsDe = (c: AccountRow, fileId: number) => sql<Json[]>`
    SELECT o.id::int AS id, o.start_date::text AS debut, o.end_date::text AS fin, o.planned_date::text AS prevue
      FROM business_operations o JOIN business_operation_documents d ON d.operation_id = o.id AND d.account_id = o.account_id AND d.active
     WHERE o.account_id = ${c.id} AND d.file_id = ${fileId} AND o.invalidated_at IS NULL ORDER BY o.id`;
  const passerT3 = (c: AccountRow) => k.passer(c, { today: AUJ });
  const projeterT4 = async (c: AccountRow) => (await import('@/services/business-operations/agenda-projection/service'))
    .projectAccountOperations(c.id, { all: true, today: AUJ, correlationId: 'e2e-812-ko' });
  /** Contexte donné à T3 pour le document (lecture réelle) : périodes et faits du document cible. */
  const contexteT3 = async (c: AccountRow, velo: AssetRow, fileId: number) => {
    const { loadQualificationContext } = await import('@/services/business-operations/tco/semantic-qualification/context');
    const r = await loadQualificationContext(sql, c.id, { assetId: velo.id, assetCategory: 'OBJET', fileId, tco: { lines: [] }, amounts: [], today: AUJ });
    const d = r!.documents.find((x) => x.id === fileId)!;
    return { periodes: (d.periods ?? []).map((p) => p.kind), faits: (d.facts ?? []).map((f) => f.key) };
  };
  /** Toutes les lectures de périodes du document : aucune ne doit restituer une validité. */
  const surfaces = async (c: AccountRow, fileId: number) => {
    const s = await svc();
    const surf = await import('@/services/documents/business-period-surfaces');
    const liste = (await s.readPrincipalPeriodLines(c.id, [fileId])).get(fileId)?.line ?? null;
    const resume = (await surf.readDocumentPeriodSummaries(c.id, [fileId])).get(fileId);
    const dossier = (await surf.dossierPeriodLines(c.id, [fileId])).get(fileId) ?? null;
    const assistant = (await surf.documentPeriodTexts(c.id, [fileId])).get(fileId) ?? null;
    return { liste, resume: [...(resume?.principal ? [resume.principal.line] : []), ...(resume?.secondary ?? []).map((x) => x.line)], dossier, assistant };
  };

  /** Le compte du cas réel : le vélo « Jean Fourche », le bon de commande Decathlon et son stock, les faits légitimes. */
  async function casReel(extrait: string) {
    const c = await make.account({ plan: 'premium' });
    const velo = await make.asset(c, { category: 'OBJET', name: 'Jean Fourche' });
    // Bon de commande Decathlon France du 17/11/2026 — coussin Polisport groovy gris, 9,99 €.
    const bon = await k.document(c, velo.id, [commande(velo.id)], { type: 'ACQUISITION_ORDER', title: TITRE, amountCents: 999, date: JOUR });
    await sql`UPDATE asset_files SET supplier = 'Decathlon France', title_source = 'SYSTEM', last_analysis_at = '2026-11-17T10:00:00Z' WHERE id = ${bon}`;
    await analyse(c, bon, { jour: JOUR, extrait: MENTION_DATE, titre: TITRE, type: 'ACQUISITION_ORDER' });
    const [fv, fg] = await faits(c, bon, [
      { key: 'period.validity', value: `${JOUR}/`, excerpt: extrait },
      { key: 'period.warranty', value: `${JOUR}/2028-11-17`, excerpt: 'Garantie 2 ans, jusqu’au 17/11/2028' },
    ]);
    // STOCK : la validité d'un jour, DÉJÀ persistée le 17/11 par la qualification d'avant la carte ; la garantie aussi.
    const validite = await stock(c, bon, { kind: 'VALIDITY', start: JOUR, end: null, factId: fv, quote: extrait });
    const garantie = await stock(c, bon, { kind: 'WARRANTY', start: JOUR, end: '2028-11-17', factId: fg, quote: 'Garantie 2 ans, jusqu’au 17/11/2028' });
    // Faits légitimes du compte : garantie d'une AUTRE pièce, validité RÉELLE d'un devis, correction de l'utilisateur.
    const facture = await k.document(c, velo.id, [factureVelo(velo.id)], { type: 'ACQUISITION_INVOICE', title: 'Facture du vélo', amountCents: 64900, date: '2026-03-02' });
    await analyse(c, facture, { jour: '2026-03-02', extrait: 'Facture du 02/03/2026', titre: 'Facture du vélo', type: 'ACQUISITION_INVOICE' });
    const [ffg] = await faits(c, facture, [{ key: 'period.warranty', value: '2026-03-02/2028-03-02', excerpt: 'Garantie constructeur 2 ans' }]);
    const garantieFacture = await stock(c, facture, { kind: 'WARRANTY', start: '2026-03-02', end: '2028-03-02', factId: ffg, quote: 'Garantie constructeur 2 ans' });
    const devis = await k.document(c, velo.id, [devisRevision(velo.id)], { type: 'WORKS_QUOTE', title: 'Devis de révision', date: '2026-11-03' });
    await analyse(c, devis, { jour: '2026-11-03', extrait: 'Devis du 03/11/2026', titre: 'Devis de révision', type: 'WORKS_QUOTE' });
    const [fdv] = await faits(c, devis, [{ key: 'period.validity', value: '2026-11-03/2026-12-03', excerpt: 'Devis valable 30 jours, du 03/11/2026 au 03/12/2026' }]);
    const validiteDevis = await stock(c, devis, { kind: 'VALIDITY', start: '2026-11-03', end: '2026-12-03', factId: fdv, quote: 'Devis valable 30 jours, du 03/11/2026 au 03/12/2026' });
    // Un autre bon de commande du même jour dont l'utilisateur a LUI-MÊME établi la validité (parcours « Modifier »).
    const corrige = await k.document(c, velo.id, [commande(velo.id)], { type: 'ACQUISITION_ORDER', title: 'Bon de commande sonnette', amountCents: 499, date: JOUR });
    await analyse(c, corrige, { jour: JOUR, extrait: MENTION_DATE, titre: 'Bon de commande sonnette', type: 'ACQUISITION_ORDER' });
    const [fc] = await faits(c, corrige, [{ key: 'period.validity', value: `${JOUR}/`, excerpt: extrait }]);
    const avantCorrection = await stock(c, corrige, { kind: 'VALIDITY', start: JOUR, end: null, factId: fc, quote: extrait });
    as(c);
    const { PUT } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await PUT(new NextRequest(`http://x/api/documents/${corrige}/periodes`, { method: 'PUT', body: JSON.stringify({ periodId: avantCorrection, start: JOUR, end: null, openEnded: false }) }), ctx(corrige));
    expect(r.status).toBe(200);
    // Le dossier tel qu'il existe : opération d'achat rattachée au vélo (T3), projection d'Agenda (T4).
    await passerT3(c);
    await projeterT4(c);
    return { c, velo, bon, fv, validite, garantie, facture, garantieFacture, devis, validiteDevis, corrige };
  }

  describe.each([
    ['la mention même de la date du document', MENTION_DATE, 'SAME_MENTION_AS_POINT_DATE'],
    ['une « mention propre » (ancien cas « à réexaminer »)', MENTION_PROPRE, 'DOCUMENT_DATE_RESTATED'],
  ] as const)('extrait cité par T1 : %s', (_nom, extrait, motif) => {
    it('L116F-E2E-DECATHLON — bon de commande Decathlon France du 17/11/2026, coussin Polisport groovy gris, 9,99 €, vélo « Jean Fourche »', async () => {
      const x = await casReel(extrait);
      const { c, velo, bon } = x;
      const ia0 = await appelsIa(c);
      // Agenda du compte avant tout : seulement l'événement légitime de la facture du vélo ; rien pour le bon de commande.
      const agendaAvant = await agenda(c);
      expect(agendaAvant.map((e) => [e.title, e.debut])).toEqual([['Achat — Vélo', '2026-03-02']]);
      expect(await agendaDe(c, bon)).toEqual([]);

      // ── AVANT : le stock porte la validité d'un jour, et c'est la ligne que la fiche restituait ────────────────
      expect(await actives(bon)).toEqual([['VALIDITY', JOUR, null, 'T1', false], ['WARRANTY', JOUR, '2028-11-17', 'T1', false]]);
      const lib = await import('@/lib/documents/business-periods');
      const { principalKind } = await import('@/services/documents/business-periods/model');
      const enStock = (await periodes(bon)).filter((p) => p.status === 'ACTIVE').map((p) => ({ kind: p.kind as 'VALIDITY' | 'WARRANTY', principalHint: false, start: p.s as string | null, end: p.e as string | null }));
      // Lecture d'AVANT le correctif (période principale puis libellé, sans la règle) : exactement la capture du PO.
      const principaleAvant = principalKind(enStock)!;
      expect(lib.principalLine(principaleAvant, enStock.filter((p) => p.kind === principaleAvant))).toBe(LIGNE_KO);
      const stockAvant = await periodes(bon);

      // ── APRÈS, IMMÉDIATEMENT : aucune campagne, aucune reprise, aucune écriture, aucune IA ─────────────────────
      const vue = await lire(c, bon);
      expect(vue.principal).toBe('Période de garantie : du 17/11/2026 au 17/11/2028');
      expect(vue.lignes.join(' | ')).not.toMatch(/validité/i);
      expect(JSON.stringify(vue.brut)).not.toContain('VALIDITY');
      const s1 = await surfaces(c, bon);
      expect(s1.liste).toBe('Période de garantie : du 17/11/2026 au 17/11/2028');
      expect(s1.resume).toEqual(['Période de garantie : du 17/11/2026 au 17/11/2028']);
      expect(`${s1.dossier} ${s1.assistant}`).not.toMatch(/validité/i);
      expect(s1.assistant).toContain('17/11/2028');
      const t3 = await contexteT3(c, velo, bon);
      expect(t3.periodes).toEqual(['WARRANTY']);
      expect(t3.faits).toEqual(['period.warranty']);
      // La lecture n'a RIEN écrit (le stock est exactement celui d'avant) et n'a appelé aucun modèle.
      expect(await periodes(bon)).toEqual(stockAvant);
      expect(await appelsIa(c)).toBe(ia0);

      // Une PREMIÈRE campagne de cohérence « à blanc » (ce qui s'est passé en préproduction le 21/11 à 5 h) ne retire
      // rien du stock — et cela ne change plus rien à ce que l'utilisateur voit.
      const blanc = await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN', today: AUJ });
      expect(blanc.results[CHECK]).toMatchObject({ WOULD_REPAIR: 1 });
      const constat = await proofOf(sql, c.id, CHECK, bon);
      expect(constat?.finding).toMatchObject({ anomaly: 'BUSINESS_PERIODS_POINT_DATE_COPY' });
      expect(JSON.stringify(constat?.finding)).toContain(motif);
      expect(await periodes(bon)).toEqual(stockAvant);
      expect((await lire(c, bon)).lignes.join(' | ')).not.toMatch(/validité/i);

      // ── REPRISE de l'exploitant : à blanc (rapport), réelle (retrait avec motif), rejouée (rien) ───────────────
      const { reprisePointDateValidities } = await reprise();
      const aBlanc = await reprisePointDateValidities(c.id);
      expect(aBlanc).toMatchObject({ apply: false, toRetire: 1, retired: 0, toReview: 0, remaining: false });
      expect(aBlanc.documents).toEqual([{
        fileId: bon, toReview: [], after: null,
        before: [{ periodId: x.validite, kind: 'VALIDITY', start: JOUR, end: null, date: JOUR, roles: expect.arrayContaining(['DOCUMENT_DATE', 'T1_DOCUMENT_DATE', 'OPERATION_DATE']), reason: motif }],
      }]);
      expect(await periodes(bon)).toEqual(stockAvant);
      const reel = await reprisePointDateValidities(c.id, { apply: true });
      expect(reel).toMatchObject({ apply: true, toRetire: 1, retired: 1 });
      expect(reel.documents[0].after).toEqual({ outcome: 'UPDATED', retired: [x.validite], remaining: [] });
      expect(reel.correlationId).toMatch(/^reprise-812:/);
      // La ligne est RETIRÉE, pas supprimée : toujours en base, motif général, motif précis, corrélation.
      const apres = await periodes(bon);
      expect(apres.find((p) => p.id === x.validite)).toMatchObject({ status: 'SUPERSEDED', reason: 'POINT_DATE_COPY', detail: motif, correlation: reel.correlationId });
      expect(apres).toHaveLength(stockAvant.length);
      const rejeu = await reprisePointDateValidities(c.id, { apply: true });
      expect(rejeu).toMatchObject({ toRetire: 0, retired: 0, documents: [] });
      expect(await periodes(bon)).toEqual(apres);

      // ── INTACTS : dates ponctuelles, titre, montant, connaissance T1, faits légitimes, correction de l'utilisateur ─
      const intacts = async () => {
        const [f] = await sql<Json[]>`SELECT document_date::text AS d, retained_title AS t, amount_cents AS m, deleted_at FROM asset_files WHERE id = ${bon}`;
        expect(f).toEqual({ d: JOUR, t: TITRE, m: 999, deleted_at: null });
        // La garantie du MÊME document : toujours établie, une seule fois, mêmes bornes.
        expect((await actives(bon)).filter((p) => p[0] === 'WARRANTY')).toEqual([['WARRANTY', JOUR, '2028-11-17', 'T1', false]]);
        // La garantie d'une AUTRE pièce et la validité RÉELLE du devis du même compte.
        expect((await periodes(x.facture)).map((p) => [p.id, p.status])).toEqual([[x.garantieFacture, 'ACTIVE']]);
        expect((await periodes(x.devis)).map((p) => [p.id, p.status])).toEqual([[x.validiteDevis, 'ACTIVE']]);
        expect((await lire(c, x.devis)).principal).toBe('Période de validité : du 03/11/2026 au 03/12/2026');
        expect((await lire(c, x.facture)).principal).toBe('Période de garantie : du 02/03/2026 au 02/03/2028');
        // La correction de l'utilisateur (même jour que la date du document) : affichée, jamais touchée.
        expect(await actives(x.corrige)).toEqual([['VALIDITY', JOUR, null, 'USER', true]]);
        const vc = await lire(c, x.corrige);
        expect(vc.principal).toBe(LIGNE_KO);
        expect(vc.brut.principal.segments[0].userCorrected).toBe(true);
      };
      await intacts();
      // La lecture et la reprise n'ont pas réécrit la garantie du même document : c'est la MÊME ligne qu'avant.
      expect((await periodes(bon)).find((p) => p.id === x.garantie)).toMatchObject({ status: 'ACTIVE', maj: stockAvant.find((p) => p.id === x.garantie)!.maj });
      // Connaissance T1 : rien n'est supprimé ni modifié (le fait de validité reste un fait T1, il ne crée plus rien).
      const [{ n: faitsActifs }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_facts WHERE file_id = ${bon} AND status = 'active'`;
      expect(faitsActifs).toBe(2);

      // ── RÉINTRODUCTION : T1 rend de nouveau la validité d'un jour, T3 et T4 repassent, la cohérence corrige ─────
      const reanalyser = async (f: Fait) => {
        await k.t1(c, bon, [commande(velo.id)], true);
        await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${bon} AND status = 'active'`;
        await faits(c, bon, [f, { key: 'period.warranty', value: `${JOUR}/2028-11-17`, excerpt: 'Garantie 2 ans, jusqu’au 17/11/2028' }]);
        await analyse(c, bon, { jour: JOUR, extrait: MENTION_DATE, titre: TITRE, type: 'ACQUISITION_ORDER' });
        // Étape du pipeline T1 après la persistance de l'analyse (même appel que `source-analysis/pipeline`).
        const r = await (await svc()).refreshDocumentBusinessPeriods(c.id, bon);
        await passerT3(c);
        await projeterT4(c);
        const coh = await runCoherenceFor(sql, [c.id], { mode: 'CORRECTIVE', today: AUJ });
        return { r, coh };
      };
      const constatsPropres = async () => {
        // Ni la période (aucune ligne VALIDITY active, aucune ligne nouvelle), ni la ligne affichée…
        const lignesValidite = (await periodes(bon)).filter((p) => p.kind === 'VALIDITY');
        expect(lignesValidite.map((p) => [p.id, p.status])).toEqual([[x.validite, 'SUPERSEDED']]);
        const v = await lire(c, bon);
        expect(v.principal).toBe('Période de garantie : du 17/11/2026 au 17/11/2028');
        expect(v.lignes.join(' | ')).not.toMatch(/validité/i);
        const s = await surfaces(c, bon);
        expect(`${s.liste} ${s.resume.join(' ')} ${s.dossier} ${s.assistant}`).not.toMatch(/validité/i);
        // … ni un fait consommé ailleurs : contexte T3, Agenda, dates de l'opération.
        const t = await contexteT3(c, velo, bon);
        expect(t.periodes).toEqual(['WARRANTY']);
        expect(t.faits).toEqual(['period.warranty']);
        // Aucun élément d'Agenda ni échéance pour le bon de commande ; l'événement LÉGITIME du compte (l'achat du vélo,
        // facture du 02/03/2026) est exactement celui d'avant.
        expect(await agendaDe(c, bon)).toEqual([]);
        // (Identité, dates et opération : l'intitulé d'un événement d'achat relève des contrôles de la carte #821.)
        const cle = (e: Json) => [e.id, e.debut, e.fin, e.op];
        expect((await agenda(c)).map(cle)).toEqual(agendaAvant.map(cle));
        expect((await agenda(c)).some((e) => e.debut === JOUR || e.fin === JOUR)).toBe(false);
        for (const o of await operationsDe(c, bon)) expect(o).toMatchObject({ debut: null, fin: null, prevue: null });
        await intacts();
      };
      // 1re nouvelle analyse : SANS « mention propre » (la mention est celle de la date du document).
      const sans = await reanalyser({ key: 'period.validity', value: `${JOUR}/`, excerpt: MENTION_DATE });
      // (La garantie est requalifiée depuis le nouveau fait T1 de la nouvelle analyse : c'est la seule ligne écrite.)
      expect(sans.r.pointDateCopies).toBeUndefined();
      expect(sans.coh.results[CHECK].REPAIRED).toBeUndefined();
      await constatsPropres();
      // 2e nouvelle analyse : AVEC « mention propre », et sous la forme début = fin (validité « d'un jour »).
      const avec = await reanalyser({ key: 'period.validity', value: `${JOUR}/${JOUR}`, excerpt: MENTION_PROPRE, start: JOUR, end: JOUR });
      expect(avec.r.pointDateCopies).toBeUndefined();
      expect(avec.coh.results[CHECK].REPAIRED).toBeUndefined();
      await constatsPropres();
      // Le bon de commande est bien resté rattaché à une opération du vélo, sans échéance.
      expect((await operationsDe(c, bon)).length).toBeGreaterThan(0);
      // AUCUN appel d'IA sur tout le parcours (lectures, campagne, reprise, requalifications).
      expect(await appelsIa(c)).toBe(ia0);
      const [{ n: iaReprise }] = await sql<{ n: number }[]>`SELECT COALESCE(sum(ai_calls), 0)::int AS n FROM coherence_repairs WHERE account_id = ${c.id} AND check_id = ${CHECK}`;
      expect(iaReprise).toBe(0);
    });
  });

  it('L116F-E2E-11 — autres états du stock : fait T1 disparu, fin seule à réexaminer, autre date, titrage, isolation, ciblage, pagination', async () => {
    const c = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const velo = await make.asset(c, { category: 'OBJET', name: 'Jean Fourche' });
    const veloAutre = await make.asset(autre, { category: 'OBJET', name: 'Vélo' });
    const bonDe = async (compte: AccountRow, v: AssetRow, titre: string) => {
      const id = await k.document(compte, v.id, [commande(v.id)], { type: 'ACQUISITION_ORDER', title: titre, amountCents: 999, date: JOUR });
      await analyse(compte, id, { jour: JOUR, extrait: MENTION_DATE, titre, type: 'ACQUISITION_ORDER' });
      return id;
    };
    // A — le fait T1 a DISPARU (remplacé hors pipeline) : la ligne du stock est classée sur ses propres bornes et sa propre preuve.
    const a = await bonDe(c, velo, 'Bon A');
    const [fa] = await faits(c, a, [{ key: 'period.validity', value: `${JOUR}/`, excerpt: MENTION_PROPRE }]);
    const pa = await stock(c, a, { kind: 'VALIDITY', start: JOUR, end: null, factId: fa, quote: MENTION_PROPRE });
    await sql`UPDATE document_facts SET status = 'superseded' WHERE id = ${fa}`;
    // B — FIN SEULE le jour du document, mention propre : non tranché par le PO, conservée « à réexaminer » et affichée.
    const b = await bonDe(c, velo, 'Bon B');
    const [fb] = await faits(c, b, [{ key: 'period.validity', value: `/${JOUR}`, excerpt: 'Offre valable jusqu’au 17/11/2026' }]);
    const pb = await stock(c, b, { kind: 'VALIDITY', start: null, end: JOUR, factId: fb, quote: 'Offre valable jusqu’au 17/11/2026' });
    // C — début seul à une AUTRE date que celle du document : borne propre, conservée et affichée.
    const cc = await bonDe(c, velo, 'Bon C');
    const [fc] = await faits(c, cc, [{ key: 'period.validity', value: '2026-12-01/', excerpt: 'Valable à compter du 01/12/2026' }]);
    const pc = await stock(c, cc, { kind: 'VALIDITY', start: '2026-12-01', end: null, factId: fc, quote: 'Valable à compter du 01/12/2026' });
    // D — second document artificiel du compte (pagination), fait présent, période T1 rendue en début = fin (colonnes de période du fait).
    const d = await bonDe(c, velo, 'Bon D');
    const [fd] = await faits(c, d, [{ key: 'period.validity', value: `${JOUR}/${JOUR}`, excerpt: MENTION_PROPRE, start: JOUR, end: JOUR }]);
    const pdd = await stock(c, d, { kind: 'VALIDITY', start: JOUR, end: JOUR, factId: fd, quote: MENTION_PROPRE });
    // Z — autre compte : même défaut.
    const z = await bonDe(autre, veloAutre, 'Bon Z');
    const [fz] = await faits(autre, z, [{ key: 'period.validity', value: `${JOUR}/`, excerpt: MENTION_DATE }]);
    const pz = await stock(autre, z, { kind: 'VALIDITY', start: JOUR, end: null, factId: fz, quote: MENTION_DATE });

    // LECTURE, sans rien attendre.
    expect((await lire(c, a)).principal).toBeNull();
    expect((await lire(c, b)).principal).toBe('Fin de validité : 17/11/2026');
    expect((await lire(c, cc)).principal).toBe('Début de validité : 01/12/2026');
    expect((await lire(c, d)).principal).toBeNull();
    expect((await lire(autre, z)).principal).toBeNull();
    const { readPrincipalPeriodLines } = await svc();
    expect([...(await readPrincipalPeriodLines(c.id, [a, b, cc, d])).keys()].sort((p, q) => p - q)).toEqual([b, cc]);

    // TITRAGE : la validité d'un jour (début = fin = date du document) n'est pas une période qui nomme le document.
    const titres = await import('@/services/documents/document-title.service');
    const entrees = await titres.loadPersistedTitleInputs(d, c.id);
    expect(entrees).not.toBeNull();
    const plan = await titres.planTitleForDocument(d, c.id, entrees!);
    expect(plan.basis.billedPeriod).toBeNull();
    expect(plan.plan.title ?? '').not.toMatch(/17\/11|17 novembre|2026/);

    // REPRISE ciblée sur UN document, à blanc puis réelle ; un document d'un autre compte n'existe pas.
    const { reprisePointDateValidities } = await reprise();
    expect(await reprisePointDateValidities(c.id, { fileId: z, apply: true })).toMatchObject({ examined: 0, toRetire: 0, retired: 0 });
    const cibleA = await reprisePointDateValidities(c.id, { fileId: a, apply: true });
    expect(cibleA).toMatchObject({ examined: 1, toRetire: 1, retired: 1 });
    expect(cibleA.documents[0].before[0]).toMatchObject({ periodId: pa, reason: 'DOCUMENT_DATE_RESTATED' });
    const etat = async (id: number) => (await sql<Json[]>`SELECT status, superseded_reason AS reason, superseded_detail AS detail FROM document_business_periods WHERE id = ${id}`)[0];
    expect(await etat(pa)).toEqual({ status: 'SUPERSEDED', reason: 'POINT_DATE_COPY', detail: 'DOCUMENT_DATE_RESTATED' });
    expect(await etat(pdd)).toEqual({ status: 'ACTIVE', reason: null, detail: null });
    // PAGINATION : une page d'un document, puis la suivante ; B est signalé « à réexaminer », jamais retiré.
    const p1 = await reprisePointDateValidities(c.id, { apply: true, limit: 1 });
    expect(p1).toMatchObject({ examined: 1, remaining: true });
    expect(p1.nextAfterFileId).not.toBeNull();
    let page = p1;
    const vus = [...p1.documents];
    while (page.remaining && page.nextAfterFileId !== null) {
      page = await reprisePointDateValidities(c.id, { apply: true, limit: 1, afterFileId: page.nextAfterFileId });
      vus.push(...page.documents);
    }
    expect(vus.map((x) => x.fileId)).toEqual([b, d]);
    expect(vus.find((x) => x.fileId === b)).toMatchObject({ before: [], toReview: [{ periodId: pb }], after: null });
    expect(await etat(pb)).toEqual({ status: 'ACTIVE', reason: null, detail: null });
    expect(await etat(pc)).toEqual({ status: 'ACTIVE', reason: null, detail: null });
    expect(await etat(pdd)).toEqual({ status: 'SUPERSEDED', reason: 'POINT_DATE_COPY', detail: 'DOCUMENT_DATE_RESTATED' });
    // ISOLATION : l'autre compte n'a pas été touché par la reprise du premier (sa lecture, elle, est déjà correcte).
    expect(await etat(pz)).toEqual({ status: 'ACTIVE', reason: null, detail: null });
    const { pointDateRepriseAccounts } = await reprise();
    expect(await pointDateRepriseAccounts(sql)).toEqual(expect.arrayContaining([c.id, autre.id]));
  });

  it('L116F-E2E-12 — aucun cache de cette lecture : la route rend l’état courant à chaque appel, en-tête « no-cache »', async () => {
    const c = await make.account({ plan: 'premium' });
    const velo = await make.asset(c, { category: 'OBJET', name: 'Jean Fourche' });
    const id = await k.document(c, velo.id, [commande(velo.id)], { type: 'ACQUISITION_ORDER', title: TITRE, amountCents: 999, date: JOUR });
    await analyse(c, id, { jour: JOUR, extrait: MENTION_DATE, titre: TITRE, type: 'ACQUISITION_ORDER' });
    const [f] = await faits(c, id, [{ key: 'period.validity', value: '2026-12-01/', excerpt: 'Valable à compter du 01/12/2026' }]);
    const p = await stock(c, id, { kind: 'VALIDITY', start: '2026-12-01', end: null, factId: f, quote: 'Valable à compter du 01/12/2026' });
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/periodes/route');
    const r1 = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), ctx(id));
    expect(r1.headers.get('cache-control')).toBe('private, no-cache');
    expect((await r1.json()).periods.principal.line).toBe('Début de validité : 01/12/2026');
    // L'état change en base (retrait) : la lecture suivante le rend aussitôt, sans rien d'intermédiaire.
    await sql`UPDATE document_business_periods SET status = 'SUPERSEDED', superseded_at = now() WHERE id = ${p}`;
    const r2 = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), ctx(id));
    expect((await r2.json()).periods.principal).toBeNull();
  });

  it('L116F-E2E-13 — requêtes de diagnostic de la fiche de recette : lecture seule, exécutées telles quelles sur le schéma réel', async () => {
    const x = await casReel(MENTION_PROPRE);
    const { c, bon } = x;
    await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN', today: AUJ });
    const fiche = readFileSync(join(process.cwd(), 'docs/exploitation/recette-116f-periodes-validite-artificielles.md'), 'utf8');
    const section = fiche.slice(fiche.indexOf('### 11.6 Requêtes de diagnostic'));
    const requetes = [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1].trim());
    expect(requetes).toHaveLength(6);
    const lancer = async (q: string) => {
      // Lecture seule : une seule instruction SELECT, aucun mot d'écriture.
      expect(q).toMatch(/^SELECT\b/);
      expect(q.replace(/;\s*$/, '')).not.toMatch(/;/);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY|CALL|DO)\b/);
      return (await sql.unsafe(q.replace(/:account_id\b/g, String(c.id)).replace(/:file_id\b/g, String(bon)))) as unknown as Json[];
    };
    const avant = await Promise.all(requetes.map(lancer));
    // 1 — le fait VALIDITY est encore persisté (ACTIVE, non corrigé par l'utilisateur).
    expect(avant[0].map((r) => [r.period_kind, r.status, r.user_locked, r.superseded_reason])).toEqual([['VALIDITY', 'ACTIVE', false, null], ['WARRANTY', 'ACTIVE', false, null]]);
    expect(avant[0][0]).toMatchObject({ id: String(x.validite), start_on: JOUR, end_on: null, origin: 'T1', extrait: MENTION_PROPRE });
    // 2 — les dates auxquelles la règle compare.
    expect(avant[1]).toHaveLength(1);
    expect(avant[1][0]).toMatchObject({ date_lue_par_t1: JOUR, dates_operation_t1: JOUR, document_type_code: 'ACQUISITION_ORDER' });
    expect(new Date(avant[1][0].document_date).toISOString().slice(0, 10)).toBe(JOUR);
    // 3 — les faits `period.*` rendus par T1.
    expect(avant[2].map((r) => [r.cle, r.status, r.normalized_value])).toEqual([['period.validity', 'active', `${JOUR}/`], ['period.warranty', 'active', `${JOUR}/2028-11-17`]]);
    // 4 — chronologie : une analyse, une validité créée (T1), aucune retirée.
    expect(avant[3].map((r) => r.quoi).sort()).toEqual(['analyse T1', 'validité créée']);
    // 5 — contrôle de cohérence : constat du document vu À BLANC (non corrigé), campagne listée.
    expect(avant[4].find((r) => r.quoi === 'constat du document')).toMatchObject({ mode: 'DRY_RUN', resultat: 'WOULD_REPAIR', version: '2' });
    expect(avant[4].some((r) => String(r.quoi).startsWith('campagne MANUAL'))).toBe(true);
    // 6 — une opération rattachée, sans début ni fin ; aucun élément d'Agenda.
    expect(avant[5].map((r) => r.quoi)).toEqual(['opération']);
    expect(avant[5][0]).toMatchObject({ debut: null, fin: null });

    // Après la reprise : la requête 1 montre le retrait tracé, la requête 4 la ligne « validité retirée ».
    const { reprisePointDateValidities } = await reprise();
    const r = await reprisePointDateValidities(c.id, { apply: true });
    const apres = await Promise.all(requetes.map(lancer));
    expect(apres[0].find((p) => p.period_kind === 'VALIDITY')).toMatchObject({
      status: 'SUPERSEDED', superseded_reason: 'POINT_DATE_COPY', superseded_detail: 'DOCUMENT_DATE_RESTATED', superseded_correlation_id: r.correlationId,
    });
    expect(apres[3].map((p) => p.quoi).sort()).toEqual(['analyse T1', 'validité créée', 'validité retirée']);
    expect(apres[5].map((p) => p.quoi)).toEqual(['opération']);
  });
  it('L116F-E2E-14 — le script de reprise de l’exploitant : usage, à blanc par défaut, ciblage, application, rejeu, rapport', async () => {
    const x = await casReel(MENTION_PROPRE);
    const { c, bon } = x;
    const dossier = mkdtempSync(join(tmpdir(), 'reprise-812-'));
    const lancer = async (args: string[]) => {
      try {
        const r = await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/reprise-812-validites-artificielles.ts', ...args], {
          cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL! }, timeout: 120_000,
        });
        return { code: 0, sortie: `${r.stdout}${r.stderr}` };
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        return { code: err.code ?? 1, sortie: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    };
    const etat = async () => (await periodes(bon)).map((p) => [p.id, p.status, p.reason, p.detail]);
    const avant = await etat();
    // Sans compte ni `--all` : usage, rien n'est fait.
    const usage = await lancer([]);
    expect(usage.code).toBe(2);
    expect(usage.sortie).toMatch(/Usage : reprise-812-validites-artificielles\.ts --account=<id> \[--file=<id>\] \| --all \[--apply\]/);
    // À BLANC par défaut : rapport avant / après prévu, aucune écriture.
    const rapportBlanc = join(dossier, 'blanc.json');
    const blanc = await lancer([`--account=${c.id}`, `--report=${rapportBlanc}`]);
    expect(blanc.code).toBe(0);
    expect(blanc.sortie).toContain(`document ${bon} — AVANT : période ${x.validite} (VALIDITY, début ${JOUR}, fin –)`);
    expect(blanc.sortie).toMatch(/motif DOCUMENT_DATE_RESTATED — APRÈS : serait retirée \(à blanc\)/);
    expect(blanc.sortie).toMatch(/1 période\(s\) artificielle\(s\), 0 à réexaminer.*\(à blanc : rien n’est écrit\)/);
    expect(await etat()).toEqual(avant);
    const lu = JSON.parse(readFileSync(rapportBlanc, 'utf8')) as Json[];
    expect(lu).toHaveLength(1);
    expect(lu[0]).toMatchObject({ accountId: c.id, apply: false, toRetire: 1, retired: 0 });
    expect(lu[0].documents[0]).toMatchObject({ fileId: bon, after: null, before: [{ periodId: x.validite, reason: 'DOCUMENT_DATE_RESTATED' }] });
    // Ciblé sur un AUTRE document du compte (le devis) : rien à retirer, rien n'est écrit, même avec `--apply`.
    const autre = await lancer([`--account=${c.id}`, `--file=${x.devis}`, '--apply', `--report=${join(dossier, 'devis.json')}`]);
    expect(autre.code).toBe(0);
    expect(autre.sortie).toMatch(/0 document\(s\) examiné\(s\), 0 période\(s\) artificielle\(s\)/);
    expect(await etat()).toEqual(avant);
    // RÉEL, ciblé sur le bon de commande : la ligne est retirée (conservée en base), avec motif et corrélation.
    const reel = await lancer([`--account=${c.id}`, `--file=${bon}`, '--apply', `--report=${join(dossier, 'reel.json')}`]);
    expect(reel.code).toBe(0);
    expect(reel.sortie).toMatch(/APRÈS : retirée \(conservée en base, SUPERSEDED\)/);
    expect(reel.sortie).toMatch(/retirées 1, restantes 0 \(corrélation reprise-812:/);
    const apres = await periodes(bon);
    expect(apres.find((p) => p.id === x.validite)).toMatchObject({ status: 'SUPERSEDED', reason: 'POINT_DATE_COPY', detail: 'DOCUMENT_DATE_RESTATED' });
    expect(String(apres.find((p) => p.id === x.validite)!.correlation)).toMatch(new RegExp(`^reprise-812:${c.id}:`));
    expect((await lire(c, bon)).lignes.join(' | ')).not.toMatch(/validité/i);
    // REJOUÉ sur tout le compte : plus rien (idempotent) ; la correction de l'utilisateur et le devis n'ont pas bougé.
    const rejeu = await lancer([`--account=${c.id}`, '--apply', `--report=${join(dossier, 'rejeu.json')}`]);
    expect(rejeu.code).toBe(0);
    expect(rejeu.sortie).toMatch(/0 période\(s\) artificielle\(s\).*retirées 0, restantes 0/);
    expect(JSON.parse(readFileSync(join(dossier, 'rejeu.json'), 'utf8'))).toEqual([]);
    expect(await actives(x.corrige)).toEqual([['VALIDITY', JOUR, null, 'USER', true]]);
    expect((await periodes(x.devis)).map((p) => [p.id, p.status])).toEqual([[x.validiteDevis, 'ACTIVE']]);
  }, 600_000);
  it('L116F-E2E-15 — délai du moteur (règle A6, mode AUTO) : la version 2 ne corrige qu’après une campagne quotidienne complète ; la lecture est correcte entre-temps', async () => {
    const x = await casReel(MENTION_DATE);
    const { c, bon } = x;
    const orch = await import('@/services/coherence/orchestrator');
    // Sans réglage explicite, le mode est AUTO (c'est ce que ce test décrit) ; un réglage de la machine ne doit pas le fausser.
    const reglage = process.env.COHERENCE_CAMPAIGN_MODE;
    delete process.env.COHERENCE_CAMPAIGN_MODE;
    try {
      expect(orch.coherenceModeSetting()).toBe('AUTO');
      const quotidienne = (jour: string, mode: string, version: number) => sql`
        INSERT INTO coherence_campaigns (kind, mode, campaign_date, trigger_code, registry_version, checks, status, phase, started_at, finished_at)
        VALUES ('DAILY', ${mode}, ${jour}::date, 'schedule', 'e2e', ${JSON.stringify([{ id: CHECK, version, ...(version === 2 ? { dryRun: true } : {}) }])}::jsonb, 'COMPLETE', 'DONE', ${`${jour}T05:00:00Z`}, ${`${jour}T06:00:00Z`})`;
      // Préproduction AVANT le déploiement du 20/11 : des campagnes quotidiennes complètes ont exécuté la version 1.
      await quotidienne('2026-11-19', 'DRY_RUN', 1);
      await quotidienne('2026-11-20', 'CORRECTIVE', 1);
      expect(await orch.resolveCoherenceMode(sql)).toBe('CORRECTIVE');
      const campagne = async () => {
        const id = await orch.startCampaign({ kind: 'MANUAL', trigger: 'e2e-812-a6', scopeAccountIds: [c.id] });
        for (let i = 0; i < 40; i++) { if ((await orch.runCampaignStep(id, { deadline: Date.now() + 120_000, today: AUJ })).done) break; }
        const camp = (await orch.getCampaign(id))!;
        return { mode: camp.mode, effectif: orch.effectiveCheckMode(camp, CHECK), constat: await proofOf(sql, c.id, CHECK, bon) };
      };
      const stockAvant = (await periodes(bon)).map((p) => [p.id, p.status, p.reason]);
      // 1er passage après le déploiement (le 21/11 à 5 h, ou « Exécuter » dans le BO) : campagne corrective, mais ce contrôle
      // est exécuté À BLANC (version 2 non qualifiée) — il VOIT la copie et ne retire rien.
      const premier = await campagne();
      expect(premier).toMatchObject({ mode: 'CORRECTIVE', effectif: 'DRY_RUN', constat: { last_result: 'WOULD_REPAIR', last_mode: 'DRY_RUN' } });
      expect((await periodes(bon)).map((p) => [p.id, p.status, p.reason])).toEqual(stockAvant);
      // Une campagne MANUELLE ne qualifie pas le contrôle : la suivante est encore à blanc.
      const deuxieme = await campagne();
      expect(deuxieme).toMatchObject({ effectif: 'DRY_RUN', constat: { last_result: 'WOULD_REPAIR' } });
      expect((await periodes(bon)).map((p) => [p.id, p.status, p.reason])).toEqual(stockAvant);
      // Pendant tout ce délai, la fiche ne restitue PAS la validité (règle à la lecture).
      expect((await lire(c, bon)).lignes.join(' | ')).not.toMatch(/validité/i);
      // Une campagne QUOTIDIENNE complète a exécuté la version 2 (à blanc) : le contrôle est qualifié, le passage suivant corrige.
      await quotidienne('2026-11-21', 'CORRECTIVE', 2);
      const troisieme = await campagne();
      expect(troisieme).toMatchObject({ effectif: 'CORRECTIVE', constat: { last_result: 'REPAIRED' } });
      expect((await periodes(bon)).find((p) => p.id === x.validite)).toMatchObject({ status: 'SUPERSEDED', reason: 'POINT_DATE_COPY', detail: 'SAME_MENTION_AS_POINT_DATE' });
    } finally {
      if (reglage === undefined) delete process.env.COHERENCE_CAMPAIGN_MODE; else process.env.COHERENCE_CAMPAIGN_MODE = reglage;
      await sql`DELETE FROM coherence_campaigns WHERE kind = 'DAILY' AND registry_version = 'e2e' AND campaign_date IN ('2026-11-19', '2026-11-20', '2026-11-21')`;
    }
  }, 600_000);
});
