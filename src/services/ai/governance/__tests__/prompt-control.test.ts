/**
 * CDC BO IA T5-002, T5-004, T5-009 — Prompt Control.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CES TESTS PROTÈGENT
 *
 * T5 demande à un modèle de modifier des prompts. Trois règles l'encadrent, et
 * aucune ne peut reposer sur une consigne écrite dans un prompt : un modèle à
 * qui l'on demande de ne pas se modifier lui-même finira un jour par le faire.
 *
 * Elles sont donc vérifiées par le serveur, avant toute écriture, et ces tests
 * vérifient qu'elles refusent quelle que soit la sortie du modèle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getVersion = vi.fn();
const saveEntry = vi.fn(async (_v: unknown, _e: unknown, _u: unknown) => {});

vi.mock('../../config/config-version.repository', () => ({
  getVersion: (id: unknown) => getVersion(id),
  saveEntry: (a: unknown, b: unknown, c: unknown) => saveEntry(a, b, c),
}));

const { assertTargetWritable, applyProposal, T5Refused, VERDICTS } =
  await import('../prompt-control.service');

const brouillon = (over: Record<string, unknown> = {}) => ({
  id: 1, status: 'DRAFT',
  entries: [{ treatment: 'T2', prompt: 'actuel' }],
  ...over,
});

beforeEach(() => { getVersion.mockReset(); saveEntry.mockClear(); });
afterEach(() => vi.restoreAllMocks());

describe('T5-002 — Prompt Control ne se modifie pas lui-même', () => {
  it('refuse la cible T5, avant tout appel modèle', async () => {
    // Avant, et non après : un appel est payé même quand son résultat sera
    // refusé. Et surtout, aucune sortie du modèle ne peut contourner ce refus.
    await expect(assertTargetWritable(1, 'T5')).rejects.toThrow(T5Refused);
    expect(getVersion).not.toHaveBeenCalled();
  });

  it("refuse aussi à l'application", async () => {
    await expect(applyProposal(1, 'T5', 'x'.repeat(60), 7)).rejects.toThrow(/T5-002/);
    expect(saveEntry).not.toHaveBeenCalled();
  });
});

describe('T5-004 — seulement dans un brouillon', () => {
  it('accepte un brouillon', async () => {
    getVersion.mockResolvedValue(brouillon());
    await expect(assertTargetWritable(1, 'T2')).resolves.toBe('T2');
  });

  it("refuse l'Active, qui est en lecture seule", async () => {
    getVersion.mockResolvedValue(brouillon({ status: 'ACTIVE' }));
    await expect(assertTargetWritable(1, 'T2')).rejects.toThrow(/brouillon/);
  });

  it('refuse une version à l’essai', async () => {
    // La modifier changerait ce qu'on est en train de mesurer.
    getVersion.mockResolvedValue(brouillon({ status: 'TO_TEST' }));
    await expect(assertTargetWritable(1, 'T2')).rejects.toThrow(T5Refused);
  });

  it('refuse une version introuvable', async () => {
    getVersion.mockResolvedValue(null);
    await expect(assertTargetWritable(9, 'T2')).rejects.toThrow(/introuvable/);
  });
});

describe('cibles valides', () => {
  it('refuse un traitement inconnu', async () => {
    await expect(assertTargetWritable(1, 'T9')).rejects.toThrow(/inconnu/);
    await expect(assertTargetWritable(1, 'T2 ')).rejects.toThrow(T5Refused);
  });

  it('accepte T1 à T4', async () => {
    getVersion.mockResolvedValue(brouillon({
      entries: ['T1', 'T2', 'T3', 'T4'].map((t) => ({ treatment: t, prompt: 'p' })),
    }));
    for (const t of ['T1', 'T2', 'T3', 'T4']) {
      await expect(assertTargetWritable(1, t), t).resolves.toBe(t);
    }
  });
});

describe('T5-009 — quatre verdicts, pas un seul', () => {
  it('distingue les causes qui n’appellent pas le même geste', () => {
    // Sans issue autre que « modifier le prompt », un modèle en fabriquera une
    // même quand le problème est ailleurs — et retoucher un texte qui
    // fonctionne dégrade les deux.
    expect([...VERDICTS]).toEqual(['prompt', 'code', 'donnees', 'configuration']);
  });
});

describe('écriture', () => {
  it('conserve le reste de la configuration du traitement', async () => {
    // Écrire une entrée entière depuis T5 écraserait modèles, garde-fous et
    // déclencheurs — que T5 n'a pas le droit de toucher (T5-001).
    getVersion.mockResolvedValue({
      id: 1, status: 'DRAFT',
      entries: [{ treatment: 'T2', prompt: 'actuel', primaryModel: 'm1', guardrails: ['g'] }],
    });

    await applyProposal(1, 'T2', 'n'.repeat(60), 7);

    const entry = saveEntry.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(entry.primaryModel).toBe('m1');
    expect(entry.guardrails).toEqual(['g']);
    expect(entry.prompt).toBe('n'.repeat(60));
  });
});
