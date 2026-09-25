/**
 * Formatage déterministe des réponses T2 — sans modèle.
 *
 * Une réponse exacte produite par le code doit être aussi utile qu'une
 * réponse rédigée : pas de « Voici ce que j'ai trouvé dans votre compte »
 * quand la valeur est connue. Ces fonctions couvrent les formes attendues :
 * valeur, date, montant, statut, compteur, liste, échéance, relation entre
 * objets, calcul simple, absence de résultat et conflit de valeurs.
 *
 * Toutes sont pures (la date du jour est un paramètre) : testables, et
 * identiques que l'IA soit disponible ou non.
 */

const TZ = 'Europe/Paris';

/** « 2026-11-14 » → « 14 novembre 2026 ». Chaîne vide si la date est invalide. */
export function formatDateFr(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
}

/** 489000 → « 4 890,00 € ». */
export function formatAmountCents(cents: number | null | undefined, currency = 'EUR'): string {
  if (cents == null || !Number.isFinite(cents)) return '';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100)
    .replace(/ /g, ' ');
}

/** Nombre au format français (« 1 250,5 »). */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(n).replace(/ /g, ' ');
}

/** Valeur + unité : « 24 kW », « 82 m² », « oui ». */
export function formatQuantity(value: string | number | null, unit?: string | null): string {
  if (value === null || value === undefined || value === '') return '';
  const v = typeof value === 'number' ? formatNumber(value) : String(value);
  return unit ? `${v} ${unit}` : v;
}

/** Nombre de jours calendaires entre aujourd'hui et une date (négatif si passée). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** « aujourd'hui », « demain », « dans 12 jours », « il y a 3 jours ». */
export function formatRelativeDays(days: number): string {
  if (days === 0) return 'aujourd’hui';
  if (days === 1) return 'demain';
  if (days === -1) return 'hier';
  if (days > 0) return `dans ${days} jours`;
  return `il y a ${-days} jours`;
}

type Kind = 'document' | 'échéance' | 'bien' | 'élément' | 'fait';
const PLURALS: Record<Kind, string> = {
  document: 'documents', échéance: 'échéances', bien: 'biens', élément: 'éléments', fait: 'informations',
};
const FEMININE: Record<Kind, boolean> = { document: false, échéance: true, bien: false, élément: false, fait: true };

/**
 * Compteur : « Vous avez 37 documents liés à cet appartement. »
 * `scope` complète la phrase (« liés à Appartement Lyon »).
 */
export function formatCount(kind: Kind, n: number, scope?: string): string {
  const suffix = scope ? ` ${scope}` : '';
  if (n === 0) return `Vous n’avez ${FEMININE[kind] ? 'aucune' : 'aucun'} ${kind}${suffix}.`;
  return `Vous avez ${formatNumber(n)} ${n > 1 ? PLURALS[kind] : kind}${suffix}.`;
}

/** Énumération française : « A », « A et B », « A, B et C ». */
export function joinFr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

/**
 * Liste : « Vous avez 3 biens mis en location : A, B et C. »
 * Au-delà de `max`, la liste est tronquée et le reste annoncé.
 */
export function formatList(intro: string, items: string[], max = 10): string {
  if (items.length === 0) return intro;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return `${intro} : ${joinFr(shown)}${rest > 0 ? `, et ${rest} autre${rest > 1 ? 's' : ''}` : ''}.`;
}

/** Échéance : « Votre assurance habitation arrive à échéance le 14 novembre 2026 (dans 50 jours). » */
export function formatDeadline(label: string, dateIso: string, todayIso: string): string {
  const days = daysBetween(todayIso, dateIso);
  const verbe = days < 0 ? 'est arrivé' : 'arrive';
  const sujet = /^(votre|le|la|les|l’|l')/i.test(label) ? label : `« ${label} »`;
  return `${capitalize(sujet)} ${verbe} à échéance le ${formatDateFr(dateIso)} (${formatRelativeDays(days)}).`;
}

/** Valeur d'un attribut : « La puissance de votre chaudière est de 24 kW. » */
export function formatAttributeValue(p: {
  subject?: string | null;
  attribute?: string | null;
  label?: string | null;
  value: string;
}): string {
  if (p.attribute && p.subject) {
    return `${capitalize(article(p.attribute))} de votre ${p.subject.toLowerCase()} est de ${p.value}.`;
  }
  const libelle = p.label ?? p.attribute ?? p.subject;
  return libelle ? `${capitalize(libelle)} : ${p.value}.` : `Valeur trouvée : ${p.value}.`;
}

/** Relation entre objets : « Ce document est rattaché à Maison Caen. » */
export function formatRelation(subject: string, relation: string, target: string): string {
  return `${capitalize(subject)} ${relation} ${target}.`;
}

/** Calcul simple : « Total des montants : 4 890,00 € (3 documents). » */
export function formatSum(label: string, cents: number, count: number): string {
  return `${capitalize(label)} : ${formatAmountCents(cents)} (${formatNumber(count)} document${count > 1 ? 's' : ''}).`;
}

/** Absence : « Je n’ai trouvé aucune échéance correspondant à ce bien. » */
export function formatNoResult(what: string, scope?: string): string {
  return `Je n’ai trouvé ${what}${scope ? ` ${scope}` : ''}.`;
}

/**
 * Conflit : jamais de choix arbitraire.
 * « J’ai trouvé deux valeurs différentes pour … : 14 novembre 2026 (Contrat A)
 *   et 30 novembre 2026 (Avenant B). Elles proviennent de sources différentes. »
 */
export function formatConflict(what: string, values: Array<{ value: string; source: string }>): string {
  const n = values.length;
  const nombre = n === 2 ? 'deux' : n === 3 ? 'trois' : String(n);
  const liste = joinFr(values.map((v) => `${v.value} (${v.source})`));
  return `J’ai trouvé ${nombre} valeurs différentes pour ${what} : ${liste}. Elles proviennent de sources différentes ; vérifiez laquelle est à jour.`;
}

/** Statut : « Statut : en service. » */
export function formatStatus(label: string, status: string): string {
  return `${capitalize(label)} : ${status}.`;
}

/** Noms masculins fréquents parmi les attributs extraits (article « le »). */
const MASCULINS = new Set([
  'numéro', 'numero', 'modèle', 'modele', 'montant', 'prix', 'type', 'niveau', 'nombre', 'code',
  'poids', 'volume', 'kilométrage', 'kilometrage', 'diamètre', 'diametre', 'débit', 'debit',
  'rendement', 'classement', 'coût', 'cout', 'loyer', 'délai', 'delai', 'fournisseur', 'propriétaire',
  'millésime', 'format', 'taux', 'nom', 'statut', 'titulaire', 'contrat', 'identifiant',
]);

function article(noun: string): string {
  const n = noun.trim().toLowerCase();
  if (/^[aeéèêiîoôuûh]/.test(n)) return `l’${n}`;
  return `${MASCULINS.has(n.split(/\s+/)[0]) ? 'le' : 'la'} ${n}`;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
