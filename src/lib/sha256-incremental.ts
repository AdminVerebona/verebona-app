/**
 * SHA-256 incrémental (FIPS 180-4), sans dépendance — APP-PERF-24.
 *
 * `crypto.subtle.digest` n'accepte qu'un tampon COMPLET : pour hacher un
 * fichier de 100 Mo, il fallait le recopier entier en mémoire. Cette
 * implémentation consomme le fichier tranche par tranche (`update`) et ne
 * conserve que l'état interne (8 mots) et un bloc partiel de 64 octets.
 *
 * Exactitude vérifiée contre `node:crypto` et les vecteurs du NIST
 * (`__tests__/sha256-incremental.test.ts`).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly w = new Uint32Array(64);
  private readonly bloc = new Uint8Array(64);
  private remplissage = 0;
  /** Longueur totale en octets (sûre jusqu'à 2^53 − 1). */
  private longueur = 0;
  private termine = false;

  update(donnees: Uint8Array): this {
    if (this.termine) throw new Error('Sha256 : empreinte déjà calculée');
    let i = 0;
    const n = donnees.length;
    this.longueur += n;
    // Compléter un bloc partiel.
    if (this.remplissage > 0) {
      const prendre = Math.min(64 - this.remplissage, n);
      this.bloc.set(donnees.subarray(0, prendre), this.remplissage);
      this.remplissage += prendre;
      i = prendre;
      if (this.remplissage === 64) {
        this.compresser(this.bloc, 0);
        this.remplissage = 0;
      }
    }
    // Blocs entiers, lus en place (aucune copie).
    for (; i + 64 <= n; i += 64) this.compresser(donnees, i);
    // Reste.
    if (i < n) {
      this.bloc.set(donnees.subarray(i), 0);
      this.remplissage = n - i;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.termine) throw new Error('Sha256 : empreinte déjà calculée');
    const bits = this.longueur * 8;
    const fin = new Uint8Array(this.remplissage < 56 ? 64 : 128);
    fin.set(this.bloc.subarray(0, this.remplissage), 0);
    fin[this.remplissage] = 0x80;
    const vue = new DataView(fin.buffer);
    vue.setUint32(fin.length - 8, Math.floor(bits / 0x100000000), false);
    vue.setUint32(fin.length - 4, bits >>> 0, false);
    for (let o = 0; o < fin.length; o += 64) this.compresser(fin, o);
    this.termine = true;
    const sortie = new Uint8Array(32);
    const vs = new DataView(sortie.buffer);
    for (let k = 0; k < 8; k++) vs.setUint32(k * 4, this.h[k], false);
    return sortie;
  }

  digestHex(): string {
    return enHex(this.digest());
  }

  private compresser(d: Uint8Array, o: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const j = o + t * 4;
      w[t] = ((d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    const h = this.h;
    let a = h[0], b = h[1], c = h[2], e = h[4], f = h[5], g = h[6], hh = h[7], dd = h[3];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (dd + t1) >>> 0;
      dd = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + dd) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
}

export function enHex(octets: Uint8Array): string {
  let s = '';
  for (let i = 0; i < octets.length; i++) s += octets[i].toString(16).padStart(2, '0');
  return s;
}
