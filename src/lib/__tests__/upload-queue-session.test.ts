/**
 * Lot 24 — #25 (APP-PERF-21 CA-02/T-03) : la file de dépôt est purgée à
 * chaque transition de session. Aucun élément, fichier, bilan de lot ni
 * transfert de l'utilisateur précédent ne survit à une déconnexion ; son
 * état reprenable reste isolé dans SON stockage et lui est rendu à sa
 * prochaine connexion, jamais à un autre utilisateur.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/upload-http', () => ({
  fetchDepot: vi.fn(),
  messageSelonStatut: (s: number, r: string) => `${r} (erreur ${s}).`,
}));

import { FileDepot, fileDepot, type TransportDepot, type MetaConfirmation, type StockageDepot, type ElementPersiste } from '../upload-queue';
import { beginSessionTransition } from '@/lib/session/session-lifecycle';

const META: MetaConfirmation = {
  assetId: 1, substructureId: null, equipmentId: null, documentType: 'FACTURE', documentDate: null,
  description: null, supplier: null, amountCents: null,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const pdf = (nom: string) => new File([new Uint8Array(10)], nom, { type: 'application/pdf' });

function memoire(): StockageDepot & { contenu: ElementPersiste[] } {
  const m = { contenu: [] as ElementPersiste[], charger: () => m.contenu, enregistrer: (e: ElementPersiste[]) => { m.contenu = e; } };
  return m;
}

function transport() {
  const signaux: AbortSignal[] = [];
  const confirms: unknown[] = [];
  const t: TransportDepot = {
    hacher: async () => 'a'.repeat(64),
    presign: async (b) => json(201, { fileId: 5, uploadUrl: `https://s3/${String(b.operationId)}`, uploadStatus: 'PENDING' }),
    envoyer: (_u, _f, _m, signal) => new Promise<void>((_r, reject) => {
      signaux.push(signal);
      signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })));
    }),
    confirmer: async (b) => { confirms.push(b); return json(200, { file: { id: 5 } }); },
    attendre: async () => undefined,
  };
  return { t, signaux, confirms };
}

const attendreQue = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
};

describe('purge de la file à la sortie de session', () => {
  it('transfert en cours : annulé, file vide, aucun bilan ni confirmation après la purge', async () => {
    const { t, signaux, confirms } = transport();
    const f = new FileDepot({ transport: t });
    const stockageA = memoire();
    f.utiliserStockage(stockageA);
    const surFin = vi.fn();
    f.ajouterLot([pdf('a.pdf'), pdf('b.pdf')], META, { surFin });
    await attendreQue(() => signaux.length === 2);
    const enregistreAvant = JSON.stringify(stockageA.contenu);

    f.purger();
    expect(f.getSnapshot()).toEqual({ elements: [], enCours: 0 });
    expect(signaux.every((s) => s.aborted)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(f.getSnapshot().elements).toEqual([]);
    expect(surFin).not.toHaveBeenCalled();
    expect(confirms).toEqual([]);
    // L'état reprenable de A n'est pas écrasé par « annulé ».
    expect(JSON.stringify(stockageA.contenu)).toBe(enregistreAvant);
    expect(stockageA.contenu).toHaveLength(2);
  });

  it('utilisateur suivant : ne voit rien de A ; A retrouve ses envois « interrompu »', async () => {
    const { t, signaux } = transport();
    const f = new FileDepot({ transport: t });
    const stockageA = memoire();
    const stockageB = memoire();
    f.utiliserStockage(stockageA);
    f.ajouterLot([pdf('a.pdf')], META);
    await attendreQue(() => signaux.length === 1);

    f.purger();
    f.utiliserStockage(stockageB);
    expect(f.getSnapshot().elements).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(stockageB.contenu).toEqual([]);

    f.purger();
    f.utiliserStockage(stockageA);
    expect(f.getSnapshot().elements.map((e) => [e.nom, e.etape])).toEqual([['a.pdf', 'interrompu']]);
  });

  it('la file de l’application suit les transitions de session', () => {
    fileDepot.utiliserStockage({
      charger: () => [{
        operationId: 'op-x', lotId: 'l', nom: 'x.pdf', taille: 1, mimeType: 'application/pdf', derniereModif: 1,
        etape: 'transfert', fileId: null, sha256: null, transfere: false, reprise: null, meta: META, creeLe: Date.now(),
      }],
      enregistrer: () => undefined,
    });
    expect(fileDepot.getSnapshot().elements).toHaveLength(1);
    beginSessionTransition('logout');
    expect(fileDepot.getSnapshot().elements).toEqual([]);
  });
});
