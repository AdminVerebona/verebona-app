/**
 * Lot 26, point 17 — côté navigateur : la prise de parole est demandée dès le
 * montage de la page (sans attendre la session), une seule fois, et la
 * dernière reçue est gardée en mémoire pour la session courante.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initialMascotRead, prefetchMascotPresentation, purgeMascotPresentationMemory, rememberedMascotPresentation,
  MASCOT_PREFETCH_MAX_AGE_MS,
} from '../useMascotPresentation';
import { beginSessionTransition } from '@/lib/session/session-lifecycle';

const presentation = (h: string) => ({ schemaVersion: 'mascot-presentation-v1', contextHash: h, paragraphs: [], secondaries: [] });

describe('préchargement de la mascotte (AC17-5)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    purgeMascotPresentationMemory();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => presentation('h1') }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('page puis carte : une seule lecture, reprise par le premier chargement', async () => {
    prefetchMascotPresentation();
    prefetchMascotPresentation(); // second appel : sans effet
    const p = await initialMascotRead();
    expect(p.contextHash).toBe('h1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/home/mascot');
  });

  it('carte montée AVANT l’effet de la page (ordre enfant → parent) : toujours une seule lecture', async () => {
    await initialMascotRead();
    prefetchMascotPresentation();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lecture d’avance trop ancienne : une lecture neuve', async () => {
    const t = Date.now();
    prefetchMascotPresentation(t - MASCOT_PREFETCH_MAX_AGE_MS - 1);
    await initialMascotRead(t);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lecture d’avance en échec : le premier chargement relit', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    prefetchMascotPresentation();
    const p = await initialMascotRead();
    expect(p.contextHash).toBe('h1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('changement de session : rien de l’ancien contexte n’est réutilisé', async () => {
    prefetchMascotPresentation();
    beginSessionTransition('account-change');
    await initialMascotRead();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rememberedMascotPresentation()).toBeNull();
  });
});
