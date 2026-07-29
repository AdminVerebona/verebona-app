/**
 * Matrice d'autorité des sources — CDC §4.2.7.
 *
 * « Une matrice de priorité doit être définie par champ. La matrice doit être
 *   versionnée et testable. Elle ne doit pas être entièrement déléguée au LLM. »
 *
 * ⚠️ CE FICHIER EST EN ATTENTE DE VALIDATION MÉTIER (question 4 du document
 * `03-QUESTIONS-RESPONSABLE-METIER.md`). Les cinq ordres explicitement cités
 * par le CDC sont implémentés ; les autres champs suivent l'autorité de base du
 * type de document. Ajuster ce fichier ne demande aucune modification du moteur.
 */
import { computeAuthorityScore } from '../../evidence/authority-score';

export const AUTHORITY_MATRIX_VERSION = 'v1-2026-07-draft';

/**
 * Ordres de priorité explicites du §4.2.7, du plus autoritaire au moins.
 * Un type absent de la liste retombe sur l'autorité de base du document.
 */
/**
 * ⚠️ NE PAS CONFONDRE avec `CRITICAL_ALLOWED_TYPES` plus bas. Deux notions
 * distinctes, qui portent sur des champs différents :
 *
 *   • ORDRE D'AUTORITÉ (ici) — « lequel de ces documents a raison ? »
 *     S'applique à tout champ, critique ou non. Validé par le métier le
 *     28/07/2026, question 4.
 *
 *   • TYPES AUTORISÉS (plus bas) — « ce document a-t-il le droit d'écrire seul
 *     dans ce champ sensible ? » Ne concerne que les champs critiques.
 *
 * La prime d'assurance et la date de fin de garantie ont quitté la liste des
 * champs critiques, mais conservent leur ordre d'autorité : Verebona sait
 * toujours quel document croire, il n'a simplement plus besoin de demander.
 */
const FIELD_AUTHORITY_ORDER: Record<string, string[]> = {
  // prix d'achat immobilier : acte > compromis > saisie manuelle > autre
  acquisitionPrice: ['ACTE_AUTHENTIQUE', 'ACTE_NOTARIE', 'COMPROMIS_VENTE', 'FACTURE'],

  // immatriculation : certificat > assurance > facture d'entretien
  registrationNumber: ['CERTIFICAT_IMMATRICULATION', 'CARTE_GRISE', 'CONTRAT_ASSURANCE', 'RAPPORT_ENTRETIEN', 'FACTURE'],

  // prime d'assurance : avis d'échéance le plus récent > contrat initial
  insurancePremium: ['AVIS_ECHEANCE', 'CONTRAT_ASSURANCE'],

  // fin de garantie : certificat > facture avec durée explicite > estimation
  warrantyEndDate: ['CERTIFICAT_GARANTIE', 'FACTURE', 'BON_COMMANDE'],

  // surface : acte ou mesurage légal > DPE > annonce commerciale
  livingArea: ['ACTE_AUTHENTIQUE', 'ACTE_NOTARIE', 'MESURAGE_LEGAL', 'DPE', 'DIAGNOSTIC', 'ANNONCE_COMMERCIALE'],
};

/**
 * Champs pour lesquels la RÉCENCE prime sur le type de document.
 *
 * Décision métier du 28/07/2026 sur les coordonnées bancaires : « mettre à jour
 * cette information lorsqu'un document plus récent indique une nouvelle
 * information ». Tous les types de documents reçoivent donc la même autorité,
 * ce qui fait de la date le seul critère de départage (§4.2.8, étape 4). À date
 * égale, la divergence produit un arbitrage utilisateur — « en cas de doute, ça
 * va dans à traiter ».
 */
const RECENCY_DOMINANT_FIELDS = new Set<string>(['iban', 'bic', 'accountNumber']);

/** Autorité neutre attribuée aux champs pilotés par la récence. */
const NEUTRAL_AUTHORITY = 500;

/** Champs partageant l'ordre d'un autre champ (mêmes règles métier). */
const FIELD_ALIASES: Record<string, string> = {
  landArea: 'livingArea',
  vin: 'registrationNumber',
  serialNumber: 'registrationNumber',
  estimatedValue: 'acquisitionPrice',
};

/**
 * Écart entre deux rangs consécutifs d'un ordre explicite.
 *
 * ⚠️ INVARIANT CRITIQUE : cet écart doit rester STRICTEMENT SUPÉRIEUR à
 * `AUTHORITY_EQUIVALENCE_MARGIN` (confidence.ts). Dans le cas contraire, deux
 * types de documents que le CDC §4.2.7 ordonne explicitement — acte notarié et
 * compromis de vente, par exemple — seraient traités comme équivalents, et une
 * divergence entre eux produirait un arbitrage utilisateur au lieu d'être
 * tranchée par la règle métier. Un test garde cet invariant.
 */
const EXPLICIT_RANK_STEP = 50;

/** Socle des scores issus d'une règle explicite, hors d'atteinte de l'autorité de base. */
const EXPLICIT_RULE_BASE = 1000;

export interface AuthorityInput {
  fieldKey: string;
  documentType: string | null;
  isWebLink?: boolean;
}

export interface AuthorityRule {
  /** Score final, 0-1000. Un ordre explicite domine toujours l'autorité de base. */
  score: number;
  /** Identifiant de la règle appliquée, tracé dans l'historique et les conflits. */
  rule: string;
}

/**
 * Score d'autorité d'une preuve pour un champ donné.
 *
 * Deux étages : si le champ dispose d'un ordre explicite et que le type de
 * document y figure, le score est dominant (1000 et décroissant). Sinon, on
 * retombe sur l'autorité de base du type de document (0-100). Cette séparation
 * garantit qu'une règle métier explicite ne peut jamais être renversée par un
 * ajustement de l'autorité de base.
 */
export function resolveAuthority(input: AuthorityInput): AuthorityRule {
  const canonicalField = FIELD_ALIASES[input.fieldKey] ?? input.fieldKey;
  const docType = (input.documentType ?? 'AUTRE').toUpperCase();

  // Récence dominante : autorité identique pour tous les types, la date tranche.
  if (RECENCY_DOMINANT_FIELDS.has(canonicalField)) {
    return {
      score: NEUTRAL_AUTHORITY,
      rule: `${AUTHORITY_MATRIX_VERSION}:recency:${canonicalField}`,
    };
  }

  const order = FIELD_AUTHORITY_ORDER[canonicalField];

  if (order) {
    const rank = order.indexOf(docType);
    if (rank >= 0) {
      return {
        score: EXPLICIT_RULE_BASE - rank * EXPLICIT_RANK_STEP,
        rule: `${AUTHORITY_MATRIX_VERSION}:${canonicalField}#${rank}`,
      };
    }
  }

  return {
    score: computeAuthorityScore({ documentType: docType, isWebLink: input.isWebLink }),
    rule: `${AUTHORITY_MATRIX_VERSION}:base:${docType}`,
  };
}

/** Types de documents faisant autorité pour un champ critique (§4.2.6). */
const ADDRESS_AUTHORITY = ['ACTE_AUTHENTIQUE', 'ACTE_NOTARIE', 'COMPROMIS_VENTE', 'CONTRAT_ASSURANCE'];

const CRITICAL_ALLOWED_TYPES: Record<string, string[]> = {
  // Liste restreinte aux trois familles retenues par le métier le 28/07/2026 :
  // adresse du bien, plaque d'immatriculation, prix d'achat.
  //
  // ⚠️ CORRECTIF LOT 3. Seul `address1` figurait ici, alors que `CRITICAL_FIELDS`
  // compte quatre clés d'adresse. Or `isAuthorizedForCriticalField` refuse par
  // défaut : le code postal, la ville et le complément d'adresse ne pouvaient
  // donc JAMAIS être corrigés automatiquement, par aucun type de document.
  // Chaque correction d'adresse serait partie en arbitrage, indéfiniment.
  //
  // Les quatre clés forment une seule information métier — « l'adresse du
  // bien » de la question 3 — et partagent donc la même autorité.
  // L'invariant est désormais tenu par un test : tout champ critique doit
  // avoir une liste explicite.
  address1: ADDRESS_AUTHORITY,
  address2: ADDRESS_AUTHORITY,
  postalCode: ADDRESS_AUTHORITY,
  city: ADDRESS_AUTHORITY,
  registrationNumber: ['CERTIFICAT_IMMATRICULATION', 'CARTE_GRISE'],
  acquisitionPrice: ['ACTE_AUTHENTIQUE', 'ACTE_NOTARIE', 'COMPROMIS_VENTE', 'FACTURE'],
};

/** Première des quatre conditions cumulatives du §4.2.6. */
export function isAuthorizedForCriticalField(fieldKey: string, documentType: string | null): boolean {
  const allowed = CRITICAL_ALLOWED_TYPES[fieldKey];
  // Champ critique sans liste explicite : aucun type n'est autorisé à écrire
  // automatiquement. Le silence vaut refus, jamais autorisation.
  if (!allowed) return false;
  return allowed.includes((documentType ?? '').toUpperCase());
}

/** Expose la matrice pour les tests et l'administration. */
export function getAuthorityMatrix(): {
  version: string;
  rankStep: number;
  recencyDominantFields: string[];
  fieldOrders: Readonly<Record<string, string[]>>;
  criticalAllowedTypes: Readonly<Record<string, string[]>>;
} {
  return {
    version: AUTHORITY_MATRIX_VERSION,
    rankStep: EXPLICIT_RANK_STEP,
    recencyDominantFields: [...RECENCY_DOMINANT_FIELDS],
    fieldOrders: FIELD_AUTHORITY_ORDER,
    criticalAllowedTypes: CRITICAL_ALLOWED_TYPES,
  };
}
