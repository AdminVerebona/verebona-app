/**
 * Lot 113Q (#714) — ARCHIVE ZIP DÉFINITIVE d'un diagnostic durable (serveur
 * uniquement).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONSTAT (06/11/2026) : `download.ts` reconstruisait le ZIP à CHAQUE
 * téléchargement — lecture de chaque `.gz`, DÉCOMPRESSION puis
 * RECOMPRESSION (jszip, DEFLATE niveau 6) dans le processus web. Deux
 * téléchargements = deux recompressions complètes ; et jszip ne sait pas
 * écrire le ZIP64 (archive limitée à 4 Gio).
 *
 * MAINTENANT : une fois les fichiers produits et validés, le worker ASSEMBLE
 * le ZIP une seule fois (étape ASSEMBLAGE_ZIP), le stocke sur OVH
 * (`<tentative>/archive/<nom>.zip`), le RELIT et le VÉRIFIE (étape
 * VERIFICATION_ZIP : chaque entrée décompressée, SHA-256 et taille = index
 * d'intégrité, CRC-32 = en-tête, répertoire central complet) avant toute
 * publication. Le téléchargement sert ensuite l'objet tel quel.
 *
 * SANS RECOMPRESSION : chaque fichier stocké est un gzip à un seul membre
 * (`openGzipUpload`) = en-tête gzip + flux DEFLATE brut + CRC-32 + taille.
 * Une entrée ZIP « méthode 8 » est exactement ce flux DEFLATE brut : il est
 * COPIÉ octet pour octet (en-tête gzip retiré, CRC-32 lu dans la fin du
 * gzip), sans le décompresser ni le recompresser. Mémoire : un morceau lu +
 * une partie d'envoi (8 Mio) + le répertoire central (≈ 100 octets par
 * fichier).
 *
 * ZIP64 : utilisé seulement quand il est nécessaire (fichier, position ou
 * répertoire au-delà de 4 Gio, plus de 65 535 entrées) — sinon ZIP classique,
 * lisible partout. Aucune limite de 4 Gio.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { createInflateRaw, crc32 as zcrc32 } from 'node:zlib';
import type { DiagStorage, DiagStoredIndex } from './runner';

const U32 = 0xffffffff;
const U16 = 0xffff;

/** Entrée de l'archive : chemin et fichier stocké (`.gz`) dont le flux DEFLATE est copié. */
export interface ArchiveEntry { path: string; key: string; bytes: number; compressedBytes: number; sha256?: string | null }

/** Ordre de l'archive (pur) : manifeste et rapport en tête (lecture humaine), puis l'ordre de production. */
export function archiveOrder(index: Pick<DiagStoredIndex, 'files'>, prefix: string, integrity?: { bytes: number; compressedBytes: number; sha256?: string | null } | null): ArchiveEntry[] {
  const order = (p: string) => (p === 'manifeste.json' ? 0 : p === 'rapport.txt' ? 1 : p === 'integrite.json' ? 2 : p === 'SHA256SUMS.txt' ? 3 : 4);
  const files: ArchiveEntry[] = index.files.map((f, i) => ({ f, i })).sort((a, b) => order(a.f.path) - order(b.f.path) || a.i - b.i)
    .map(({ f }) => ({ path: f.path, key: `${prefix}${f.path}.gz`, bytes: f.bytes, compressedBytes: f.compressedBytes, sha256: f.sha256 }));
  // L'index d'intégrité n'est pas listé dans lui-même : ajouté à l'archive.
  if (!index.files.some((f) => f.path === 'integrite.json')) {
    const at = files.findIndex((f) => order(f.path) > 2);
    const e = { path: 'integrite.json', key: `${prefix}integrite.json.gz`, bytes: integrity?.bytes ?? -1, compressedBytes: integrity?.compressedBytes ?? -1, sha256: integrity?.sha256 ?? null };
    files.splice(at < 0 ? files.length : at, 0, e);
  }
  return files;
}

/** Date/heure MS-DOS (UTC) d'une entrée. */
function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Longueur de l'en-tête d'un membre gzip (RFC 1952), lue dans ses premiers octets ; null : pas encore assez d'octets. */
export function gzipHeaderLength(b: Buffer): number | null {
  if (b.length < 10) return null;
  if (b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw new Error('fichier stocké : en-tête gzip invalide');
  const flg = b[3];
  let p = 10;
  if (flg & 4) { if (b.length < p + 2) return null; p += 2 + b.readUInt16LE(p); }
  const zstr = () => { const z = b.indexOf(0, p); if (z < 0) return false; p = z + 1; return true; };
  if (flg & 8 && !zstr()) return null;
  if (flg & 16 && !zstr()) return null;
  if (flg & 2) p += 2;
  return b.length >= p ? p : null;
}

type Sink = (chunk: Buffer) => Promise<void>;

interface CentralRecord { name: Buffer; crc: number; comp: number; size: number; offset: number; time: number; date: number; zip64: boolean }

/**
 * Écrivain ZIP en flux (méthode 8, entrées DEFLATE copiées). `add` rend
 * après avoir écrit l'entrée entière dans `sink` (contre-pression de bout en
 * bout) ; `finish` écrit le répertoire central (ZIP64 si nécessaire).
 */
export function createZipWriter(sink: Sink, date: Date) {
  const { time, date: ddate } = dosDateTime(date);
  const central: CentralRecord[] = [];
  let offset = 0;
  const out = async (b: Buffer) => { offset += b.length; await sink(b); };
  return {
    get offset() { return offset; },
    get entries() { return central.length; },
    /**
     * Ajoute une entrée DEFLATE déjà compressée : `deflated` rend le flux
     * DEFLATE brut (exactement `comp` octets), `crc` et `size` décrivent le
     * contenu décompressé.
     */
    async add(path: string, meta: { crc: number; comp: number; size: number }, deflated: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<void> {
      const name = Buffer.from(path, 'utf8');
      const zip64 = meta.comp >= U32 || meta.size >= U32 || offset >= U32;
      const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
      if (zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); extra.writeBigUInt64LE(BigInt(meta.size), 4); extra.writeBigUInt64LE(BigInt(meta.comp), 12); }
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(zip64 ? 45 : 20, 4);
      h.writeUInt16LE(0x0800, 6); // noms en UTF-8
      h.writeUInt16LE(8, 8);
      h.writeUInt16LE(time, 10);
      h.writeUInt16LE(ddate, 12);
      h.writeUInt32LE(meta.crc >>> 0, 14);
      h.writeUInt32LE(zip64 ? U32 : meta.comp, 18);
      h.writeUInt32LE(zip64 ? U32 : meta.size, 22);
      h.writeUInt16LE(name.length, 26);
      h.writeUInt16LE(extra.length, 28);
      const at = offset;
      await out(Buffer.concat([h, name, extra]));
      let n = 0;
      for await (const c of deflated) { n += c.length; await out(c); }
      if (n !== meta.comp) throw new Error(`${path} : ${n} octets compressés copiés au lieu de ${meta.comp}`);
      central.push({ name, crc: meta.crc >>> 0, comp: meta.comp, size: meta.size, offset: at, time, date: ddate, zip64: zip64 || at >= U32 });
    },
    async finish(): Promise<{ bytes: number; entries: number; zip64: boolean }> {
      const cdStart = offset;
      let any64 = false;
      for (const r of central) {
        const fields: bigint[] = [];
        if (r.size >= U32) fields.push(BigInt(r.size));
        if (r.comp >= U32) fields.push(BigInt(r.comp));
        if (r.offset >= U32) fields.push(BigInt(r.offset));
        const extra = fields.length ? Buffer.alloc(4 + 8 * fields.length) : Buffer.alloc(0);
        if (fields.length) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8 * fields.length, 2); fields.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + 8 * i)); any64 = true; }
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE((3 << 8) | 45, 4); // UNIX, version 4.5
        c.writeUInt16LE(fields.length || r.zip64 ? 45 : 20, 6);
        c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(8, 10);
        c.writeUInt16LE(r.time, 12);
        c.writeUInt16LE(r.date, 14);
        c.writeUInt32LE(r.crc, 16);
        c.writeUInt32LE(r.comp >= U32 ? U32 : r.comp, 20);
        c.writeUInt32LE(r.size >= U32 ? U32 : r.size, 24);
        c.writeUInt16LE(r.name.length, 28);
        c.writeUInt16LE(extra.length, 30);
        c.writeUInt16LE(0, 32);
        c.writeUInt16LE(0, 34);
        c.writeUInt16LE(0, 36);
        c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        c.writeUInt32LE(r.offset >= U32 ? U32 : r.offset, 42);
        await out(Buffer.concat([c, r.name, extra]));
      }
      const cdSize = offset - cdStart;
      const zip64 = any64 || central.length >= U16 || cdStart >= U32 || cdSize >= U32;
      if (zip64) {
        const z = Buffer.alloc(56);
        z.writeUInt32LE(0x06064b50, 0);
        z.writeBigUInt64LE(BigInt(44), 4);
        z.writeUInt16LE((3 << 8) | 45, 12);
        z.writeUInt16LE(45, 14);
        z.writeUInt32LE(0, 16);
        z.writeUInt32LE(0, 20);
        z.writeBigUInt64LE(BigInt(central.length), 24);
        z.writeBigUInt64LE(BigInt(central.length), 32);
        z.writeBigUInt64LE(BigInt(cdSize), 40);
        z.writeBigUInt64LE(BigInt(cdStart), 48);
        const recAt = offset;
        await out(z);
        const l = Buffer.alloc(20);
        l.writeUInt32LE(0x07064b50, 0);
        l.writeUInt32LE(0, 4);
        l.writeBigUInt64LE(BigInt(recAt), 8);
        l.writeUInt32LE(1, 16);
        await out(l);
      }
      const e = Buffer.alloc(22);
      e.writeUInt32LE(0x06054b50, 0);
      e.writeUInt16LE(0, 4);
      e.writeUInt16LE(0, 6);
      e.writeUInt16LE(Math.min(central.length, U16), 8);
      e.writeUInt16LE(Math.min(central.length, U16), 10);
      e.writeUInt32LE(zip64 ? U32 : cdSize, 12);
      e.writeUInt32LE(zip64 ? U32 : cdStart, 16);
      e.writeUInt16LE(0, 20);
      await out(e);
      return { bytes: offset, entries: central.length, zip64 };
    },
  };
}

// ── Lecture des fichiers stockés ────────────────────────────────────────────

async function getBody(storage: DiagStorage, key: string, range?: string): Promise<AsyncIterable<Buffer>> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const o = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key, ...(range ? { Range: range } : {}) })) as { Body?: AsyncIterable<Uint8Array> };
  if (!o.Body) throw new Error(`${key} : objet vide`);
  const body = o.Body;
  return (async function* () { for await (const c of body) yield Buffer.isBuffer(c) ? c : Buffer.from(c); })();
}

/** Fin d'un gzip stocké (8 derniers octets : CRC-32 et taille modulo 2³²). Lecture partielle (`Range`) ; repli : derniers octets du flux. */
async function gzipTrailer(storage: DiagStorage, key: string): Promise<{ crc: number; isize: number }> {
  let tail = Buffer.alloc(0);
  for await (const c of await getBody(storage, key, 'bytes=-8')) tail = tail.length + c.length > 64 ? Buffer.concat([tail, c]).subarray(-8) : Buffer.concat([tail, c]);
  tail = tail.subarray(-8);
  if (tail.length !== 8) throw new Error(`${key} : fin de gzip illisible`);
  return { crc: tail.readUInt32LE(0), isize: tail.readUInt32LE(4) };
}

/** Flux DEFLATE brut d'un gzip stocké : en-tête retiré, 8 octets de fin retenus (jamais copiés). */
async function* deflateOf(storage: DiagStorage, key: string, info: { headerLength?: number }): AsyncGenerator<Buffer> {
  let head: Buffer | null = Buffer.alloc(0);
  let hold = Buffer.alloc(0);
  for await (const c0 of await getBody(storage, key)) {
    let c = c0;
    if (head) {
      head = Buffer.concat([head, c]);
      const n = gzipHeaderLength(head);
      if (n === null) continue;
      info.headerLength = n;
      c = head.subarray(n);
      head = null;
    }
    const all = hold.length ? Buffer.concat([hold, c]) : c;
    if (all.length <= 8) { hold = Buffer.from(all); continue; }
    hold = Buffer.from(all.subarray(all.length - 8));
    yield all.subarray(0, all.length - 8);
  }
  if (head) throw new Error(`${key} : en-tête gzip incomplet`);
}

/** Taille réelle de l'objet stocké (HEAD). */
async function headSize(storage: DiagStorage, key: string): Promise<number> {
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const h = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key })) as { ContentLength?: number };
  return Number(h.ContentLength ?? NaN);
}

/** Écrit l'archive des `entries` dans `sink` (copie des flux DEFLATE, sans recompression). */
export async function writeArchive(storage: DiagStorage, entries: readonly ArchiveEntry[], date: Date, sink: Sink, onEntry?: (path: string) => void): Promise<{ bytes: number; entries: number; zip64: boolean }> {
  const zip = createZipWriter(sink, date);
  for (const e of entries) {
    onEntry?.(e.path);
    const gz = e.compressedBytes >= 0 ? e.compressedBytes : await headSize(storage, e.key);
    const { crc, isize } = await gzipTrailer(storage, e.key);
    // Taille du contenu : celle de l'index (exacte) ; à défaut celle du gzip (modulo 2³²).
    const size = e.bytes >= 0 ? e.bytes : isize;
    if ((size % 2 ** 32) !== isize) throw new Error(`${e.path} : taille de l'index (${size}) différente de celle du gzip stocké`);
    const info: { headerLength?: number } = {};
    // La longueur d'en-tête n'est connue qu'à la lecture : l'écrivain contrôle le nombre d'octets copiés.
    const body = deflateOf(storage, e.key, info);
    const first = await body.next();
    const headerLength = info.headerLength ?? 10;
    const comp = gz - headerLength - 8;
    if (comp < 0) throw new Error(`${e.path} : gzip stocké tronqué`);
    await zip.add(e.path, { crc, comp, size }, (async function* () { if (!first.done) yield first.value; yield* body; })());
  }
  return zip.finish();
}

// ── Vérification de l'archive stockée ───────────────────────────────────────

/** Lecteur séquentiel d'octets sur un flux (vérification de l'archive). */
function byteReader(src: AsyncIterable<Buffer>) {
  const it = src[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  let pos = 0;
  const fill = async (n: number) => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
    }
    return true;
  };
  return {
    get pos() { return pos; },
    async read(n: number): Promise<Buffer> {
      if (!(await fill(n))) throw new Error(`archive tronquée à l'octet ${pos + buf.length}`);
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      pos += n;
      return out;
    },
    /** `n` octets rendus morceau par morceau (jamais en entier en mémoire). */
    async *take(n: number): AsyncGenerator<Buffer> {
      let left = n;
      while (left > 0) {
        if (!buf.length && !(await fill(1))) throw new Error(`archive tronquée à l'octet ${pos}`);
        const k = Math.min(left, buf.length);
        const out = buf.subarray(0, k);
        buf = buf.subarray(k);
        pos += k;
        left -= k;
        yield out;
      }
    },
    async rest(): Promise<number> { let n = buf.length; buf = Buffer.alloc(0); for (;;) { const r = await it.next(); if (r.done) break; n += r.value.length; } pos += n; return n; },
  };
}

/** Décompresse un flux DEFLATE brut et rend taille, SHA-256 et CRC-32 du contenu. */
async function inflateDigest(chunks: AsyncIterable<Buffer>): Promise<{ size: number; sha256: string; crc: number }> {
  const inf = createInflateRaw();
  const hash = createHash('sha256');
  let size = 0;
  let crc = 0;
  const done = new Promise<void>((resolve, reject) => {
    inf.on('data', (c: Buffer) => { size += c.length; hash.update(c); crc = zcrc32(c, crc); });
    inf.on('end', resolve);
    inf.on('error', reject);
  });
  for await (const c of chunks) if (!inf.write(c)) await new Promise<void>((r) => inf.once('drain', r));
  inf.end();
  await done;
  return { size, sha256: hash.digest('hex'), crc: crc >>> 0 };
}

export interface ArchiveCheck { ok: boolean; problems: string[]; entries: number; bytes: number }

/**
 * Vérification INTÉGRALE de l'archive stockée (relue depuis OVH) : chaque
 * entrée locale est décompressée (taille, SHA-256, CRC-32 comparés à
 * l'en-tête et à l'index d'intégrité), dans l'ordre attendu ; répertoire
 * central et fin d'archive présents, nombre d'entrées exact, taille de
 * l'objet = taille envoyée. Mémoire bornée (un morceau à la fois).
 */
export async function verifyStoredArchive(storage: DiagStorage, key: string, expected: readonly ArchiveEntry[], uploadedBytes: number): Promise<ArchiveCheck> {
  const problems: string[] = [];
  const size = await headSize(storage, key).catch(() => NaN);
  if (size !== uploadedBytes) problems.push(`archive : taille stockée ${size} ≠ envoyée ${uploadedBytes}`);
  const r = byteReader(await getBody(storage, key));
  let n = 0;
  for (const e of expected) {
    const h = await r.read(30);
    if (h.readUInt32LE(0) !== 0x04034b50) { problems.push(`entrée ${n + 1} (${e.path}) : en-tête local absent`); break; }
    const crc = h.readUInt32LE(14);
    let comp = h.readUInt32LE(18);
    let usize = h.readUInt32LE(22);
    const name = (await r.read(h.readUInt16LE(26))).toString('utf8');
    const extra = await r.read(h.readUInt16LE(28));
    if (comp === U32 || usize === U32) {
      for (let p = 0; p + 4 <= extra.length;) {
        const id = extra.readUInt16LE(p); const len = extra.readUInt16LE(p + 2);
        if (id === 0x0001 && len >= 16) { usize = Number(extra.readBigUInt64LE(p + 4)); comp = Number(extra.readBigUInt64LE(p + 12)); }
        p += 4 + len;
      }
    }
    if (name !== e.path) problems.push(`entrée ${n + 1} : « ${name} » au lieu de « ${e.path} »`);
    const d = await inflateDigest(r.take(comp));
    if (d.size !== usize) problems.push(`${name} : ${d.size} octets décompressés ≠ en-tête ${usize}`);
    if (d.crc !== crc) problems.push(`${name} : CRC-32 différent de l'en-tête`);
    if (e.bytes >= 0 && d.size !== e.bytes) problems.push(`${name} : ${d.size} octets ≠ index ${e.bytes}`);
    if (e.sha256 && d.sha256 !== e.sha256) problems.push(`${name} : SHA-256 différent de l'index d'intégrité`);
    n++;
    if (problems.length > 20) break;
  }
  if (!problems.length) {
    // Répertoire central : une entrée par fichier, puis fin d'archive (ZIP64 éventuel).
    let cd = 0;
    for (;;) {
      const sig = (await r.read(4)).readUInt32LE(0);
      if (sig !== 0x02014b50) {
        if (sig === 0x06064b50) { const len = Number((await r.read(8)).readBigUInt64LE(0)); await r.read(len); const loc = await r.read(4); if (loc.readUInt32LE(0) !== 0x07064b50) problems.push('archive : localisateur ZIP64 absent'); await r.read(16); await r.read(4); }
        const eocd = await r.read(18);
        const total = eocd.readUInt16LE(6);
        if (total !== U16 && total !== cd) problems.push(`archive : fin d'archive annonce ${total} entrées pour ${cd}`);
        break;
      }
      const c = await r.read(42);
      await r.read(c.readUInt16LE(24) + c.readUInt16LE(26) + c.readUInt16LE(28));
      cd++;
    }
    if (cd !== expected.length) problems.push(`archive : répertoire central de ${cd} entrée(s) pour ${expected.length} fichier(s)`);
    const trailing = await r.rest();
    if (trailing) problems.push(`archive : ${trailing} octet(s) inattendu(s) après la fin`);
  }
  return { ok: problems.length === 0, problems, entries: n, bytes: Number.isFinite(size) ? size : 0 };
}
