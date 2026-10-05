/**
 * APP-PERF-02 / APP-PERF-04 — source unique de l'identité, et distinction
 * entre session invalide et indisponibilité temporaire.
 *
 * Recette 02 : T-01 (users/me lent, sans cache), T-02 (perte réseau puis
 * retour), T-03 (session révoquée, plusieurs consommateurs en attente).
 * Recette 04 : T-01 (plusieurs consommateurs, une lecture), T-02 (profil mis
 * à jour visible partout), T-03 (changement de compte sans repeuplement).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/api-client';
import {
  INITIAL_SESSION_SNAPSHOT,
  SIGNED_OUT_CODE,
  SessionStore,
  classifySessionError,
  type User,
} from '@/lib/session/session-store';

const user = (id: number, firstName = 'Alice'): User => ({
  id, email: `u${id}@exemple.fr`, firstName, lastName: 'Martin', role: 'USER' as never,
  subscription: { plan: 'STANDARD' as never, status: 'ACTIVE' as never },
});

/** Lecture pilotée : chaque appel attend son dénouement. */
function lecturePilotee() {
  const appels: { signal: AbortSignal; resolve: (u: User) => void; reject: (e: unknown) => void }[] = [];
  const fetchMe = vi.fn((signal: AbortSignal) => new Promise<User>((resolve, reject) => {
    appels.push({ signal, resolve, reject });
  }));
  return { fetchMe, appels };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('APP-PERF-04 — un seul chargement partagé', () => {
  it('premier rendu identique serveur/client : checking, sans identité', () => {
    const store = new SessionStore({ fetchMe: vi.fn() });
    expect(store.getSnapshot()).toBe(INITIAL_SESSION_SNAPSHOT);
    expect(store.getSnapshot()).toEqual({ status: 'checking', user: null, error: null });
  });

  it('T-01 : layout, page et panneau montés ensemble → une seule lecture users/me', async () => {
    const { fetchMe, appels } = lecturePilotee();
    const store = new SessionStore({ fetchMe });
    const liberer = [store.retain(), store.retain(), store.retain()];
    void store.refetch();
    expect(fetchMe).toHaveBeenCalledTimes(1);
    appels[0].resolve(user(1));
    await flush();
    store.retain();
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ status: 'authenticated', user: { id: 1 } });
    liberer.forEach((f) => f());
  });

  it('T-02 : profil mis à jour → tous les abonnés voient la nouvelle identité', async () => {
    const persist = vi.fn();
    const store = new SessionStore({ fetchMe: async () => user(1), persist });
    await store.refetch();
    const vus: string[] = [];
    store.subscribe(() => vus.push(store.getSnapshot().user!.firstName));
    store.subscribe(() => vus.push(store.getSnapshot().user!.firstName));
    store.applyProfileUpdate({ firstName: 'Alicia' });
    expect(vus).toEqual(['Alicia', 'Alicia']);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ firstName: 'Alicia' }));
  });

  it('une mise à jour de profil tardive ne recrée pas une identité après la sortie', async () => {
    const store = new SessionStore({ fetchMe: async () => user(1) });
    await store.refetch();
    store.reset('logout');
    store.applyProfileUpdate(user(1, 'Revenant'));
    expect(store.getSnapshot().user).toBeNull();
  });

  it('T-03 : changement de compte pendant une lecture → réponse tardive ignorée', async () => {
    const { fetchMe, appels } = lecturePilotee();
    const store = new SessionStore({ fetchMe });
    store.retain();
    expect(appels).toHaveLength(1);
    store.reset('login');
    expect(appels[0].signal.aborted).toBe(true);
    expect(appels).toHaveLength(2); // relecture : un consommateur est monté
    appels[0].resolve(user(1));
    appels[1].resolve(user(2));
    await flush();
    expect(store.getSnapshot().user?.id).toBe(2);
  });

  it('un autre utilisateur servi par le serveur → purge des caches de l’ancien contexte', async () => {
    const onIdentityChange = vi.fn();
    let id = 1;
    const store = new SessionStore({ fetchMe: async () => user(id), onIdentityChange });
    await store.refetch();
    id = 2;
    await store.refetch();
    expect(onIdentityChange).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().user?.id).toBe(2);
  });
});

describe('APP-PERF-02 — invalide ≠ indisponible', () => {
  it('T-01 : users/me lent (6 s) sans cache → aucune fausse déconnexion', async () => {
    vi.useFakeTimers();
    const store = new SessionStore({
      fetchMe: () => new Promise<User>((resolve) => setTimeout(() => resolve(user(1)), 6_000)),
    });
    store.retain();
    await vi.advanceTimersByTimeAsync(4_500);
    // L'ancien Promise.race de 4 s aurait abandonné ici.
    expect(store.getSnapshot().status).toBe('checking');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getSnapshot()).toMatchObject({ status: 'authenticated', user: { id: 1 } });
  });

  it('délai dépassé du client HTTP sans identité → état réessayable, pas de déconnexion', async () => {
    const store = new SessionStore({
      fetchMe: async () => { throw new ApiClientError(0, 'REQUEST_TIMEOUT', {}, undefined, 'Délai'); },
    });
    await store.refetch();
    expect(store.getSnapshot()).toMatchObject({ status: 'temporarily-unavailable', user: null, error: { kind: 'unavailable', code: 'REQUEST_TIMEOUT' } });
  });

  it('CA-01 / T-02 : 5xx ou réseau → la dernière identité reste affichable, puis reprise', async () => {
    const fetchMe = vi.fn()
      .mockResolvedValueOnce(user(1))
      .mockRejectedValueOnce(new ApiClientError(0, 'NETWORK_ERROR'))
      .mockRejectedValueOnce(new ApiClientError(503, 'SERVICE_UNAVAILABLE'))
      .mockResolvedValueOnce(user(1, 'Alice'));
    const store = new SessionStore({ fetchMe });
    await store.refetch();
    await store.refetch();
    expect(store.getSnapshot()).toMatchObject({ status: 'temporarily-unavailable', user: { id: 1 } });
    await store.refetch();
    expect(store.getSnapshot().status).toBe('temporarily-unavailable');
    await store.refetch();
    expect(store.getSnapshot()).toMatchObject({ status: 'authenticated', error: null });
  });

  it('CA-02 / T-03 : vrai 401, plusieurs consommateurs en attente → une lecture, une transition', async () => {
    const { fetchMe, appels } = lecturePilotee();
    const persist = vi.fn();
    const store = new SessionStore({ fetchMe, persist });
    const transitions: string[] = [];
    store.subscribe(() => transitions.push(store.getSnapshot().status));
    store.retain(); store.retain(); store.retain();
    void store.refetch();
    expect(fetchMe).toHaveBeenCalledTimes(1);
    appels[0].reject(new ApiClientError(401, 'UNAUTHORIZED'));
    await flush();
    expect(transitions).toEqual(['unauthenticated']);
    expect(store.getSnapshot()).toMatchObject({ user: null, error: { kind: 'unauthenticated' } });
    expect(persist).toHaveBeenLastCalledWith(null);
    // Aucun retour automatique : pas de relecture implicite.
    await store.ensureLoaded();
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });

  it('déconnexion volontaire : SIGNED_OUT, aucune relecture implicite', async () => {
    const fetchMe = vi.fn(async () => user(1));
    const store = new SessionStore({ fetchMe });
    await store.refetch();
    store.reset('logout');
    expect(store.getSnapshot().error?.code).toBe(SIGNED_OUT_CODE);
    store.retain();
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });

  it('classification sur statut et code stables, jamais sur un message libre', () => {
    expect(classifySessionError(new ApiClientError(401, 'UNAUTHORIZED')).kind).toBe('unauthenticated');
    expect(classifySessionError(new ApiClientError(403, 'ACCOUNT_SUSPENDED')).kind).toBe('unauthenticated');
    expect(classifySessionError(new ApiClientError(403, 'PREMIUM_REQUIRED')).kind).toBe('unavailable');
    expect(classifySessionError(new ApiClientError(500, 'INTERNAL_ERROR')).kind).toBe('unavailable');
    expect(classifySessionError(new ApiClientError(503, 'SESSION_UNAVAILABLE')).kind).toBe('unavailable');
    expect(classifySessionError(new Error('contains 401 and UNAUTHORIZED')).kind).toBe('unavailable');
  });
});
