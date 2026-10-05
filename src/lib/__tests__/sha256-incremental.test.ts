/**
 * APP-PERF-24 — empreinte SHA-256 exacte, mémoire bornée, sans valeur de repli.
 *
 * T-01 : empreintes de fichiers vides, petits et grands comparées à une
 * référence (`node:crypto`, vecteurs NIST).
 * CA-02 : le calcul ne lit jamais plus d'une tranche à la fois et ne recopie
 * pas le fichier entier.
 * T-03 : une erreur de lecture lève une erreur explicite (jamais
 * « placeholder-hash ») ; l'annulation est respectée.
 */
import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { Sha256 } from '../sha256-incremental';
import {
  computeFileSha256, estEmpreinteSha256, EmpreinteIndisponibleError, TRANCHE_EMPREINTE,
} from '../file-validation';

const ref = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const texte = (s: string) => new TextEncoder().encode(s);

describe('Sha256 incrémental — vecteurs de référence', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('NIST « %s »', (entree, attendu) => {
    expect(new Sha256().update(texte(entree)).digestHex()).toBe(attendu);
  });

  it('un million de « a », par tranches irrégulières', () => {
    const h = new Sha256();
    const bloc = new Uint8Array(1_000_000).fill(0x61);
    for (let o = 0; o < bloc.length; o += 777) h.update(bloc.subarray(o, Math.min(o + 777, bloc.length)));
    expect(h.digestHex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it.each([1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 4097])('%i octets aléatoires = node:crypto (découpe arbitraire)', (n) => {
    const d = new Uint8Array(randomBytes(n));
    const h = new Sha256();
    let o = 0;
    let pas = 1;
    while (o < n) { h.update(d.subarray(o, Math.min(n, o + pas))); o += pas; pas = (pas * 7) % 97 + 1; }
    expect(h.digestHex()).toBe(ref(d));
  });

  it('refuse une seconde finalisation', () => {
    const h = new Sha256();
    h.digest();
    expect(() => h.digest()).toThrow();
    expect(() => h.update(new Uint8Array(1))).toThrow();
  });
});

/** Blob instrumenté : mesure la taille de chaque lecture. */
function blobInstrumente(donnees: Uint8Array<ArrayBuffer>) {
  const lectures: number[] = [];
  const blob = new Blob([donnees]);
  const enveloppe = {
    size: blob.size,
    type: '',
    slice: (a?: number, b?: number) => {
      const s = blob.slice(a, b);
      return { arrayBuffer: async () => { const buf = await s.arrayBuffer(); lectures.push(buf.byteLength); return buf; } };
    },
    arrayBuffer: async () => { lectures.push(blob.size); return blob.arrayBuffer(); },
  } as unknown as Blob;
  return { enveloppe, lectures };
}

describe('computeFileSha256 — exactitude', () => {
  it('fichier vide : empreinte du vide (le refus relève du contrat de dépôt, pas du hash)', async () => {
    expect(await computeFileSha256(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('petit fichier (chemin natif) = référence', async () => {
    const d = new Uint8Array(randomBytes(10_000));
    expect(await computeFileSha256(new Blob([d]))).toBe(ref(d));
  });

  it('grand fichier (plusieurs tranches, dernière partielle) = référence', async () => {
    const d = new Uint8Array(randomBytes(3 * 1024 * 1024 + 12_345));
    expect(await computeFileSha256(new Blob([d]), { trancheOctets: 1024 * 1024 })).toBe(ref(d));
  });

  it('taille exactement multiple de la tranche = référence', async () => {
    const d = new Uint8Array(randomBytes(2 * 65_536));
    expect(await computeFileSha256(new Blob([d]), { trancheOctets: 65_536 })).toBe(ref(d));
  });
});

describe('computeFileSha256 — mémoire bornée (CA-02)', () => {
  it('aucune lecture ne dépasse une tranche ; le fichier entier n’est jamais lu d’un bloc', async () => {
    const d = new Uint8Array(randomBytes(1_000_003));
    const { enveloppe, lectures } = blobInstrumente(d);
    const progression: number[] = [];
    const h = await computeFileSha256(enveloppe, { trancheOctets: 100_000, onProgress: (f) => progression.push(f) });
    expect(h).toBe(ref(d));
    expect(Math.max(...lectures)).toBeLessThanOrEqual(100_000);
    expect(lectures.reduce((a, b) => a + b, 0)).toBe(d.length);
    expect(progression.at(-1)).toBe(1);
    expect(progression).toEqual([...progression].sort((a, b) => a - b));
  });

  it('tranche par défaut : 4 Mio', () => {
    expect(TRANCHE_EMPREINTE).toBe(4 * 1024 * 1024);
  });
});

describe('computeFileSha256 — erreurs et annulation (T-03)', () => {
  it('erreur de lecture : erreur explicite, aucune valeur de repli', async () => {
    const casse = { size: 10_000_000, type: '', slice: () => ({ arrayBuffer: async () => { throw new Error('NotReadableError'); } }) } as unknown as Blob;
    await expect(computeFileSha256(casse)).rejects.toBeInstanceOf(EmpreinteIndisponibleError);
  });

  it('annulation entre deux tranches : AbortError, lecture interrompue', async () => {
    const d = new Uint8Array(500_000);
    const { enveloppe, lectures } = blobInstrumente(d);
    const c = new AbortController();
    const p = computeFileSha256(enveloppe, {
      trancheOctets: 100_000, signal: c.signal, onProgress: (f) => { if (f >= 0.2) c.abort(); },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(lectures.length).toBeLessThan(5);
  });

  it('déjà annulé : rien n’est lu', async () => {
    const { enveloppe, lectures } = blobInstrumente(new Uint8Array(10));
    const c = new AbortController();
    c.abort();
    await expect(computeFileSha256(enveloppe, { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(lectures).toEqual([]);
  });
});

describe('estEmpreinteSha256 (CA-01)', () => {
  it('écarte les valeurs de repli et les chaînes arbitraires', () => {
    expect(estEmpreinteSha256('placeholder-hash')).toBe(false);
    expect(estEmpreinteSha256('')).toBe(false);
    expect(estEmpreinteSha256(null)).toBe(false);
    expect(estEmpreinteSha256('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855')).toBe(false);
    expect(estEmpreinteSha256('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(true);
  });
});
