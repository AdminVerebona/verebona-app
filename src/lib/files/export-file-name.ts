/**
 * Noms des fichiers d'export du BO — lot 113T (Trello #718).
 *
 * Règle commune serveur / navigateur : `verebona-<type>-<identifiant>[-<variante>]-<AAAA-MM-JJ>.<ext>`
 * (ex. `verebona-execution-T1-ef883f80-2026-11-06.json`). Le nom est sûr pour
 * Windows, macOS, Linux et iOS (Fichiers) : lettres ASCII, chiffres, « . »,
 * « _ » et « - » seulement, longueur bornée. Un segment UUID de l'identifiant
 * est réduit à ses 8 premiers caractères (identifiant complet DANS le fichier).
 * Date : jour civil Europe/Paris de l'export.
 *
 * Module pur (aucune dépendance serveur) : utilisable côté client.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SLUG = 80;

/** Jour civil `AAAA-MM-JJ` (Europe/Paris) d'un instant. */
export function exportDateStamp(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const s = `${get('year')}-${get('month')}-${get('day')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : at.toISOString().slice(0, 10);
}

/** Segment de nom sûr : `[A-Za-z0-9._-]`, sans point initial, tirets regroupés. */
export function safeNameSegment(raw: string, max = MAX_SLUG): string {
  return raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, max)
    .replace(/[-.]+$/, '');
}

/** Identifiant utile : `T1:ef883f80-e565-…` → `T1-ef883f80` ; `T1:job:42` → `T1-job-42`. */
export function exportIdSlug(id: string | number): string {
  return safeNameSegment(String(id).split(':').map((seg) => (UUID.test(seg) ? seg.slice(0, 8) : seg)).join('-'));
}

/** Nom complet d'un fichier d'export. */
export function exportFileName(kind: string, id: string | number | null, at: Date = new Date(), opts: { variant?: string; ext?: string } = {}): string {
  const parts = ['verebona', safeNameSegment(kind, 40)];
  const slug = id === null || id === '' ? '' : exportIdSlug(id);
  if (slug) parts.push(slug);
  if (opts.variant) parts.push(safeNameSegment(opts.variant, 40));
  parts.push(exportDateStamp(at));
  return `${parts.filter(Boolean).join('-')}.${safeNameSegment(opts.ext ?? 'json', 8) || 'json'}`;
}

/**
 * Nom porté par un en-tête Content-Disposition (`filename*` UTF-8 d'abord,
 * puis `filename`), rendu sûr ; null s'il est absent ou inutilisable.
 */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  let name: string | null = null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    const v = star[1].trim().replace(/^"(.*)"$/, '$1');
    const m = /^[A-Za-z0-9_-]*''(.*)$/.exec(v);
    try { name = decodeURIComponent(m ? m[1] : v); } catch { name = null; }
  }
  if (!name) {
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    if (plain) name = (plain[2] ?? plain[1]).trim();
  }
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = safeNameSegment(dot > 0 ? base.slice(0, dot) : base, 160);
  const ext = dot > 0 ? safeNameSegment(base.slice(dot + 1), 8) : '';
  if (!stem) return null;
  return ext ? `${stem}.${ext}` : stem;
}
