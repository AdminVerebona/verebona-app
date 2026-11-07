/**
 * Lot 113P (#715, décision PO du 06/11/2026) — Agenda sans statut.
 *
 * Unitaires SANS base (la CI unitaire tourne sans PostgreSQL) :
 *   · trace d'exclusion d'une suppression utilisateur (`userDeletionBlocks`) :
 *     règle de blocage, paramètres, panne de lecture sans effet ;
 *   · rappels fondés sur une date FUTURE seulement ;
 *   · signal « en_retard » retiré ; recopie « achat » fondée sur la date ;
 *   · route de statut historique : 410, sans écriture ;
 *   · sources : plus aucun libellé de statut dans les écrans de l'agenda.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: async () => { throw new Error('base inaccessible (test unitaire)'); } } }));
const lectureSeule = vi.hoisted(() => ({ refus: false }));
vi.mock('@/lib/session-service', () => ({
  SessionService: { getSession: async () => ({ userId: 3, currentAccountId: 7 }), handleSessionError: (e: unknown) => { throw e; } },
}));
vi.mock('@/lib/write-access-guard', async () => {
  const { NextResponse } = await import('next/server');
  return { refuserSiLectureSeule: async () => (lectureSeule.refus ? NextResponse.json({ code: 'READ_ONLY' }, { status: 403 }) : null) };
});

const { userDeletionBlocks, recordUserDeletion, USER_DELETION_REASONS } = await import('../agenda-user-deletion');
const { agendaReminderRelevance } = await import('@/lib/agenda/reminder-relevance');
const { visibleAttentionFlags, attentionFlagLabel, ATTENTION_FLAG_LABELS } = await import('@/lib/agenda/attention-flags');
const { computeAttentionFlags } = await import('../AgendaDomainService');
const { purchaseSyncAllowed } = await import('../write-agenda-item');

const client = (rows: Array<{ reason: string }>) => {
  const calls: Array<{ q: string; p: unknown[] }> = [];
  return { calls, unsafe: vi.fn(async (q: string, p?: never[]) => { calls.push({ q, p: p ?? [] }); return rows; }) };
};

describe('#715 — trace d’exclusion (suppression par l’utilisateur)', () => {
  it('motifs stables (journal 0223, aucune table nouvelle)', () => {
    expect(USER_DELETION_REASONS).toEqual(['USER_DELETED', 'USER_DELETED_SERIES']);
  });

  it('même clé fonctionnelle supprimée → création automatique bloquée', async () => {
    const c = client([{ reason: 'USER_DELETED' }]);
    expect(await userDeletionBlocks(7, { functionalKey: 'k:doc:12:inspection:2027-03-01' }, c)).toBe('USER_DELETED');
    expect(c.calls[0].p.slice(0, 4)).toEqual([7, ['USER_DELETED', 'USER_DELETED_SERIES'], 'k:doc:12:inspection:2027-03-01', null]);
  });

  it('prévision d’une série supprimée en entier → bloquée ; occurrence CONFIRMÉE de la même série : la clé seule décide', async () => {
    const c = client([{ reason: 'USER_DELETED_SERIES' }]);
    expect(await userDeletionBlocks(7, { seriesKey: 's1', occurrenceNature: 'FORECAST' }, c)).toBe('USER_DELETED_SERIES');
    expect(c.calls[0].p[3]).toBe('s1');
    const c2 = client([]);
    expect(await userDeletionBlocks(7, { seriesKey: 's1', occurrenceNature: 'CONFIRMED' }, c2)).toBeNull();
    expect(c2.calls).toHaveLength(0); // ni clé, ni prévision, ni champ daté : aucune lecture
  });

  it('sans clé : même champ d’origine, même date, même bien', async () => {
    const c = client([]);
    expect(await userDeletionBlocks(7, { originFieldKey: 'insuranceExpiry', startDate: '2027-01-01', assetIds: [3, 4] }, c)).toBeNull();
    expect(c.calls[0].p.slice(4)).toEqual(['insuranceExpiry', '2027-01-01', ['3', '4']]);
    // Sans bien ou sans date : jamais un rapprochement par champ.
    const c2 = client([]);
    await userDeletionBlocks(7, { originFieldKey: 'insuranceExpiry', startDate: '2027-01-01', assetIds: [] }, c2);
    expect(c2.calls).toHaveLength(0);
  });

  it('panne de lecture : jamais d’exception, aucune création bloquée (comportement antérieur)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await userDeletionBlocks(7, { functionalKey: 'k' })).toBeNull();
    err.mockRestore();
  });

  it('écriture de la trace : rien pour une liste vide ; motif selon la portée', async () => {
    const execute = vi.fn(async () => [{ id: 1 }, { id: 2 }]);
    expect(await recordUserDeletion({ execute }, { accountId: 7, ids: [], scope: 'OCCURRENCE', userId: 3 })).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(await recordUserDeletion({ execute }, { accountId: 7, ids: [5, 5, 6], scope: 'SERIES', userId: 3 })).toBe(2);
    expect(JSON.stringify(execute.mock.calls[0])).toContain('USER_DELETED_SERIES');
  });
});

describe('#715 — rappels : date future seulement', () => {
  const base = { historical: false, today: '2026-11-06', hasPreference: false, assessment: { interpellation: 'ACT_NOW', action: 'Appeler', actionDate: null } };
  it('date passée : jamais une relance (ni « C’est fait ? », ni « à confirmer »), même avec un avis T6', () => {
    expect(agendaReminderRelevance({ ...base, dueDate: '2026-04-12' })).toMatchObject({ visible: false, reason: 'PAST_DATE' });
    expect(agendaReminderRelevance({ ...base, dueDate: '2026-04-12', hasPreference: true })).toMatchObject({ visible: false, reason: 'PAST_DATE' });
  });
  it('date future : rappel T6 inchangé ; fait historique : jamais', () => {
    expect(agendaReminderRelevance({ ...base, dueDate: '2026-12-01' })).toMatchObject({ visible: true, reason: 'T6_REMINDER' });
    expect(agendaReminderRelevance({ ...base, dueDate: '2026-11-06' })).toMatchObject({ visible: true });
    expect(agendaReminderRelevance({ ...base, historical: true, dueDate: '2026-12-01' })).toMatchObject({ visible: false, reason: 'HISTORICAL_FACT' });
  });
});

describe('#715 — signaux et recopie « achat »', () => {
  it('« en_retard » n’existe plus : ni produit, ni libellé, masqué s’il revient d’un cache', () => {
    const flags = computeAttentionFlags({ startDate: '2020-01-01', directAssetIds: [1], fileLinks: [], roomLinks: [], equipmentLinks: [] } as never, []);
    expect(flags).not.toContain('en_retard');
    expect(Object.keys(ATTENTION_FLAG_LABELS)).not.toContain('en_retard');
    expect(visibleAttentionFlags(['en_retard', 'sans_bien'])).toEqual(['sans_bien']);
    expect(attentionFlagLabel('en_retard')).toBe('À vérifier');
  });
  it('D-13 : événement manuel d’achat daté du passé ou du jour → recopie ; futur ou automatique → non (sans statut)', () => {
    const achat = { title: 'Achat du vélo', startDate: '2026-01-10', isAutomatic: false };
    expect(purchaseSyncAllowed(achat, 'purchase', '2026-11-06')).toBe(true);
    expect(purchaseSyncAllowed({ ...achat, startDate: '2027-01-10' }, 'purchase', '2026-11-06')).toBe(false);
    expect(purchaseSyncAllowed({ ...achat, isAutomatic: true }, 'purchase', '2026-11-06')).toBe(false);
  });
});

describe('#715 — route de statut historique', () => {
  it('PATCH /api/agenda/:id/statut → 410 AGENDA_STATUS_REMOVED, sans aucune écriture ; gardes conservées', async () => {
    const { NextRequest } = await import('next/server');
    const { PATCH } = await import('@/app/api/agenda/[id]/statut/route');
    const req = () => new NextRequest('http://localhost/api/agenda/5/statut', { method: 'PATCH', body: JSON.stringify({ manualStatus: 'realise' }) });
    const r = await PATCH(req());
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ code: 'AGENDA_STATUS_REMOVED', error: 'Les événements n’ont plus de statut : modifiez la date ou supprimez l’événement.' });
    lectureSeule.refus = true;
    expect((await PATCH(req())).status).toBe(403);
    lectureSeule.refus = false;
  });
});

describe('#715 — écrans : plus aucun statut affiché (web, PWA, mobile WebView)', () => {
  const racine = join(__dirname, '../../../..');
  const ecrans = [
    'src/app/(dashboard)/agenda/page.tsx',
    'src/components/agenda/AgendaPeriodViews.tsx',
    'src/components/agenda/AgendaItemDrawer.tsx',
    'src/components/agenda/CreateAgendaItemDrawer.tsx',
    'src/components/assets/AssetAgendaTab.tsx',
    'src/components/assets/AssetAgendaFilters.tsx',
    'src/components/assets/timeline/AssetTimeline.tsx',
  ];
  it.each(ecrans)('%s : ni sélecteur, ni badge, ni filtre, ni légende de statut', (f) => {
    const code = readFileSync(join(racine, f), 'utf8');
    for (const libelle of ['Date échue', 'Statut à confirmer', 'Selon la date', 'manualStatus', 'effectiveStatus', 'isOverdue', 'toConfirm', 'includeCancelled']) {
      expect(code, `${f} : ${libelle}`).not.toContain(libelle);
    }
    expect(code).not.toMatch(/['"`>]\s*(Réalisé|Annulé|À venir|En retard)\s*['"`<]/);
  });
  it('suppression d’un événement récurrent : choix explicite occurrence / série', () => {
    const tiroir = readFileSync(join(racine, 'src/components/agenda/AgendaItemDrawer.tsx'), 'utf8');
    expect(tiroir).toContain('handleDelete("occurrence")');
    expect(tiroir).toContain('handleDelete("series")');
    const libelles = readFileSync(join(racine, 'src/lib/agenda/grouping-view.ts'), 'utf8');
    expect(libelles).toContain('Supprimer cet événement uniquement');
    expect(libelles).toContain('Supprimer toute la série');
  });
});
