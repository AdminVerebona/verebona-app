/**
 * Enregistrement automatique — CDC Exports V12 §4.3 (debounce 700 ms),
 * IC-GEN-003, IC-GEN-004.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS, createAutosaveQueue, withRequeue, type AutosaveState } from '../additional-infos-autosave';
import type { AdditionalInfosPatch } from '../additional-infos';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup(save: (p: AdditionalInfosPatch) => Promise<void>) {
  const states: AutosaveState[] = [];
  const q = createAutosaveQueue({ save, onStateChange: (s) => states.push(s) });
  return { q, states };
}

describe('autosave', () => {
  it('délai du CDC : 700 ms', () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(700);
  });

  it('regroupe les frappes : un seul PATCH, 700 ms après la dernière', async () => {
    const save = vi.fn(async () => {});
    const { q, states } = setup(save);
    q.set('commercial', 'saleConditions', 'P');
    await vi.advanceTimersByTimeAsync(500);
    q.set('commercial', 'saleConditions', 'Paiement');
    q.set('commercial', 'desiredSalePriceCents', 390000);
    await vi.advanceTimersByTimeAsync(699);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ commercial: { saleConditions: 'Paiement', desiredSalePriceCents: 390000 } });
    expect(states).toEqual(['pending', 'pending', 'pending', 'saving', 'saved']);
  });

  it('un champ vidé part à null (suppression)', async () => {
    const save = vi.fn(async () => {});
    const { q } = setup(save);
    q.set('rental', 'depositCents', null);
    await vi.advanceTimersByTimeAsync(700);
    expect(save).toHaveBeenCalledWith({ rental: { depositCents: null } });
  });

  it('jamais deux envois simultanés ; les saisies pendant l’envoi partent ensuite', async () => {
    let release!: () => void;
    const save = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { release = r; }))
      .mockImplementation(async () => {});
    const { q, states } = setup(save);
    q.set('insurance', 'protections', 'Alarme');
    await vi.advanceTimersByTimeAsync(700);
    expect(save).toHaveBeenCalledTimes(1);
    q.set('insurance', 'specialItems', 'Tableau');
    await vi.advanceTimersByTimeAsync(700);
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toEqual({ insurance: { specialItems: 'Tableau' } });
    expect(states.at(-1)).toBe('saved');
  });

  it('échec : état error, le lot revient sans écraser une saisie plus récente, retry relance', async () => {
    let release!: (err: Error) => void;
    const save = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, rej) => { release = rej; }))
      .mockImplementation(async () => {});
    const { q, states } = setup(save);
    q.set('claim', 'circumstances', 'ancien');
    q.set('claim', 'claimType', 'VOL');
    await vi.advanceTimersByTimeAsync(700);
    q.set('claim', 'circumstances', 'nouveau');
    release(new Error('réseau'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe('error');
    expect(q.hasPending()).toBe(true);
    await q.retry();
    expect(save).toHaveBeenLastCalledWith({ claim: { circumstances: 'nouveau', claimType: 'VOL' } });
    expect(q.state()).toBe('saved');
  });

  it('flush envoie immédiatement ; discard retire une saisie invalide', async () => {
    const save = vi.fn(async () => {});
    const { q } = setup(save);
    q.set('rental', 'monthlyRentCents', 100);
    q.set('rental', 'depositCents', 0);
    q.discard('rental', 'monthlyRentCents');
    await q.flush();
    expect(save).toHaveBeenCalledWith({ rental: { depositCents: 0 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('discard de la seule saisie : retour à idle, rien n’est envoyé', async () => {
    const save = vi.fn(async () => {});
    const { q, states } = setup(save);
    q.set('rental', 'monthlyRentCents', 100);
    q.discard('rental', 'monthlyRentCents');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('idle');
  });

  it('dispose : plus aucun envoi programmé', async () => {
    const save = vi.fn(async () => {});
    const { q } = setup(save);
    q.set('commercial', 'salePitch', 'x');
    q.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });

  it('conflit (409) puis échec du rejeu : seul le correctif rejoué revient, jamais la liste en conflit', async () => {
    const localList = [{ id: 'd1', zone: 'Cuisine' }];
    let call = 0;
    let q!: ReturnType<typeof createAutosaveQueue>;
    const save = vi.fn(async (_p: AdditionalInfosPatch) => {
      call++;
      if (call === 1) {
        // Le composant a résolu le 409 : la liste est en conflit (bloquée), le reste
        // est rejoué et ce rejeu échoue (réseau).
        q.block('claim', 'damages');
        throw withRequeue(new Error('réseau'), { claim: { circumstances: 'Fuite' } });
      }
    });
    ({ q } = setup(save));
    q.set('claim', 'damages', localList);
    q.set('claim', 'circumstances', 'Fuite');
    await q.flush();
    expect(q.state()).toBe('error');
    await q.retry();
    // La liste du co-titulaire n'est pas écrasée : seule la saisie simple repart.
    expect(save).toHaveBeenLastCalledWith({ claim: { circumstances: 'Fuite' } });
    // Une nouvelle modification de la liste par l'utilisateur la débloque.
    q.set('claim', 'damages', [{ id: 'd2', zone: 'Salon' }]);
    await q.flush();
    expect(save).toHaveBeenLastCalledWith({ claim: { damages: [{ id: 'd2', zone: 'Salon' }] } });
  });

  it('échec simple (sans conflit) : tout le lot revient, sauf un champ bloqué', async () => {
    const save = vi.fn(async (_p: AdditionalInfosPatch): Promise<void> => { throw new Error('réseau'); });
    const { q } = setup(save);
    q.set('rental', 'depositCents', 0);
    q.set('commercial', 'highlights', []);
    q.block('commercial', 'highlights');
    await q.flush();
    save.mockImplementation(async () => {});
    await q.retry();
    expect(save).toHaveBeenLastCalledWith({ rental: { depositCents: 0 } });
  });
});

