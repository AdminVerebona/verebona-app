/**
 * BO IA — enregistrement d'un traitement (tickets T4 et T5) : la liste
 * corrigée est enregistrée telle quelle, les autres réglages sont intacts, la
 * modification est TRACÉE (utilisateur, version, valeurs avant / après), une
 * seconde sauvegarde ne trace rien, une version non éditable est refusée.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { emptyTreatmentConfig, type TreatmentConfig } from '@/services/ai/config/config-types';
import { changedConfigFields } from '@/services/ai/config/config-entry.audit';

vi.mock('@/lib/auth-guards', () => ({ requireAdmin: async () => 42 }));
vi.mock('@/lib/session-service', () => ({ SessionService: {} }));
vi.mock('@/db', () => ({ ensureMigrations: async () => {} }));
vi.mock('@/services/ai/config/config-cache-version', () => ({ bumpConfigVersionCounter: async () => true }));

let version: { id: number; status: string; environment: string; entries: TreatmentConfig[] };
const saveEntry = vi.fn(async (id: number, c: TreatmentConfig) => {
  // Même règle que le dépôt réel : seul un Brouillon est modifiable (VER-002).
  if (version.status !== 'DRAFT') throw new Error(`[config] Version ${id} au statut « ${version.status} » : seule une version au statut Brouillon est modifiable (VER-002).`);
  void c;
});
vi.mock('@/services/ai/config/config-version.repository', () => ({
  getVersion: async () => version,
  saveEntry: (id: number, c: TreatmentConfig) => saveEntry(id, c),
}));
const recordConfigEntrySave = vi.fn(async (_t: unknown) => {});
vi.mock('@/services/ai/config/config-entry.audit', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/config/config-entry.audit')>()),
  recordConfigEntrySave: (t: unknown) => recordConfigEntrySave(t),
}));

const { PUT } = await import('../[id]/entries/[treatment]/route');

const put = (treatment: string, body: unknown) => PUT(
  new NextRequest(`http://localhost/api/admin/ai/config-versions/7/entries/${treatment}`, {
    method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }),
  { params: Promise.resolve({ id: '7', treatment }) },
);

const MASTER_T4 = 'TEXTE MASTER T4 EXISTANT';
const t4Enregistre: TreatmentConfig = {
  ...emptyTreatmentConfig('T4'), primaryModel: 'm', reasoningPrimary: 'standard', maxOutputTokens: 900,
  masterPrompt: MASTER_T4,
  triggers: [{ kind: 'schedule', code: 'schedule_hourly', active: false }],
};
const t5Herite: TreatmentConfig = {
  ...emptyTreatmentConfig('T5'), primaryModel: 'm', maxOutputTokens: 2000,
  prompt: 'TASK = {{TASK}}\nBRANCHE MODE = ANALYZE', masterPrompt: 'ancien master incomplet',
};

type Trace = { adminUserId: number; versionId: number; treatment: string; before: TreatmentConfig; after: TreatmentConfig; legacyPromptCleared: boolean };
const derniereTrace = () => recordConfigEntrySave.mock.calls.at(-1)![0] as Trace;

beforeEach(() => {
  version = { id: 7, status: 'DRAFT', environment: 'local', entries: [t4Enregistre, t5Herite] };
  saveEntry.mockClear();
  recordConfigEntrySave.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('T4 — correction des déclencheurs depuis le BO', () => {
  it('schedule_hourly supprimé, source_analyzed actif : liste exacte enregistrée, prompt et réglages inchangés, trace avant/après', async () => {
    const corrige = { ...t4Enregistre, triggers: [{ kind: 'event', code: 'source_analyzed', active: true }] };
    const r = await put('T4', corrige);
    expect(r.status).toBe(200);
    const ecrit = saveEntry.mock.calls[0][1];
    expect(ecrit.triggers).toEqual([{ kind: 'event', code: 'source_analyzed', active: true }]);
    expect(ecrit.masterPrompt).toBe(MASTER_T4);
    expect([ecrit.primaryModel, ecrit.reasoningPrimary, ecrit.maxOutputTokens]).toEqual(['m', 'standard', 900]);

    const t = derniereTrace();
    expect(t).toMatchObject({ adminUserId: 42, versionId: 7, treatment: 'T4', legacyPromptCleared: false });
    const diff = changedConfigFields(t.before, t.after);
    expect(Object.keys(diff.after)).toEqual(['triggers']);
    expect(diff.before.triggers).toEqual([{ kind: 'schedule', code: 'schedule_hourly', active: false }]);
  });

  it('version non éditable (Active) : refus, aucune écriture, aucune trace', async () => {
    version.status = 'ACTIVE';
    const r = await put('T4', { ...t4Enregistre, triggers: [] });
    expect(r.status).not.toBe(200);
    expect(recordConfigEntrySave).not.toHaveBeenCalled();
  });
});

describe('T5 — nettoyage d’un texte hérité à l’enregistrement', () => {
  it('prompt = "", masterPrompt = null, autres réglages inchangés ; nettoyage tracé', async () => {
    const r = await put('T5', t5Herite);
    expect(r.status).toBe(200);
    const t = derniereTrace();
    expect(t.legacyPromptCleared).toBe(true);
    expect(t.after.prompt).toBe('');
    expect(t.after.masterPrompt).toBeNull();
    expect([t.after.primaryModel, t.after.maxOutputTokens]).toEqual(['m', 2000]);
    expect(Object.keys(changedConfigFields(t.before, t.after).after).sort()).toEqual(['masterPrompt', 'prompt']);
  });

  it('seconde sauvegarde : aucun changement supplémentaire (rien à tracer)', async () => {
    version.entries = [t4Enregistre, { ...t5Herite, prompt: '', masterPrompt: null }];
    await put('T5', { ...t5Herite, prompt: '', masterPrompt: null });
    const t = derniereTrace();
    expect(t.legacyPromptCleared).toBe(false);
    expect(changedConfigFields(t.before, t.after).after).toEqual({});
  });
});
