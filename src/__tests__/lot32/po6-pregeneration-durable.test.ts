/**
 * Décision PO 6 (lot 32) — « Il ne faut pas de modification de texte, mais il
 * faut que le texte IA apparaisse plus vite. »
 *
 * Pré-génération DURABLE (`home_mascot_pregen_requests`, tâche planifiée
 * `mascot-pregeneration`) : déclenchée par tout changement de situation,
 * dédupliquée par compte et par situation, bornée en coût ; aucun texte
 * remplacé à l'écran. Base simulée ici ; sur base réelle :
 * `l32-a-traiter-mascotte.e2e.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; p: unknown[] }>,
  generatedToday: 0,
  claimable: [] as number[],
  presentation: vi.fn(),
}));

vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (sql: string, p: unknown[] = []) => {
      h.calls.push({ sql, p });
      if (/UPDATE home_mascot_pregen_requests r/.test(sql)) {
        const lot = h.claimable.splice(0, Number(p[2]));
        return lot.map((accountId) => ({ accountId, requestedAt: '2026-10-07 10:00:00+00' }));
      }
      if (/UPDATE home_mascot_pregen_requests\s+SET claimed_until = clock_timestamp\(\) \+/.test(sql) && /WHERE account_id = \$3/.test(sql)) {
        const i = h.claimable.indexOf(Number(p[2]));
        if (i < 0) return [];
        h.claimable.splice(i, 1);
        return [{ accountId: p[2], requestedAt: '2026-10-07 10:00:00+00' }];
      }
      if (/FROM home_mascot_generations/.test(sql)) return [{ n: h.generatedToday }];
      if (/INSERT INTO home_mascot_pregen_requests \(account_id, requested_at, reason\)\s+SELECT/.test(sql)) return [{ account_id: 1 }, { account_id: 2 }];
      return [];
    },
  },
  db: {},
}));
vi.mock('@/services/home/mascot/mascot.service', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMascotPresentation: (a: number, m: string) => h.presentation(a, m),
}));

const Q = await import('@/services/home/mascot/pregen-queue');
const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');

const pres = (source: 't6' | 'fallback' | 'deterministic', paragraphs = 1) => ({
  contextHash: `h-${source}`, source, paragraphs: Array.from({ length: paragraphs }, (_, i) => ({ sourceCode: `DATE-NEXT`, occurrenceKey: `k${i}` })),
});

afterEach(() => {
  h.calls.length = 0; h.claimable = []; h.generatedToday = 0; h.presentation.mockReset();
  delete process.env.MASCOT_PREGEN_DAILY_MAX; delete process.env.MASCOT_PREGEN_BATCH;
});

describe('PO6 — pré-génération durable du texte T6', () => {
  it('PO6 — un changement de situation est ENREGISTRÉ (une ligne par compte, la plus récente l’emporte)', async () => {
    await Q.requestMascotPregeneration(7, 'TO_PROCESS_ITEM_UPDATED');
    const c = h.calls.find((x) => /INSERT INTO home_mascot_pregen_requests/.test(x.sql))!;
    expect(c.sql).toMatch(/ON CONFLICT \(account_id\) DO UPDATE/);
    expect(c.p).toEqual([7, 'TO_PROCESS_ITEM_UPDATED']);
    await Q.requestMascotPregeneration(0, 'x');
    expect(h.calls).toHaveLength(1); // identifiant invalide : rien
  });

  it('PO6 — la tâche traite un lot borné ; la situation formulée est notée (dédup par situation via le cache T6)', async () => {
    h.claimable = [1, 2, 3];
    h.presentation.mockImplementation(async (a: number) => (a === 2 ? pres('deterministic', 0) : pres('t6')));
    const r = await Q.runMascotPregeneration({ batch: 2 });
    expect(r).toMatchObject({ claimed: 2, formulated: 1, nothing: 1, errors: 0 });
    expect(h.presentation).toHaveBeenCalledWith(1, 'pregen');
    const fin = h.calls.filter((x) => /processed_at = GREATEST/.test(x.sql));
    expect(fin.map((x) => x.p[0])).toEqual([1, 2]);
    expect(fin[0].p).toEqual([1, 'formulated', '2026-10-07 10:00:00+00', 'h-t6']);
    // Le compte 3 reste en attente pour le passage suivant.
    expect(h.claimable).toEqual([3]);
  });

  it('PO6 — coût plafonné par compte et par 24 h (MASCOT_PREGEN_DAILY_MAX) : demande close sans appel T6', async () => {
    process.env.MASCOT_PREGEN_DAILY_MAX = '2';
    h.generatedToday = 2;
    h.claimable = [5];
    const r = await Q.runMascotPregeneration();
    expect(r).toMatchObject({ claimed: 1, capped: 1 });
    expect(h.presentation).not.toHaveBeenCalled();
    expect(Q.mascotPregenDailyMax({})).toBe(24);
    expect(Q.mascotPregenBatch({ MASCOT_PREGEN_BATCH: '9999' })).toBe(200);
  });

  it('PO6 — T6 n’a pas formulé (panne passagère) : nouvel essai borné, demande non close', async () => {
    h.claimable = [4];
    h.presentation.mockImplementation(async () => pres('fallback'));
    const r = await Q.runMascotPregeneration();
    expect(r.fallback).toBe(1);
    expect(h.calls.some((x) => /claimed_until = clock_timestamp\(\) \+ INTERVAL '2 minutes'/.test(x.sql))).toBe(true);
    expect(h.calls.some((x) => /processed_at = GREATEST/.test(x.sql))).toBe(false);
  });

  it('PO6 — chemin rapide : la demande du compte est prise en charge une seule fois (jamais deux générations)', async () => {
    h.claimable = [8];
    h.presentation.mockImplementation(async () => pres('t6'));
    expect(await Q.processMascotPregenerationFor(8)).toBe('formulated');
    expect(await Q.processMascotPregenerationFor(8)).toBeNull(); // déjà traitée
    expect(h.presentation).toHaveBeenCalledTimes(1);
  });

  it('PO6 — passage d’une échéance : comptes signalés par la tâche quotidienne (bornée)', async () => {
    expect(await Q.enqueueDeadlineSituations('2026-10-07', 60)).toBe(2);
    const c = h.calls.find((x) => /SELECT DISTINCT i\.account_id/.test(x.sql))!;
    expect(c.p).toEqual(['2026-10-07', 60, 5000]);
    expect(c.sql).toMatch(/LIMIT \$3/);
  });

  it('PO6 — déclencheurs : bus des événements métier, fin d’analyse, connexion, tâches planifiées', () => {
    const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
    for (const t of ['DOCUMENT_ANALYSIS_COMPLETED', 'TO_PROCESS_ITEM_UPDATED', 'AGENDA_ITEM_UPDATED', 'ASSET_UPDATED']) {
      expect(Q.PREGEN_EVENT_TYPES.has(t)).toBe(true);
    }
    expect(Q.PREGEN_EVENT_TYPES.has('HELP_ENTRY_PUBLISHED')).toBe(false);
    expect(lire('src/instrumentation-node.ts')).toContain('registerMascotPregenerationHandler()');
    expect(lire('src/app/api/auth/login/route.ts')).toContain("scheduleMascotPregeneration(accountId, 0, 'login')");
    expect(lire('src/services/home/mascot/mascot.service.ts')).toContain('requestMascotPregeneration(accountId, reason)');
    expect(findTask('mascot-pregeneration')).toMatchObject({ schedule: { kind: 'interval', everyMs: 60_000 }, ownSlot: true });
    expect(findTask('mascot-pregeneration-deadlines')).toMatchObject({ schedule: { kind: 'daily', at: [5, 40] } });
  });

  it('PO6 — aucun texte remplacé sous les yeux : l’écran garde la présentation de même contexte (RUN-001)', () => {
    const hook = readFileSync(join(process.cwd(), 'src/components/home/useMascotPresentation.ts'), 'utf8');
    expect(hook).toContain('prev && prev.contextHash === data.contextHash ? prev : data');
  });
});
