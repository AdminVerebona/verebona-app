/**
 * Carte #843 (E04) — DÉTECTION et MASQUAGE des IBAN dans un texte libre (pur, sans dépendance).
 *
 * Les masques existants (`sensitive-data.policy`, passerelle IA `redaction.ts`, `redaction.service`) ne
 * reconnaissaient qu'un IBAN écrit en MAJUSCULES : « fr76 3000 6000 0112 3456 7890 189 » passait en clair. Ce
 * module ajoute la forme écrite en minuscules ou en casse mêlée, avec une garde contre les faux positifs : une
 * suite qui n'est PAS en majuscules n'est masquée que si sa clé de contrôle ISO 13616 (modulo 97) est juste.
 *
 *   · `maskIbansInText`   : remplace chaque IBAN par sa forme masquée lisible (« FR76 •••• •••• 0189 ») — pour
 *                           un texte conservé et relu par l'utilisateur (message du fil) ;
 *   · `replaceIbansInText` : remplace par un marqueur choisi (prompt d'un modèle, journal) ;
 *   · `containsIban`      : présence d'un IBAN (contrôles et tests d'absence).
 */

/** IBAN écrit en majuscules (forme historique des masques, conservée telle quelle). */
const IBAN_MAJ = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
/** IBAN en casse quelconque : masqué seulement si sa clé de contrôle est juste. */
const IBAN_CI = /\b[a-z]{2}\d{2}(?:[ ]?[a-z0-9]{4}){2,7}(?:[ ]?[a-z0-9]{1,4})?\b/gi;

/** Clé de contrôle ISO 13616 (modulo 97) d'un IBAN compact. Pur. */
export function ibanChecksumValid(raw: string): boolean {
  const v = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) return false;
  const r = v.slice(4) + v.slice(0, 4);
  let reste = 0;
  for (const c of r) {
    const n = c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c;
    for (const d of n) reste = (reste * 10 + Number(d)) % 97;
  }
  return reste === 1;
}

/** Forme masquée lisible d'un IBAN (mêmes 4 premiers et 4 derniers caractères que la fiche fournisseur). */
export function maskedIban(raw: string): string {
  const v = raw.replace(/\s+/g, '').toUpperCase();
  return v.length <= 8 ? `•••• ${v.slice(-2)}` : `${v.slice(0, 4)} •••• •••• ${v.slice(-4)}`;
}

/** Remplace chaque IBAN du texte par `remplacement(iban)` ; rend le texte et le nombre de remplacements. Pur. */
export function replaceIbansInText(text: string, remplacement: (iban: string) => string): { text: string; count: number } {
  let count = 0;
  let t = String(text ?? '').replace(IBAN_MAJ, (m) => { count += 1; return remplacement(m); });
  t = t.replace(IBAN_CI, (m) => {
    if (m === m.toUpperCase() || !ibanChecksumValid(m)) return m;
    count += 1;
    return remplacement(m);
  });
  return { text: t, count };
}

/** Texte conservé (fil de l'Assistant) : chaque IBAN remplacé par sa forme masquée lisible. Pur. */
export function maskIbansInText(text: string): { text: string; count: number } {
  return replaceIbansInText(text, maskedIban);
}

/** Un IBAN (forme reconnue par ce module) figure-t-il dans le texte ? Pur. */
export function containsIban(text: string): boolean {
  return replaceIbansInText(text, () => '').count > 0;
}
