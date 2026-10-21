/**
 * CIL B6 — « Équipements à incidence énergétique » : UNE seule règle,
 * partagée par l'évaluation de complétude (`evaluateCilReadiness`, donc la
 * préparation et le blocage), le mappeur CIL et le PDF (lot 69, ticket
 * « diagnostics codés en dur », §3.3). Pure, sans accès base, utilisable
 * côté client.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DONNÉES STRUCTURÉES SEULEMENT — LE NOM LIBRE N'EST JAMAIS UN CRITÈRE
 *
 * Un équipement est dans le périmètre B6 si l'une de ses données
 * structurées le rattache à un usage énergétique du référentiel CIL — les
 * usages de `energy_works.category` (chauffage, refroidissement, ECS,
 * ventilation, EnR) et les rubriques `EQUIPEMENT_*` du référentiel des types
 * de document (`lib/document-type-constants.ts`) :
 *
 *   1. `category` : code d'usage (CHAUFFAGE, EQUIPEMENT_ECS, VMC…) ;
 *   2. `type` : type d'équipement du référentiel ci-dessous (chaudière,
 *      pompe à chaleur, VMC, chauffe-eau…), reconnu en TÊTE du champ
 *      (« Chaudière gaz à condensation ») — jamais par un mot trouvé au
 *      milieu d'un texte libre ;
 *   3. caractéristiques CIL saisies (`equipment_cil_specs`) propres aux
 *      équipements énergétiques : énergie utilisée, mode d'évacuation des
 *      fumées, sous-station de réseau de chaleur. La marque, le modèle, le
 *      numéro de série et la puissance — communs à tout équipement — ne
 *      comptent PAS.
 *
 *   0. (lot 70B, PRIORITAIRE) `energyUsage` : usage énergétique DÉCLARÉ
 *      dans le tiroir équipement (`equipments.energy_usage`, choix fermé).
 *      Un usage déclaré décide seul ; « Aucun usage énergétique » (`aucun`)
 *      EXCLUT l'équipement même si sa catégorie, son type ou ses
 *      caractéristiques CIL le suggèrent ; « Non renseigné » (NULL) laisse
 *      jouer les critères 1 à 3 ci-dessus.
 *
 * Le nom libre (« Chaudière », « TV salon ») n'est PAS lu : il ne suffirait
 * jamais seul (exigence du ticket), et un indice qui ne peut jamais suffire
 * seul n'ajoute rien dès qu'une donnée structurée suffit déjà. Un équipement
 * non classifiable n'est PAS énergétique : aucun repli « tous les
 * équipements » (l'ancienne règle reprenait la télévision ou le portail).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type CilEnergyUsage = 'chauffage' | 'refroidissement' | 'ecs' | 'ventilation' | 'enr';

/** Code « Aucun usage énergétique » de `equipments.energy_usage` (exclusion explicite). */
export const ENERGY_USAGE_NONE = 'aucun' as const;
/** Valeur persistée de `equipments.energy_usage` ; `null` = « Non renseigné ». */
export type EquipmentEnergyUsage = CilEnergyUsage | typeof ENERGY_USAGE_NONE;

/**
 * Choix FERMÉS du champ « Usage énergétique » du tiroir équipement (lot 70B),
 * dans l'ordre d'affichage : les usages du référentiel CIL (ceux de la règle
 * et de `energy_works.category`), puis l'exclusion explicite. « Non
 * renseigné » (valeur `null`) est proposé en tête par le tiroir.
 */
export const EQUIPMENT_ENERGY_USAGE_OPTIONS: ReadonlyArray<{ value: EquipmentEnergyUsage; label: string }> = [
  { value: 'chauffage', label: 'Chauffage' },
  { value: 'ecs', label: 'Eau chaude sanitaire' },
  { value: 'ventilation', label: 'Ventilation' },
  { value: 'refroidissement', label: 'Climatisation / rafraîchissement' },
  { value: 'enr', label: 'Production d’énergie (solaire…)' },
  { value: ENERGY_USAGE_NONE, label: 'Aucun usage énergétique' },
];
export const ENERGY_USAGE_UNSET_LABEL = 'Non renseigné';

const ENERGY_USAGE_VALUES: ReadonlySet<string> = new Set(EQUIPMENT_ENERGY_USAGE_OPTIONS.map((o) => o.value));

/** Valeur persistée reconnue, sinon `null` (non renseigné). Pure. */
export function normalizeEquipmentEnergyUsage(v: unknown): EquipmentEnergyUsage | null {
  return typeof v === 'string' && ENERGY_USAGE_VALUES.has(v) ? v as EquipmentEnergyUsage : null;
}

/**
 * Lecture d'un corps de requête : `undefined` (champ absent : inchangé),
 * `null` / `''` (non renseigné), un code fermé, ou `'INVALID'`.
 */
export function parseEquipmentEnergyUsage(v: unknown): EquipmentEnergyUsage | null | undefined | 'INVALID' {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return normalizeEquipmentEnergyUsage(v) ?? 'INVALID';
}

/**
 * `category` d'un corps de requête (routes POST / PUT des équipements) :
 * `undefined` (absente : inchangée), `null` (effacée), texte rogné (`''` →
 * `null`), ou `'INVALID'` (non textuel, plus de 100 caractères).
 */
export function parseEquipmentCategory(v: unknown): string | null | undefined | 'INVALID' {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 100) return 'INVALID';
  return v.trim() || null;
}

/** Libellé d'une valeur (« Non renseigné » pour `null`). */
export function equipmentEnergyUsageLabel(v: unknown): string {
  const code = normalizeEquipmentEnergyUsage(v);
  return EQUIPMENT_ENERGY_USAGE_OPTIONS.find((o) => o.value === code)?.label ?? ENERGY_USAGE_UNSET_LABEL;
}

/** Données structurées d'un équipement lues par la règle (colonnes `equipments` + `equipment_cil_specs`). */
export interface CilEnergyEquipmentInput {
  /** Lot 70B : usage déclaré (`equipments.energy_usage`) — prioritaire. */
  energyUsage?: string | null;
  type?: string | null;
  category?: string | null;
  energyType?: string | null;
  evacuationMode?: string | null;
  heatNetworkDeliveryStation?: string | null;
}

export interface CilEnergyClassification {
  /** Usage du référentiel CIL ; `null` : caractérisé énergétique sans usage précis (énergie saisie seule). */
  usage: CilEnergyUsage | null;
  /** Donnée structurée qui fonde la décision. */
  basis: 'energy_usage' | 'category' | 'type' | 'cil_specs';
}

const norm = (v: unknown): string => String(v ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Codes d'usage acceptés dans `category` (forme normalisée, égalité stricte). */
const CATEGORY_USAGES: Record<string, CilEnergyUsage> = {
  'chauffage': 'chauffage', 'equipement chauffage': 'chauffage', 'heating': 'chauffage',
  'refroidissement': 'refroidissement', 'equipement refroidissement': 'refroidissement', 'climatisation': 'refroidissement', 'cooling': 'refroidissement',
  'ecs': 'ecs', 'equipement ecs': 'ecs', 'eau chaude sanitaire': 'ecs', 'production ecs': 'ecs',
  'ventilation': 'ventilation', 'equipement ventilation': 'ventilation', 'vmc': 'ventilation',
  'enr': 'enr', 'energie renouvelable': 'enr', 'production enr': 'enr',
};

/**
 * Référentiel des TYPES d'équipement énergétique (forme normalisée). Un type
 * est reconnu s'il ÉGALE une entrée ou COMMENCE par elle suivie d'un espace
 * (« pompe a chaleur air eau »). Ce n'est pas une recherche de mots : « TV »,
 * « Portail », « Lave-linge » ou « Radiateur décoratif ancien » placé dans
 * le nom ne déclenchent rien ; seul le champ type, qui décrit la nature de
 * l'équipement, est lu.
 */
const TYPE_USAGES: ReadonlyArray<[string, CilEnergyUsage]> = [
  // Chauffage
  ['chauffage', 'chauffage'], ['chaudiere', 'chauffage'], ['pompe a chaleur', 'chauffage'], ['pac', 'chauffage'],
  ['radiateur', 'chauffage'], ['convecteur', 'chauffage'], ['plancher chauffant', 'chauffage'], ['poele', 'chauffage'],
  ['insert', 'chauffage'], ['foyer ferme', 'chauffage'], ['sous station', 'chauffage'], ['equipement chauffage', 'chauffage'],
  // Refroidissement
  ['climatisation', 'refroidissement'], ['climatiseur', 'refroidissement'], ['refroidissement', 'refroidissement'],
  ['equipement refroidissement', 'refroidissement'],
  // Eau chaude sanitaire
  ['ecs', 'ecs'], ['eau chaude sanitaire', 'ecs'], ['chauffe eau', 'ecs'], ['ballon d eau chaude', 'ecs'],
  ['ballon eau chaude', 'ecs'], ['cumulus', 'ecs'], ['equipement ecs', 'ecs'],
  // Ventilation
  ['ventilation', 'ventilation'], ['vmc', 'ventilation'], ['equipement ventilation', 'ventilation'],
  // Production d'énergie renouvelable
  ['panneau solaire', 'enr'], ['panneaux solaires', 'enr'], ['capteur solaire', 'enr'], ['capteurs solaires', 'enr'],
  ['photovoltaique', 'enr'], ['panneaux photovoltaiques', 'enr'], ['panneau photovoltaique', 'enr'], ['enr', 'enr'],
];

function usageFromType(type: unknown): CilEnergyUsage | null {
  const t = norm(type);
  if (!t) return null;
  for (const [entry, usage] of TYPE_USAGES) {
    if (t === entry || t.startsWith(`${entry} `)) return usage;
  }
  return null;
}

const filled = (v: unknown) => norm(v) !== '';

/**
 * Suggestion d'usage déduite du TYPE seul (référentiel ci-dessus, reconnu en
 * tête du champ) — proposée par le tiroir quand « Usage énergétique » est
 * non renseigné ; jamais enregistrée sans confirmation. `null` : aucune
 * suggestion sûre.
 */
export function suggestEnergyUsageFromType(type: unknown): CilEnergyUsage | null {
  return usageFromType(type);
}

/** Classification B6 d'un équipement ; `null` : hors périmètre (non classifiable compris). */
export function classifyCilEnergyEquipment(e: CilEnergyEquipmentInput): CilEnergyClassification | null {
  // Lot 70B : l'usage déclaré prime ; « aucun » exclut explicitement.
  const declared = normalizeEquipmentEnergyUsage(e.energyUsage);
  if (declared === ENERGY_USAGE_NONE) return null;
  if (declared) return { usage: declared, basis: 'energy_usage' };
  const byCategory = CATEGORY_USAGES[norm(e.category)];
  if (byCategory) return { usage: byCategory, basis: 'category' };
  const byType = usageFromType(e.type);
  if (byType) return { usage: byType, basis: 'type' };
  if (filled(e.heatNetworkDeliveryStation)) return { usage: 'chauffage', basis: 'cil_specs' };
  if (filled(e.energyType) || filled(e.evacuationMode)) return { usage: null, basis: 'cil_specs' };
  return null;
}

export function isCilEnergyEquipment(e: CilEnergyEquipmentInput): boolean {
  return classifyCilEnergyEquipment(e) !== null;
}

/**
 * Lot 75A — PERTINENCE du champ « Usage énergétique » dans le tiroir
 * équipement (consultation et formulaire). Ce n'est PAS la règle B6 :
 *
 *   · un choix explicite (y compris « Aucun usage énergétique ») est une
 *     donnée de l'utilisateur : toujours affiché et modifiable — une
 *     chaudière déclarée « aucun » est exclue de B6 (`isCilEnergyEquipment`
 *     faux) mais son choix reste visible ;
 *   · « Non renseigné » : visible seulement si les critères STRUCTURÉS de la
 *     règle B6 (catégorie, type du référentiel, caractéristiques CIL)
 *     reconnaissent un équipement énergétique — même référentiel, aucune
 *     seconde classification. Un aspirateur, un téléviseur ou un lave-linge
 *     ne l'affichent pas (un équipement électrique n'est pas pour autant à
 *     incidence énergétique au sens du CIL).
 *
 * Pure ; ne transforme jamais `null` en « aucun ».
 */
export function isEnergyUsageFieldRelevant(e: CilEnergyEquipmentInput): boolean {
  if (normalizeEquipmentEnergyUsage(e.energyUsage) !== null) return true;
  return classifyCilEnergyEquipment({ ...e, energyUsage: null }) !== null;
}

/** Équipements du périmètre B6, dans l'ordre reçu. Jamais de repli sur la liste complète. */
export function cilEnergyEquipments<T extends CilEnergyEquipmentInput>(list: readonly T[]): T[] {
  return list.filter(isCilEnergyEquipment);
}
