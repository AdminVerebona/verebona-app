/**
 * Lot 24 — #19/#32 : la file de dépôt bloque le rechargement AUTOMATIQUE de la
 * reprise PWA (APP-PERF-10 T-03, APP-PERF-29). Tant qu'un fichier est actif,
 * une erreur de chunk ne recharge pas la page : la reprise est proposée, avec
 * l'avertissement « envoi en cours ». Une fois l'envoi terminé, la règle
 * normale (une tentative automatique) s'applique de nouveau.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/upload-http', () => ({
  fetchDepot: vi.fn(),
  messageSelonStatut: (s: number, r: string) => `${r} (erreur ${s}).`,
}));
const espion = vi.hoisted(() => ({ noms: [] as string[] }));
vi.mock('@/lib/pwa/chunk-recovery', async (orig) => {
  const vrai = await orig<typeof import('@/lib/pwa/chunk-recovery')>();
  return {
    ...vrai,
    registerReloadBlocker: (nom: string, f: () => boolean) => { espion.noms.push(nom); return vrai.registerReloadBlocker(nom, f); },
  };
});

import {
  FileDepot, declarerGardeRechargement, GARDE_RECHARGEMENT_DEPOT, type TransportDepot, type MetaConfirmation,
} from '../upload-queue';
import {
  __setRecoveryEnvForTests, currentBlockers, handleChunkError, recoveryMessage, type RecoveryStorage,
} from '@/lib/pwa/chunk-recovery';

const META: MetaConfirmation = {
  assetId: 1, substructureId: null, equipmentId: null, documentType: 'FACTURE', documentDate: null,
  description: null, supplier: null, amountCents: null,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function memoire(): RecoveryStorage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
}

function transportBloquant() {
  const liberer: Array<() => void> = [];
  const transport: TransportDepot = {
    hacher: async () => 'a'.repeat(64),
    presign: async (b) => json(201, { fileId: 7, uploadUrl: `https://s3/${String(b.operationId)}`, uploadStatus: 'PENDING' }),
    envoyer: (_u, _f, _m, signal, onProgress) => new Promise<void>((resolve, reject) => {
      liberer.push(() => { onProgress(1); resolve(); });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })));
    }),
    confirmer: async (b) => json(200, { file: { id: b.fileId } }),
    attendre: async () => undefined,
  };
  return { transport, liberer };
}

const attendreQue = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
};

let reloads = 0;
beforeEach(() => {
  reloads = 0;
  __setRecoveryEnvForTests({ now: () => 1_000_000, online: () => true, storage: memoire, reload: () => { reloads += 1; }, href: () => '/documents' });
});
afterEach(() => __setRecoveryEnvForTests(null));

describe('file de dépôt = garde de rechargement', () => {
  it('la file de l’application se déclare au chargement du module', () => {
    expect(espion.noms).toContain(GARDE_RECHARGEMENT_DEPOT);
  });

  it('envoi en cours : pas de rechargement automatique, reprise proposée avec avertissement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { transport, liberer } = transportBloquant();
      const f = new FileDepot({ transport });
      const retirer = declarerGardeRechargement(f);
      f.ajouterLot([new File([new Uint8Array(10)], 'a.pdf', { type: 'application/pdf' })], META);
      await vi.waitFor(() => expect(liberer.length).toBe(1));
      expect(currentBlockers()).toContain('envoi');

      const d = handleChunkError();
      expect(d).toMatchObject({ action: 'prompt', blockedBy: ['envoi'] });
      expect(recoveryMessage(d).detail).toMatch(/envoi est en cours/);
      vi.runAllTimers();
      expect(reloads).toBe(0);
      retirer();
    } finally {
      vi.useRealTimers();
    }
  });

  it('envoi terminé : la garde ne bloque plus ; retrait possible', async () => {
    const { transport, liberer } = transportBloquant();
    const f = new FileDepot({ transport });
    const retirer = declarerGardeRechargement(f);
    f.ajouterLot([new File([new Uint8Array(10)], 'a.pdf', { type: 'application/pdf' })], META);
    await attendreQue(() => liberer.length === 1);
    expect(currentBlockers()).toContain('envoi');
    liberer[0]();
    await attendreQue(() => f.getSnapshot().enCours === 0);
    expect(currentBlockers()).not.toContain('envoi');
    retirer();
    expect(currentBlockers()).toEqual([]);
  });

  it('fichier interrompu (restauré du stockage) : ne bloque pas, son état est déjà conservé', () => {
    const f = new FileDepot({ transport: transportBloquant().transport });
    declarerGardeRechargement(f);
    f.utiliserStockage({
      charger: () => [{
        operationId: 'op-1', lotId: 'l', nom: 'a.pdf', taille: 10, mimeType: 'application/pdf', derniereModif: 1,
        etape: 'transfert', fileId: null, sha256: null, transfere: false, reprise: null, meta: META, creeLe: Date.now(),
      }],
      enregistrer: () => undefined,
    });
    expect(f.getSnapshot().elements[0].etape).toBe('interrompu');
    expect(currentBlockers()).not.toContain('envoi');
  });
});
