/**
 * Adresse IP réelle du client derrière le routeur Scalingo — lot 37 (C4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI PAS « LA PREMIÈRE VALEUR DE X-FORWARDED-FOR »
 *
 * L'ancien `getClientIp` lisait `x-real-ip`, puis la PREMIÈRE valeur de
 * `x-forwarded-for`. Ces deux valeurs peuvent être fournies par le client :
 * un attaquant changeait d'« adresse » à chaque requête et le limiteur de
 * tentatives par IP ne le voyait jamais deux fois.
 *
 * Le routeur Scalingo (comme tout mandataire conforme) AJOUTE à droite de
 * `x-forwarded-for` l'adresse qu'il voit réellement. Ce que le client a pu
 * écrire se trouve donc à gauche. On lit la liste DE DROITE À GAUCHE en
 * sautant les adresses privées / internes (sauts de l'infrastructure : un
 * éventuel répartiteur interne en 10.x) : la première adresse publique est
 * celle que le premier mandataire de confiance a vue. Sans adresse publique
 * (développement local, réseau privé), la dernière valeur est retenue.
 *
 * Sans `x-forwarded-for` : `next start` le renseigne lui-même avec
 * l'adresse de la socket (s'il est absent) ; à défaut, `x-real-ip`, puis
 * `unknown`.
 *
 * Module sans dépendance Node : utilisable dans le middleware Edge.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Adresse privée, de bouclage, lien-local ou réservée (saut d'infrastructure). */
export function isInternalAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (!v) return true;
  const v4 = v.startsWith('::ffff:') ? v.slice(7) : v;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127); // CGNAT / réseaux d'opérateur internes
  }
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
  if (v.startsWith('fe80')) return true; // lien-local
  return false;
}

/** Nettoie une entrée (`[::1]:443`, `1.2.3.4:5678`, guillemets). */
function cleanEntry(raw: string): string {
  let v = raw.trim().replace(/^"|"$/g, '');
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end > 0 ? v.slice(1, end) : v;
  }
  // IPv4 avec port
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (m) v = m[1];
  return v;
}

/**
 * IP du client à partir des en-têtes. Lecture de droite à gauche de
 * `x-forwarded-for` (voir l'en-tête du module).
 */
export function getClientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const entries = xff.split(',').map(cleanEntry).filter(Boolean);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!isInternalAddress(entries[i])) return entries[i];
    }
    if (entries.length > 0) return entries[entries.length - 1];
  }
  const real = headers.get('x-real-ip');
  if (real && real.trim()) return cleanEntry(real);
  return 'unknown';
}
