/**
 * File de dépôt — APP-PERF-25 (concurrence bornée), APP-PERF-29 (cycle de
 * vie indépendant du panneau, reprise), APP-PERF-30 (rejeu idempotent).
 *
 * Transport simulé : aucune requête réelle. On vérifie l'ORDONNANCEMENT et
 * les CONTRATS (une confirmation par fichier, même clé à chaque rejeu,
 * jamais de nouveau fichier lancé après annulation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/upload-http', () => ({
  fetchDepot: vi.fn(),
  messageSelonStatut: (s: number, r: string) => `${r} (erreur ${s}).`,
}));
const bloque = vi.hoisted(() => ({ notifier: vi.fn() }));
vi.mock('@/lib/write-blocked', async (o) => ({ ...(await o<object>()), notifyWriteBlocked: bloque.notifier }));

import {
  FileDepot, type TransportDepot, type BilanLot, type MetaConfirmation, type ElementPersiste, type StockageDepot,
} from '../upload-queue';

const META: MetaConfirmation = {
  assetId: 12, substructureId: null, equipmentId: null, documentType: 'FACTURE', documentDate: '2026-10-01',
  description: 'Titre', supplier: 'EDF', amountCents: 1000,
};
const HASH = 'a'.repeat(64);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fichier = (nom: string, taille = 1000) => new File([new Uint8Array(taille)], nom, { type: 'application/pdf', lastModified: 1 });
const attendreQue = async (cond: () => boolean, max = 200) => {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
};

/** Serveur simulé : presign idempotent par clé, PUT contrôlable, confirm comptée. */
function serveur() {
  const ids = new Map<string, number>();
  const confirmes = new Map<string, number>();
  let prochain = 100;
  const etat = {
    presign: [] as Array<Record<string, unknown>>,
    puts: [] as string[],
    confirms: [] as Array<Record<string, unknown>>,
    enVol: 0, picEnVol: 0,
    attentes: [] as number[],
    /** Réponses forcées, consommées dans l'ordre. */
    presignForce: [] as Array<() => Response>,
    putForce: [] as Array<() => Promise<void>>,
    confirmForce: [] as Array<() => Response | Promise<Response>>,
    hashForce: [] as Array<() => Promise<string>>,
    /** Retient les PUT tant que `bloquerPut` est vrai. */
    bloquerPut: false,
    liberer: [] as Array<() => void>,
  };
  const transport: TransportDepot = {
    hacher: async (_f, signal, onProgress) => {
      if (etat.hashForce.length) return etat.hashForce.shift()!();
      onProgress(0.5); onProgress(1);
      if (signal.aborted) throw Object.assign(new Error('x'), { name: 'AbortError' });
      return HASH;
    },
    presign: async (body) => {
      etat.presign.push(body);
      if (etat.presignForce.length) return etat.presignForce.shift()!();
      const op = String(body.operationId);
      if (!ids.has(op)) ids.set(op, prochain++);
      if (confirmes.has(op)) return json(200, { fileId: ids.get(op), uploadStatus: 'COMPLETED', reprise: true });
      return json(201, { fileId: ids.get(op), uploadUrl: `https://s3/${op}`, uploadStatus: 'PENDING' });
    },
    envoyer: async (url, _file, _mime, signal, onProgress) => {
      etat.puts.push(url);
      etat.enVol += 1;
      etat.picEnVol = Math.max(etat.picEnVol, etat.enVol);
      try {
        if (etat.putForce.length) { await etat.putForce.shift()!(); return; }
        if (etat.bloquerPut) {
          await new Promise<void>((resolve, reject) => {
            etat.liberer.push(resolve);
            signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })));
          });
        }
        onProgress(1);
      } finally {
        etat.enVol -= 1;
      }
    },
    confirmer: async (body) => {
      etat.confirms.push(body);
      if (etat.confirmForce.length) return etat.confirmForce.shift()!();
      const op = String(body.operationId);
      confirmes.set(op, (confirmes.get(op) ?? 0) + 1);
      return json(200, { success: true, file: { id: body.fileId } });
    },
    attendre: async (ms) => { etat.attentes.push(ms); },
  };
  return { etat, transport, confirmes };
}

function file(transport: TransportDepot, concurrenceTransferts = 2) {
  const bilans: BilanLot[] = [];
  const f = new FileDepot({ transport, concurrenceTransferts });
  return { f, bilans, surFin: (b: BilanLot) => bilans.push(b) };
}

beforeEach(() => bloque.notifier.mockReset());

describe('concurrence bornée (APP-PERF-25, CA-02)', () => {
  it.each([1, 2, 3])('concurrence %i : jamais plus de transferts simultanés, une préparation à la fois', async (n) => {
    const s = serveur();
    s.etat.bloquerPut = true;
    const { f, bilans, surFin } = file(s.transport, n);
    f.ajouterLot([1, 2, 3, 4, 5].map((i) => fichier(`f${i}.pdf`)), META, { surFin });
    while (bilans.length === 0) {
      await new Promise((r) => setTimeout(r, 0));
      expect(s.etat.enVol).toBeLessThanOrEqual(n);
      s.etat.liberer.shift()?.();
    }
    expect(f.picTransferts).toBe(n);
    expect(s.etat.picEnVol).toBe(n);
    expect(f.picPreparations).toBe(1);
  });

  it('chaque fichier : sa propre opération, UNE confirmation, un document distinct (CA-01)', async () => {
    const s = serveur();
    const { f, bilans, surFin } = file(s.transport, 2);
    f.ajouterLot([fichier('a.pdf'), fichier('b.pdf'), fichier('c.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    const ops = s.etat.confirms.map((c) => c.operationId);
    expect(new Set(ops).size).toBe(3);
    expect([...s.confirmes.values()]).toEqual([1, 1, 1]);
    expect(bilans[0].fileIds.sort()).toEqual([100, 101, 102]);
    expect(s.etat.confirms.every((c) => !('fileIds' in c))).toBe(true); // jamais de confirmation groupée
    // Plusieurs documents : titre, fournisseur et montant non recopiés.
    expect(s.etat.confirms.every((c) => c.description === null && c.supplier === null && c.amountCents === null)).toBe(true);
  });

  it('un seul fichier : métadonnées saisies transmises', async () => {
    const s = serveur();
    const { f, bilans, surFin } = file(s.transport);
    f.ajouterLot([fichier('a.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(s.etat.confirms[0]).toMatchObject({ description: 'Titre', supplier: 'EDF', amountCents: 1000, assetId: 12 });
  });
});

describe('succès partiel et reprise par fichier (APP-PERF-25 T-02)', () => {
  it('un transfert échoue : les autres sont confirmés ; la reprise ne rejoue pas les confirmés', async () => {
    const s = serveur();
    const { f, bilans, surFin } = file(s.transport, 1);
    s.etat.putForce.push(async () => { throw new Error('réseau'); });
    f.ajouterLot([fichier('a.pdf'), fichier('b.pdf'), fichier('c.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(bilans[0].fileIds).toHaveLength(2);
    expect(bilans[0].echecs).toHaveLength(1);
    const echoue = f.getSnapshot().elements.find((e) => e.etape === 'echec')!;
    expect(echoue.reprise).toBe('presign');

    f.reprendre(echoue.operationId);
    await attendreQue(() => bilans.length === 2);
    expect(bilans[1]).toMatchObject({ tardif: true, fileIds: [echoue.fileId] });
    // Même opération ⇒ même document ; les deux autres ne sont pas reconfirmés.
    expect([...s.confirmes.values()]).toEqual([1, 1, 1]);
    expect(s.etat.presign.filter((p) => p.operationId === echoue.operationId)).toHaveLength(2);
  });

  it('erreur d’empreinte : aucun presign, échec explicite reprenable (jamais de valeur de repli)', async () => {
    const s = serveur();
    s.etat.hashForce.push(async () => { throw new Error("Impossible de calculer l'empreinte du fichier."); });
    const { f, bilans, surFin } = file(s.transport);
    f.ajouterLot([fichier('a.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(s.etat.presign).toHaveLength(0);
    const e = f.getSnapshot().elements[0];
    expect(e).toMatchObject({ etape: 'echec', reprise: 'preparation', sha256: null });
    f.reprendre(e.operationId);
    await attendreQue(() => f.getSnapshot().elements[0].etape === 'termine');
    expect(s.etat.presign[0].sha256Hash).toBe(HASH);
  });
});

describe('idempotence côté client (APP-PERF-30)', () => {
  it('réponse de confirmation perdue : rejeu avec la même clé, aucun nouveau transfert (CA-01)', async () => {
    const s = serveur();
    s.etat.confirmForce.push(() => { throw new Error('Connexion au serveur impossible.'); });
    const { f, bilans, surFin } = file(s.transport);
    f.ajouterLot([fichier('a.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(s.etat.confirms).toHaveLength(2);
    expect(s.etat.confirms[0]).toEqual(s.etat.confirms[1]);
    expect(s.etat.presign).toHaveLength(1);
    expect(s.etat.puts).toHaveLength(1);
    expect(bilans[0].fileIds).toEqual([100]);
  });

  it('résultat inconnu persistant : échec « confirmation » ; « Reprendre » ne renvoie pas le fichier', async () => {
    const s = serveur();
    for (let i = 0; i < 3; i++) s.etat.confirmForce.push(() => json(502, {}));
    const { f, bilans, surFin } = file(s.transport);
    f.ajouterLot([fichier('a.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    const e = f.getSnapshot().elements[0];
    expect(e).toMatchObject({ etape: 'echec', reprise: 'confirmation', transfere: true });
    expect(e.erreur).toMatch(/Reprendre/);
    expect(s.etat.attentes).toEqual([1000, 2000]);
    f.reprendre(e.operationId);
    await attendreQue(() => f.getSnapshot().elements[0].etape === 'termine');
    expect(s.etat.presign).toHaveLength(1);
    expect(s.etat.puts).toHaveLength(1);
  });

  it('objet absent à la confirmation : nouveau transfert sur la même opération, une seule fois', async () => {
    const s = serveur();
    s.etat.confirmForce.push(() => json(409, { code: 'OBJECT_MISSING', error: 'Le fichier n’a pas été reçu.' }));
    const { f, bilans, surFin } = file(s.transport);
    f.ajouterLot([fichier('a.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(s.etat.puts).toHaveLength(2);
    expect(new Set(s.etat.presign.map((p) => p.operationId)).size).toBe(1);
    expect(bilans[0].fileIds).toEqual([100]);
  });

  it('presign rejoué « déjà confirmé » : pas de PUT, confirmation rejouée seulement', async () => {
    const s = serveur();
    const { f, bilans, surFin } = file(s.transport);
    s.etat.presignForce.push(() => json(200, { fileId: 555, uploadStatus: 'COMPLETED', reprise: true }));
    f.ajouterLot([fichier('a.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(s.etat.puts).toHaveLength(0);
    expect(s.etat.confirms[0].fileId).toBe(555);
  });

  it('débit de préparation atteint (429) : attente de la fenêtre puis nouvelle tentative', async () => {
    const s = serveur();
    s.etat.presignForce.push(() => json(429, { error: 'RATE_LIMIT_EXCEEDED', resetAt: Date.now() + 30_000 }));
    const { f, bilans, surFin } = file(s.transport);
    f.ajouterLot([fichier('a.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(s.etat.attentes[0]).toBeGreaterThan(20_000);
    expect(s.etat.attentes[0]).toBeLessThanOrEqual(60_000);
    expect(bilans[0].fileIds).toHaveLength(1);
  });
});

describe('annulation explicite (APP-PERF-25 T-03, APP-PERF-29 CA-02)', () => {
  it('annuler le lot : transfert en cours interrompu, aucun nouveau fichier lancé', async () => {
    const s = serveur();
    s.etat.bloquerPut = true;
    const { f, bilans, surFin } = file(s.transport, 1);
    const lot = f.ajouterLot([fichier('a.pdf'), fichier('b.pdf'), fichier('c.pdf')], META, { surFin });
    await attendreQue(() => s.etat.enVol === 1);
    const presignAvant = s.etat.presign.length;
    f.annulerLot(lot);
    await attendreQue(() => bilans.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(s.etat.presign.length).toBe(presignAvant);
    expect(s.etat.confirms).toHaveLength(0);
    expect(bilans[0]).toMatchObject({ fileIds: [], annules: 3 });
    expect(f.getSnapshot().enCours).toBe(0);
  });

  it('refus de droits (essai terminé) : fenêtre ouverte, le reste du lot n’est pas lancé', async () => {
    const s = serveur();
    s.etat.presignForce.push(() => json(403, { error: 'TRIAL_EXPIRED', code: 'TRIAL_EXPIRED', message: 'Essai terminé.' }));
    const { f, bilans, surFin } = file(s.transport, 1);
    f.ajouterLot([fichier('a.pdf'), fichier('b.pdf'), fichier('c.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(bloque.notifier).toHaveBeenCalledTimes(1);
    expect(s.etat.presign).toHaveLength(1);
    expect(bilans[0]).toMatchObject({ ecritureBloquee: true, fileIds: [] });
  });

  it('refus définitif (quota de stockage) : non reprenable, les autres fichiers continuent', async () => {
    const s = serveur();
    s.etat.confirmForce.push(() => json(413, { code: 'STORAGE_QUOTA_EXCEEDED', message: 'Espace de stockage insuffisant.' }));
    const { f, bilans, surFin } = file(s.transport, 1);
    f.ajouterLot([fichier('a.pdf'), fichier('b.pdf')], META, { surFin });
    await attendreQue(() => bilans.length === 1);
    expect(bilans[0].fileIds).toHaveLength(1);
    expect(bilans[0].echecs[0].erreur).toBe('Espace de stockage insuffisant.');
    expect(f.getSnapshot().elements.find((e) => e.etape === 'echec')!.reprise).toBeNull();
  });
});

describe('reprise après fermeture (APP-PERF-29)', () => {
  function stockageMemoire(): StockageDepot & { contenu: ElementPersiste[] } {
    const st = {
      contenu: [] as ElementPersiste[],
      charger: () => JSON.parse(JSON.stringify(st.contenu)),
      enregistrer: (e: ElementPersiste[]) => { st.contenu = JSON.parse(JSON.stringify(e)); },
    };
    return st;
  }

  it('état conservé sans URL signée ni jeton ; restauré « interrompu »', async () => {
    const s = serveur();
    s.etat.bloquerPut = true;
    const st = stockageMemoire();
    const { f } = file(s.transport);
    f.utiliserStockage(st);
    f.ajouterLot([fichier('a.pdf')], META);
    await attendreQue(() => s.etat.enVol === 1);
    const brut = JSON.stringify(st.contenu);
    expect(st.contenu).toHaveLength(1);
    expect(brut).not.toMatch(/https:\/\/s3|uploadUrl|token|Bearer/i);
    expect(st.contenu[0]).toMatchObject({ fileId: 100, sha256: HASH, transfere: false });

    const apres = new FileDepot({ transport: s.transport });
    apres.utiliserStockage(st);
    const e = apres.getSnapshot().elements[0];
    expect(e).toMatchObject({ etape: 'interrompu', fichierDisponible: false, reprise: 'preparation' });
    expect(() => apres.reprendre(e.operationId)).toThrow(/Resélectionnez/);
    expect(() => apres.reprendre(e.operationId, fichier('autre.pdf'))).toThrow(/pas le même fichier/);
  });

  it('fichier resélectionné : nouvelle empreinte, même opération, aucun doublon', async () => {
    const s = serveur();
    const st = stockageMemoire();
    st.contenu = [{
      operationId: '11111111-2222-4333-8444-555555555555', lotId: 'l', nom: 'a.pdf', taille: 1000, mimeType: 'application/pdf',
      derniereModif: 1, etape: 'transfert', fileId: 100, sha256: HASH, transfere: false, reprise: null, meta: META, creeLe: Date.now(),
    }];
    const f = new FileDepot({ transport: s.transport });
    f.utiliserStockage(st);
    f.reprendre('11111111-2222-4333-8444-555555555555', fichier('a.pdf'));
    await attendreQue(() => f.getSnapshot().elements[0].etape === 'termine');
    expect(s.etat.presign[0].operationId).toBe('11111111-2222-4333-8444-555555555555');
    expect(s.etat.confirms).toHaveLength(1);
    expect(st.contenu).toHaveLength(0); // terminé : plus rien à reprendre
  });

  it('transféré mais non confirmé : confirmation seule, sans le fichier', async () => {
    const s = serveur();
    const st = stockageMemoire();
    st.contenu = [{
      operationId: '11111111-2222-4333-8444-666666666666', lotId: 'l', nom: 'a.pdf', taille: 1000, mimeType: 'application/pdf',
      derniereModif: 1, etape: 'confirmation', fileId: 321, sha256: HASH, transfere: true, reprise: null, meta: META, creeLe: Date.now(),
    }];
    const f = new FileDepot({ transport: s.transport });
    f.utiliserStockage(st);
    expect(f.getSnapshot().elements[0].reprise).toBe('confirmation');
    f.reprendre('11111111-2222-4333-8444-666666666666');
    await attendreQue(() => f.getSnapshot().elements[0].etape === 'termine');
    expect(s.etat.presign).toHaveLength(0);
    expect(s.etat.puts).toHaveLength(0);
    expect(s.etat.confirms[0]).toMatchObject({ fileId: 321, operationId: '11111111-2222-4333-8444-666666666666' });
  });

  it('état plus ancien que 24 h : ignoré (le serveur a purgé le dépôt)', () => {
    const st = stockageMemoire();
    st.contenu = [{
      operationId: '11111111-2222-4333-8444-777777777777', lotId: 'l', nom: 'a.pdf', taille: 1, mimeType: 'application/pdf',
      derniereModif: 1, etape: 'attente', fileId: null, sha256: null, transfere: false, reprise: null, meta: META,
      creeLe: Date.now() - 25 * 3600 * 1000,
    }];
    const f = new FileDepot({ transport: serveur().transport });
    f.utiliserStockage(st);
    expect(f.getSnapshot().elements).toHaveLength(0);
  });
});
