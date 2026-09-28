/**
 * Mascotte d'accueil — recette complémentaire (CDC Mascotte §23) et écarts
 * d'audit : ATP-02, ATP-03, DONE-02, CACHE-03, DUO-01, ERR-02, SEC-01,
 * §20 « action déjà résolue », REC-005, SEC-004, NFR-001, BO-009, LOG-005.
 *
 * La base est simulée : chaque requête est routée selon son texte vers un
 * petit état en mémoire (échéances, acquittements, actions « À traiter »).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';

// ── Base simulée ─────────────────────────────────────────────────────────────

interface Ack { account: number; occurrenceKey: string; cycleKey: string; undone: boolean; by: number; at: Date }
const etat = {
  agenda: new Map<number, { account: number; date: string; manualStatus: string | null; title: string }>(),
  acks: [] as Ack[],
  toProcess: new Map<string, { account: number; resolved: boolean }>(),
  suppliers: new Map<number, { account: number }>(),
  assets: new Map<number, { account: number }>(),
};
const sqlLog: string[] = [];
const callLog: Array<{ sql: string; p: unknown[] }> = [];

async function unsafe(sql: string, p: unknown[] = []): Promise<unknown[]> {
  sqlLog.push(sql);
  callLog.push({ sql, p });
  if (/INSERT INTO home_mascot_acknowledgments/.test(sql)) {
    const [account, occurrenceKey, , cycleKey, by] = p as [number, string, number, string, number];
    const exist = etat.acks.find((a) => a.account === account && a.occurrenceKey === occurrenceKey && a.cycleKey === cycleKey && !a.undone);
    if (exist) return [{ acknowledged_at: exist.at.toISOString() }];
    const at = new Date();
    etat.acks.push({ account, occurrenceKey, cycleKey, undone: false, by, at });
    return [{ acknowledged_at: at.toISOString() }];
  }
  if (/UPDATE home_mascot_acknowledgments/.test(sql)) {
    const [account, occurrenceKey, cycleKey] = p as [number, string, string];
    const a = etat.acks.find((x) => x.account === account && x.occurrenceKey === occurrenceKey && x.cycleKey === cycleKey && !x.undone);
    if (!a) return [];
    a.undone = true;
    return [{ acknowledged_at: a.at.toISOString() }];
  }
  if (/FROM home_mascot_acknowledgments/.test(sql)) {
    const [account] = p as [number];
    // Aucune notion d'utilisateur : l'acquittement est celui du compte (DONE-004).
    return etat.acks.filter((a) => a.account === account && !a.undone)
      .map((a) => ({ occurrenceKey: a.occurrenceKey, cycleKey: a.cycleKey }));
  }
  if (/to_char\(start_date, 'YYYY-MM-DD'\) AS date/.test(sql)) {
    const [id, account] = p as [number, number];
    const i = etat.agenda.get(id);
    return i && i.account === account && !i.manualStatus ? [{ date: i.date }] : [];
  }
  if (/SELECT manual_status FROM agenda_items/.test(sql)) {
    const [id, account] = p as [number, number];
    const i = etat.agenda.get(id);
    return i && i.account === account ? [{ manual_status: i.manualStatus }] : [];
  }
  if (/FROM agenda_items i/.test(sql)) {
    const [account] = p as [number];
    return [...etat.agenda.entries()]
      .filter(([, i]) => i.account === account && !i.manualStatus)
      .map(([id, i]) => ({
        id, title: i.title, date: i.date, occurrenceNature: 'CONFIRMED', requiresQualification: false,
        homeCategory: 'action', originType: 'manual', assetId: null, assetName: null,
      }));
  }
  if (/FROM to_process_actions WHERE public_id/.test(sql)) {
    const [publicId, account] = p as [string, number];
    const a = etat.toProcess.get(publicId);
    return a && a.account === account ? [{ resolved_at: a.resolved ? new Date() : null }] : [];
  }
  if (/SELECT DISTINCT target_id FROM to_process_actions/.test(sql)) return [];
  if (/FROM suppliers WHERE id/.test(sql)) {
    const [id, account] = p as [number, number];
    return etat.suppliers.get(id)?.account === account ? [{ '?column?': 1 }] : [];
  }
  if (/FROM asset_files WHERE id = \$1/.test(sql)) return [];
  if (/FROM assets WHERE id = \$1/.test(sql)) {
    const [id, account] = p as [number, number];
    return etat.assets.get(id)?.account === account ? [{ '?column?': 1 }] : [];
  }
  if (/FROM assets\s+WHERE account_id = \$1 AND deleted_at IS NULL/.test(sql)) {
    return [{ id: 1, name: 'Maison', total: 1 }];
  }
  if (/SELECT EXISTS/.test(sql)) return [{ present: true }];
  if (/COUNT\(\*\) FROM assets WHERE account_id/.test(sql)) return [{ assets: 1, documents: 3 }];
  return [];
}

vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) }, db: {} }));

const toProcessPage = vi.fn(async (_account: number, _o?: unknown) => ({ actions: [] as ToProcessActionView[] }));
vi.mock('@/services/to-process/to-process-query.service', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getToProcessPage: (a: number, o: unknown) => toProcessPage(a, o),
}));
const entitlements = vi.fn(async (_a: number) => ({ canWrite: true, quotas: { maxAssets: 10, maxDocuments: 150 } }));
vi.mock('@/services/entitlements.service', () => ({ getEntitlements: (a: number) => entitlements(a) }));

const execute = vi.fn();
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute: (r: unknown) => execute(r) } }));
vi.mock('@/services/ai/config/config-resolver', () => ({ resolveOperationConfig: async () => ({ promptPreamble: 'voix', configVersionId: 3 }) }));
vi.mock('@/services/ai/prompts/prompt-loader', () => ({ resolvePrompt: async () => ({ text: '', version: 'mascot_t6_v1@file' }) }));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));
const opened: unknown[] = [];
vi.mock('@/lib/drawers', () => ({ openDrawer: (d: unknown) => { opened.push(d); } }));

const { acknowledgeOccurrence, undoAcknowledgment, checkTarget } = await import('../actions.service');
const { collectMascotData, MASCOT_TO_PROCESS_LIMIT } = await import('../collector');
const { buildCandidates, extActionOccurrenceKey, mascotRightsFrom } = await import('../signals');
const { buildSecondaries, selectSubjects } = await import('../selector');
const { buildPresentation } = await import('../presentation');
const { getMascotPresentation, scheduleMascotPregeneration, pendingPregenerations } = await import('../mascot.service');
const { t6CacheKey, readT6Cache, formulateWithT6, logT6, gatewayCallerMode, resetT6Breaker } = await import('../t6-runner');
const { buildT6Input } = await import('../t6-contract');
const { openToProcessTarget } = await import('@/lib/to-process-target');
const { resolveSupplierContexts } = await import('@/services/to-process/to-process-query.service');

const NOW = new Date('2026-09-25T10:00:00Z');
type Raw = Parameters<typeof buildCandidates>[0];

async function presenter(accountId: number) {
  const raw = await collectMascotData(accountId, NOW);
  const c = buildCandidates(raw);
  const subjects = selectSubjects(c.candidates);
  return buildPresentation({ subjects, secondaries: buildSecondaries(c, subjects), degraded: c.degraded, messages: null });
}

let n = 0;
function atp(over: Partial<ToProcessActionView> = {}): ToProcessActionView {
  n += 1;
  return {
    publicId: `p-${n}`, targetType: 'DOCUMENT', targetId: 100 + n, fieldKey: 'documentType', relationKey: null,
    actionKind: 'COMPLETE', priority: 'DO_FIRST', ruleCode: 'DOC-TYP',
    question: 'Quel est le type de ce document ?', proposals: [], allowNotApplicable: false,
    activeSince: '2026-09-20T10:00:00Z',
    target: { label: `Facture ${n}`, publicId: `doc-${n}`, assetId: 1, assetName: 'Maison' },
    ...over,
  };
}

function raw(over: Partial<Raw> = {}): Raw {
  return {
    accountId: 7, today: '2026-09-25',
    processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
    toProcess: [], agenda: [], acknowledgments: [],
    ...over,
  };
}

beforeEach(() => {
  etat.agenda.clear(); etat.acks.length = 0; etat.toProcess.clear(); etat.suppliers.clear(); etat.assets.clear();
  sqlLog.length = 0; callLog.length = 0; opened.length = 0;
  toProcessPage.mockReset();
  toProcessPage.mockImplementation(async () => ({ actions: [] }));
  entitlements.mockReset();
  entitlements.mockImplementation(async () => ({ canWrite: true, quotas: { maxAssets: 10, maxDocuments: 150 } }));
});

// ── ATP-02 / ATP-03 ──────────────────────────────────────────────────────────

describe('À traiter (ATP-02, ATP-03, NFR-001)', () => {
  it('ATP-02 — action résolue depuis le tiroir : « déjà traitée » au clic, disparue au recalcul', async () => {
    const a = atp({ publicId: 'a-1' });
    etat.toProcess.set('a-1', { account: 7, resolved: false });
    toProcessPage.mockImplementation(async () => ({ actions: [a] }));
    const avant = await presenter(7);
    expect(avant.paragraphs.map((x) => x.occurrenceKey)).toContain('ATP:a-1');

    // Résolue dans le tiroir : la source ne la rend plus, la revalidation la dit traitée.
    etat.toProcess.set('a-1', { account: 7, resolved: true });
    toProcessPage.mockImplementation(async () => ({ actions: [] }));
    const cible = avant.paragraphs[0].actions[0].target;
    expect(await checkTarget(7, cible)).toBe('resolved');
    const apres = await presenter(7);
    expect(apres.paragraphs.map((x) => x.occurrenceKey)).not.toContain('ATP:a-1');
  });

  it('ATP-03 — fournisseur résolu : fiche /fournisseurs/[id] ; sinon repli sûr', () => {
    const p = selectSubjects(buildCandidates(raw({
      toProcess: [atp({ targetType: 'SUPPLIER', targetId: 55, target: { label: 'EDF', supplierId: 55 } })],
    })).candidates);
    const t = p[0].actions[0].target;
    expect(t).toMatchObject({ kind: 'to_process', targetType: 'SUPPLIER', supplierId: 55 });

    const push = vi.fn();
    const repli = vi.fn();
    openToProcessTarget(t as Parameters<typeof openToProcessTarget>[0], { push }, repli);
    expect(push).toHaveBeenCalledWith('/fournisseurs/55');
    expect(repli).not.toHaveBeenCalled();

    // Revue sans fournisseur rattaché : `targetId` est l'id de la revue → jamais de fiche.
    push.mockClear();
    openToProcessTarget({ targetType: 'SUPPLIER', targetId: 9, supplierId: null }, { push }, repli);
    expect(push).not.toHaveBeenCalled();
    expect(repli).toHaveBeenCalledTimes(1);
  });

  it('ATP-005 — résolution serveur : fournisseur de la revue, id de revue jamais pris pour un fournisseur', () => {
    const revues = [
      { id: 3, supplierId: 40, detectedName: 'EDF SA' },      // revue rattachée : cible = fournisseur 40
      { id: 12, supplierId: null, detectedName: 'Plombier' },  // revue seule : cible = revue 12
    ];
    const { candidats } = resolveSupplierContexts([40, 12, 77], revues, []);
    expect(candidats.sort()).toEqual([40, 77]);
    // Un fournisseur n°12 existe dans le compte : il n'est PAS celui de l'action.
    const { contexts } = resolveSupplierContexts([40, 12, 77], revues, [
      { id: 40, name: 'EDF' }, { id: 12, name: 'Autre' }, { id: 77, name: 'Historique' },
    ]);
    expect(contexts.get('SUPPLIER:40')).toEqual({ label: 'EDF', supplierId: 40 });
    expect(contexts.get('SUPPLIER:12')).toEqual({ label: 'Plombier', supplierId: null });
    expect(contexts.get('SUPPLIER:77')).toEqual({ label: 'Historique', supplierId: 77 });
  });

  it('ATP-005 / SEC-006 — fournisseur d’un autre compte ou supprimé : « indisponible »', async () => {
    etat.toProcess.set('s-1', { account: 7, resolved: false });
    etat.suppliers.set(55, { account: 8 });
    const t = { kind: 'to_process' as const, publicId: 's-1', targetType: 'SUPPLIER' as const, targetId: 55, targetPublicId: null, field: null, supplierId: 55 };
    expect(await checkTarget(7, t)).toBe('gone');
    etat.suppliers.set(55, { account: 7 });
    expect(await checkTarget(7, t)).toBe('ok');
  });

  it('NFR-001 — lecture « À traiter » bornée à la tête de file, ordre « Par priorité »', async () => {
    await collectMascotData(7, NOW);
    expect(toProcessPage).toHaveBeenCalledWith(7, { orderMode: 'BY_PRIORITY', limit: MASCOT_TO_PROCESS_LIMIT });
    expect(MASCOT_TO_PROCESS_LIMIT).toBeGreaterThanOrEqual(5);
    expect(MASCOT_TO_PROCESS_LIMIT).toBeLessThanOrEqual(20);
  });

  it('ATP-004 avec lecture bornée — une échéance portée par une action non lue n’est pas reprise en date', () => {
    const c = buildCandidates(raw({
      toProcess: [],
      toProcessAgendaIds: [31],
      agenda: [{ id: 31, title: 'Entretien chaudière', date: '2026-10-15', forecast: false, requiresQualification: false, assetId: null, assetName: null }],
    }));
    expect(c.candidates.some((s) => s.sourceFamily === 'DATE')).toBe(false);
  });
});

// ── DONE-02 / DUO-01 ─────────────────────────────────────────────────────────

describe('« C’est fait » (DONE-02, DUO-01)', () => {
  const echeance = () => etat.agenda.set(21, { account: 7, date: '2026-09-20', manualStatus: null, title: 'Vidange' });
  const key = extActionOccurrenceKey(21);

  it('DONE-02 — « C’est fait » puis « Annuler » : la MÊME occurrence est réactivée', async () => {
    echeance();
    const avant = await presenter(7);
    expect(avant.paragraphs.map((p) => p.occurrenceKey)).toContain(key);

    expect(await acknowledgeOccurrence({ accountId: 7, userId: 1, occurrenceKey: key, cycleKey: '2026-09-20' })).toMatchObject({ ok: true });
    expect((await presenter(7)).paragraphs.map((p) => p.occurrenceKey)).not.toContain(key);

    expect(await undoAcknowledgment({ accountId: 7, occurrenceKey: key, cycleKey: '2026-09-20' })).toMatchObject({ ok: true });
    // Annuler ne crée rien : aucune nouvelle ligne, la même clé revient.
    expect(sqlLog.filter((s) => /INSERT INTO home_mascot_acknowledgments/.test(s))).toHaveLength(1);
    const apres = await presenter(7);
    const p = apres.paragraphs.find((x) => x.occurrenceKey === key);
    expect(p).toBeDefined();
    expect(p!.actions.find((a) => a.target.kind === 'done')?.target).toMatchObject({ occurrenceKey: key, cycleKey: '2026-09-20' });
  });

  it('DUO-01 — l’utilisateur A acquitte : l’utilisateur B du même compte ne la voit plus', async () => {
    echeance();
    await acknowledgeOccurrence({ accountId: 7, userId: 1, occurrenceKey: key, cycleKey: '2026-09-20' });
    // B (userId 2) : la prise de parole est calculée pour le compte, sans utilisateur.
    const vueB = await presenter(7);
    expect(vueB.paragraphs.map((p) => p.occurrenceKey)).not.toContain(key);
    expect(sqlLog.some((s) => /FROM home_mascot_acknowledgments/.test(s) && /user_id/.test(s))).toBe(false);
  });
});

// ── CACHE-03 / SEC-01 ────────────────────────────────────────────────────────

describe('pré-génération et cloisonnement (CACHE-03, SEC-01)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('CACHE-03 — deux changements à 1 s d’intervalle : une seule pré-génération, après temporisation', async () => {
    vi.useFakeTimers();
    scheduleMascotPregeneration(7);
    await vi.advanceTimersByTimeAsync(1_000);
    scheduleMascotPregeneration(7);
    expect(pendingPregenerations()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_500);
    // 3,5 s après le premier, 2,5 s après le second : rien n'est encore parti.
    expect(toProcessPage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(pendingPregenerations()).toBe(0);
    expect(toProcessPage).toHaveBeenCalledTimes(1);
  });

  it('SEC-01 — changement de compte Duo : ni sujet ni cache du compte précédent', async () => {
    etat.agenda.set(21, { account: 7, date: '2026-10-20', manualStatus: null, title: 'Vidange' });
    const p7 = await getMascotPresentation(7);
    const p8 = await getMascotPresentation(8);
    expect(p7.paragraphs.some((p) => p.text.includes('Vidange'))).toBe(true);
    expect(p8.paragraphs.some((p) => p.text.includes('Vidange'))).toBe(false);
    // Toutes les lectures du compte 8 sont faites avec le compte 8.
    expect(toProcessPage.mock.calls.map((c) => c[0])).toEqual([7, 8]);

    // Cache T6 : la clé porte le compte, et la lecture filtre sur le compte.
    const input = buildT6Input(selectSubjects(buildCandidates(raw({
      agenda: [{ id: 21, title: 'Vidange', date: '2026-10-20', forecast: false, requiresQualification: false, assetId: null, assetName: null }],
    })).candidates));
    expect(t6CacheKey({ accountId: 7, input, promptVersion: 'v' })).not.toBe(t6CacheKey({ accountId: 8, input, promptVersion: 'v' }));
    callLog.length = 0;
    await readT6Cache(8, 'k', input);
    const lecture = callLog.find((c) => /FROM home_mascot_cache/.test(c.sql))!;
    expect(lecture.sql).toMatch(/account_id = \$1 AND cache_key = \$2/);
    expect(lecture.p[0]).toBe(8);
  });
});

// ── ERR-02 / §20 ─────────────────────────────────────────────────────────────

describe('revalidation au clic (ERR-02, §20)', () => {
  it('ERR-02 — cible supprimée avant le clic : « indisponible » (le client affiche le toast puis recalcule)', async () => {
    expect(await checkTarget(7, { kind: 'drawer', drawer: 'document', id: 404 })).toBe('gone');
    expect(await checkTarget(7, { kind: 'drawer', drawer: 'echeance', id: 404 })).toBe('gone');
    expect(await checkTarget(7, { kind: 'route', href: '/assets/12?tab=exports' })).toBe('gone');
    expect(await checkTarget(7, { kind: 'to_process', publicId: 'x', targetType: 'DOCUMENT', targetId: 1, targetPublicId: null, field: null })).toBe('gone');
  });

  it('§20 — échéance réalisée/annulée entre affichage et clic : « déjà traitée », pas de tiroir', async () => {
    etat.agenda.set(30, { account: 7, date: '2026-10-01', manualStatus: 'realise', title: 'Contrôle' });
    expect(await checkTarget(7, { kind: 'drawer', drawer: 'echeance', id: 30, mode: 'view' })).toBe('resolved');
    etat.agenda.set(31, { account: 7, date: '2026-10-01', manualStatus: '  ', title: 'Contrôle' });
    expect(await checkTarget(7, { kind: 'drawer', drawer: 'echeance', id: 31, mode: 'view' })).toBe('ok');
    // Échéance d'un autre compte : indisponible (SEC-006).
    etat.agenda.set(32, { account: 8, date: '2026-10-01', manualStatus: null, title: 'Autre' });
    expect(await checkTarget(7, { kind: 'drawer', drawer: 'echeance', id: 32 })).toBe('gone');
  });
});

// ── REC-005 ──────────────────────────────────────────────────────────────────

describe('offre et droits (REC-005)', () => {
  const vide = { activeAssets: [], activeAssetCount: 0, documentCount: 0 };
  const unBien = { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 0 };
  const codes = (r: Raw) => buildCandidates(r).candidates.map((c) => c.sourceCode);

  it('droits calculés comme les gardes serveur (lecture seule, quotas)', () => {
    expect(mascotRightsFrom({ canWrite: false, quotas: { maxAssets: 0, maxDocuments: 0 } }, { assets: 0, documents: 0 }))
      .toEqual({ canWrite: false, canAddAsset: false, canAddDocument: false });
    expect(mascotRightsFrom({ canWrite: true, quotas: { maxAssets: 2, maxDocuments: 30 } }, { assets: 2, documents: 29 }))
      .toEqual({ canWrite: true, canAddAsset: false, canAddDocument: true });
  });

  it('compte en lecture seule ou quota de biens atteint : pas « Ajouter un bien »', () => {
    expect(codes(raw({ onboarding: vide }))).toContain('ONB-ASSET');
    expect(codes(raw({ onboarding: vide, rights: { canWrite: false, canAddAsset: false, canAddDocument: false } }))).not.toContain('ONB-ASSET');
    expect(codes(raw({ onboarding: vide, rights: { canWrite: true, canAddAsset: false, canAddDocument: true } }))).not.toContain('ONB-ASSET');
  });

  it('quota documentaire atteint : pas « Ajouter un document »', () => {
    expect(codes(raw({ onboarding: unBien }))).toContain('ONB-DOC');
    expect(codes(raw({ onboarding: unBien, rights: { canWrite: true, canAddAsset: true, canAddDocument: false } }))).not.toContain('ONB-DOC');
  });

  it('lecture seule : pas de « C’est fait » ni de « Préciser l’échéance »', () => {
    const agenda = [
      { id: 1, title: 'Vidange', date: '2026-09-20', forecast: false, requiresQualification: false, assetId: null, assetName: null },
      { id: 2, title: 'Bail', date: '2026-09-21', forecast: false, requiresQualification: true, assetId: null, assetName: null },
    ];
    expect(codes(raw({ agenda }))).toEqual(expect.arrayContaining(['MASC-EXT-ACTION', 'MASC-BLOCKED']));
    const ro = codes(raw({ agenda, rights: { canWrite: false, canAddAsset: false, canAddDocument: false } }));
    expect(ro).not.toContain('MASC-EXT-ACTION');
    expect(ro).not.toContain('MASC-BLOCKED');
  });

  it('droits illisibles : aucune restriction présumée, pas d’état dégradé', () => {
    const c = buildCandidates(raw({ onboarding: vide, rights: null }));
    expect(c.candidates.map((x) => x.sourceCode)).toContain('ONB-ASSET');
    expect(c.degraded).toBe(false);
  });

  it('le collecteur lit les droits du compte', async () => {
    entitlements.mockImplementation(async () => ({ canWrite: false, quotas: { maxAssets: 0, maxDocuments: 0 } }));
    const r = await collectMascotData(7, NOW);
    expect(entitlements).toHaveBeenCalledWith(7);
    expect(r.rights).toEqual({ canWrite: false, canAddAsset: false, canAddDocument: false });
  });
});

// ── SEC-004 ──────────────────────────────────────────────────────────────────

describe('questions T2 (SEC-004)', () => {
  it('une action À traiter visible en secondaire exclut Q-TODO', () => {
    // Deux sujets de traitement occupent le discours ; l'action À traiter passe en secondaire.
    const r = raw({
      processing: {
        uploads: [{ id: 1, title: 'Bail', at: '2026-09-25T09:00:00Z' }],
        analyses: [{ id: 2, title: 'Facture', at: '2026-09-25T08:00:00Z' }],
        exports: [],
      },
      toProcess: [atp()],
    });
    const c = buildCandidates(r);
    const subjects = selectSubjects(c.candidates);
    expect(subjects.map((s) => s.sourceFamily)).toEqual(['PROCESSING', 'PROCESSING']);
    const sec = buildSecondaries(c, subjects);
    expect(sec.some((s) => s.kind === 'recommendation' && s.sourceCode.startsWith('ATP-'))).toBe(true);
    expect(sec.map((s) => s.sourceCode)).not.toContain('Q-TODO');
  });

  it('sans action À traiter visible, Q-TODO reste proposée', () => {
    // Le seul sujet affiché est une date ; aucune action À traiter n'est visible
    // (la famille n'a pas de candidat lu) mais la file en contient : question gardée.
    const c = buildCandidates(raw({
      agenda: [{ id: 5, title: 'Ramonage', date: '2026-10-15', forecast: false, requiresQualification: false, assetId: null, assetName: null }],
    }));
    c.hints.hasToProcess = true;
    const subjects = selectSubjects(c.candidates);
    const sec = buildSecondaries(c, subjects);
    expect(sec.map((s) => s.sourceCode)).toContain('Q-TODO');
    // La date est un sujet : sa question équivalente reste exclue (T2-02).
    expect(sec.map((s) => s.sourceCode)).not.toContain('Q-NEXT-DATE');
  });
});

// ── BO-009 / LOG-005 ─────────────────────────────────────────────────────────

describe('traçabilité T6 (BO-009, LOG-005)', () => {
  const input = buildT6Input([{
    subjectId: 'DATE-NEXT:1', sourceFamily: 'DATE', sourceCode: 'DATE-NEXT', accountId: 7,
    priority: null, requiresAttention: false, intent: 'deadline',
    facts: { title: 'Ramonage', dateLabel: '15 octobre 2026' }, actions: [],
    fallbackText: 'Votre prochaine échéance est « Ramonage », le 15 octobre 2026.',
    allowedHighlight: '15 octobre 2026', occurrenceKey: 'DATE-NEXT:1', dedupeKeys: [], secondaryLabel: '',
  }]);
  const deps = { flagEnabled: () => true, treatmentAvailable: async () => true, promptVersion: async () => 'v-bo009' };

  beforeEach(() => { execute.mockReset(); resetT6Breaker(); });

  it('le mode (affichée / pré-génération) est transmis à la gateway', async () => {
    expect(gatewayCallerMode('display')).toBe('displayed');
    expect(gatewayCallerMode('pregen')).toBe('pregeneration');
    execute.mockRejectedValue(new Error('provider'));
    await formulateWithT6({ accountId: 7, input, contextHash: 'h1', mode: 'pregen' }, deps);
    expect(execute.mock.calls[0][0]).toMatchObject({ useCaseCode: 'HOME_MASCOT', callerMode: 'pregeneration' });
  });

  it('LOG-005 — une lecture du cache ne duplique ni l’entrée ni la sortie T6', async () => {
    callLog.length = 0;
    await logT6({
      accountId: 7, contextHash: 'h', mode: 'display', input,
      outcome: { status: 'cache_hit', messages: [{ subjectId: 'DATE-NEXT:1', text: 'x', highlight: null }], promptVersion: 'v' },
    });
    const cache = callLog.find((c) => /INSERT INTO home_mascot_generations/.test(c.sql))!;
    expect(cache.p[3]).toBe('cache_hit');
    expect(cache.p[10]).toBeNull(); // input_json
    expect(cache.p[11]).toBeNull(); // output_json

    // Une vraie génération garde entrée et sortie (LOG-004).
    callLog.length = 0;
    await logT6({
      accountId: 7, contextHash: 'h', mode: 'display', input,
      outcome: { status: 'generated', messages: [{ subjectId: 'DATE-NEXT:1', text: 'x', highlight: null }], promptVersion: 'v' },
    });
    const gen = callLog.find((c) => /INSERT INTO home_mascot_generations/.test(c.sql))!;
    expect(gen.p[10]).not.toBeNull();
    expect(gen.p[11]).not.toBeNull();
  });
});
