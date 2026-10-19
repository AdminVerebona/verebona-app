/**
 * Fin de contrat PRÉVUE (lot 49A, ticket 9 ; lot 53, retour PO D18) — pur,
 * partagé par la route GET /api/assets/[id]/details et la fiche (client).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FIN CONTRACTUELLE ≠ FIN RÉELLE DE DÉTENTION (D18)
 *
 * La date affichée ici est l'échéance PRÉVUE d'un contrat (LLD / LOA, bail,
 * prêt, location) : une fin contractuelle prévisionnelle, jamais une cession
 * ni une restitution constatée. La fin RÉELLE de détention d'un bien est un
 * fait distinct (vente / cession datée : statut « Vendu » et sa date, lot
 * 43) ; elle n'est jamais déduite d'une fin de contrat. Aucune date n'est
 * proposée pour un bien acheté (détention sans échéance contractuelle) : la
 * section ne montre alors aucun champ — jamais de date inventée.
 * Origine toujours dite : « Calculée » (début + durée), « Extraite d'un
 * document », « Déclarée » (saisie de l'utilisateur).
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN NOUVEAU CHAMP : deux clés canoniques EXISTANTES sont réutilisées,
 * celle que produit déjà la projection documentaire T1 pour la situation
 * (alias contextuel `dateFinContrat`, décision PO D-C, lot 20) — la valeur
 * d'un document, la saisie et l'échéance d'agenda portent donc la MÊME clé :
 *
 *   leaseEndDate     « Fin de bail / location » (IMMOBILIER, VEHICULE) :
 *                    véhicule en LLD / LOA, logement occupé en LOCATAIRE ;
 *                    un contrat LLD / LOA / bail analysé par T1 l'alimente ;
 *   contractEndDate  « Fin de contrat » (toutes familles) : véhicule prêté
 *                    (PRET_GRATUIT), occupant à titre gratuit, objet loué /
 *                    prêté (mode d'acquisition) ; un contrat non locatif
 *                    analysé par T1 l'alimente.
 *
 * Visible SEULEMENT pour une détention à durée limitée. Valeur affichée :
 *   1. saisie de l'utilisateur (origine humaine) — elle prime toujours ;
 *   2. sinon valeur trouvée dans les documents (origine automatique) ;
 *   3. sinon CALCULÉE : début de contrat + durée (mois) − 1 jour (convention
 *      « du 20/03/2024 au 19/03/2027 » pour 36 mois), affichée comme
 *      calculée et modifiable — non enregistrée tant qu'elle n'est pas
 *      modifiée (une modification devient une saisie utilisateur).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Libellé (D18) : fin CONTRACTUELLE prévue — jamais « fin de détention ». */
export const TENURE_END_LABEL = 'Fin de contrat prévue';

export type TenureEndKey = 'leaseEndDate' | 'contractEndDate';
export type TenureEndSource = 'user' | 'document' | 'computed';
export type TenureFamily = 'IMMOBILIER' | 'VEHICULE' | 'OBJET';

/** Métadonnée jointe aux données de la section (jamais renvoyée à l'écriture). */
export const TENURE_META_KEY = '__tenureEnd';
export interface TenureEndMeta {
  key: TenureEndKey | null;
  source: TenureEndSource | null;
}

const VEHICLE_LEASE = new Set(['LLD', 'LOA']);
const VEHICLE_LOAN = new Set(['PRET_GRATUIT']);
const HOUSING_LEASE = new Set(['LOCATAIRE']);
const HOUSING_LOAN = new Set(['OCCUPANT_GRATUIT']);
/** Mode d'acquisition d'un objet (texte libre) qui dit une détention à durée limitée. */
const OBJECT_LIMITED = /\b(location|loue|louee|loues|louees|leasing|loa|lld|pret|prete|pretee|emprunt|emprunte|empruntee|abonnement)\b/;
const plain = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Clé canonique de la date de fin pour cette situation ; `null` : détention non limitée. */
export function tenureEndKey(family: string, data: Record<string, unknown>): TenureEndKey | null {
  if (family === 'VEHICULE') {
    const s = String(data.vehicleOwnershipStatus ?? '');
    if (VEHICLE_LEASE.has(s)) return 'leaseEndDate';
    if (VEHICLE_LOAN.has(s)) return 'contractEndDate';
    return null;
  }
  if (family === 'IMMOBILIER') {
    const s = String(data.occupancyStatus ?? '');
    if (HOUSING_LEASE.has(s)) return 'leaseEndDate';
    if (HOUSING_LOAN.has(s)) return 'contractEndDate';
    return null;
  }
  return OBJECT_LIMITED.test(plain(data.acquisitionMode)) ? 'contractEndDate' : null;
}

/**
 * Pourquoi une date de fin de contrat ne s'applique pas au bien (lot 69) :
 * le champ de SITUATION de sa famille (statut de détention du véhicule,
 * statut d'occupation du logement, mode d'acquisition de l'objet) est-il
 * vide — « à compléter » — ou renseigné avec une situation sans cette
 * échéance ? Avant : « statut de détention ou d'occupation à compléter »
 * pour tout bien, même renseigné.
 */
export function tenureSituationHint(family: string, data: Record<string, unknown>): string {
  const champ = family === 'VEHICULE' ? { key: 'vehicleOwnershipStatus', label: 'statut de détention' }
    : family === 'IMMOBILIER' ? { key: 'occupancyStatus', label: 'statut d’occupation' }
      : { key: 'acquisitionMode', label: 'mode d’acquisition' };
  const v = data[champ.key];
  const vide = v === undefined || v === null || String(v).trim() === '';
  return vide
    ? `${champ.label} à compléter sur la fiche`
    : `d’après le ${champ.label} renseigné sur la fiche`;
}

export function isLimitedTenure(family: string, data: Record<string, unknown>): boolean {
  return tenureEndKey(family, data) !== null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Fin d'un contrat de `months` mois commençant le `start` (ISO) : même jour
 * N mois plus tard (jour borné à la fin du mois), moins un jour. `null` si
 * une donnée manque ou est invalide.
 */
export function computeTenureEnd(start: unknown, months: unknown): string | null {
  const m = typeof start === 'string' ? ISO_DATE.exec(start) : null;
  const n = typeof months === 'number' ? months : typeof months === 'string' && months.trim() !== '' ? Number(months) : NaN;
  if (!m || !Number.isInteger(n) || n <= 0 || n > 1200) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const targetMonth = mo + n;
  const ty = y + Math.floor(targetMonth / 12);
  const tm = targetMonth % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(ty, tm, Math.min(d, lastDay)));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

const filled = (v: unknown) => v !== null && v !== undefined && v !== '';

/**
 * Valeur affichée et provenance. `origin` : origine structurée de la valeur
 * enregistrée (`USER` / `ADMIN` = saisie humaine ; autre = document).
 */
export function resolveTenureEnd(input: { stored: unknown; origin: string | null; start: unknown; months: unknown }): { value: string | null; source: TenureEndSource | null } {
  if (filled(input.stored)) {
    const human = input.origin === 'USER' || input.origin === 'ADMIN';
    return { value: String(input.stored), source: human ? 'user' : 'document' };
  }
  const computed = computeTenureEnd(input.start, input.months);
  return computed ? { value: computed, source: 'computed' } : { value: null, source: null };
}

/** Libellé de provenance affiché à côté du champ (D18 : calculée, extraite, déclarée). */
export function tenureSourceLabel(source: TenureEndSource | null | undefined): string | null {
  if (source === 'computed') return 'Calculée (début + durée)';
  if (source === 'document') return 'Extraite d’un document';
  if (source === 'user') return 'Déclarée';
  return null;
}

/**
 * Champs de la section « usage » (route GET /details) : les DEUX clés
 * existantes ; celle de la situation reçoit la valeur affichée et sa
 * provenance (`__tenureEnd`). `originOf` : lecture de l'origine structurée
 * (`readOrigin`, injectée par le serveur).
 */
export function tenureEndSectionFields(
  family: string,
  kc: Record<string, unknown>,
  context: Record<string, unknown>,
  originOf: (kc: Record<string, unknown>, key: string) => string,
): Record<string, unknown> {
  const key = tenureEndKey(family, context);
  // `leaseEndDate` ne s'applique pas aux objets (registre : IMMOBILIER, VEHICULE).
  const out: Record<string, unknown> = family === 'OBJET'
    ? { contractEndDate: kc.contractEndDate ?? null }
    : { leaseEndDate: kc.leaseEndDate ?? null, contractEndDate: kc.contractEndDate ?? null };
  let meta: TenureEndMeta = { key, source: null };
  if (key) {
    const r = resolveTenureEnd({ stored: kc[key], origin: filled(kc[key]) ? originOf(kc, key) : null, start: kc.contractStartDate, months: kc.leaseDurationMonths });
    out[key] = r.value;
    meta = { key, source: r.source };
  }
  out[TENURE_META_KEY] = meta;
  return out;
}
