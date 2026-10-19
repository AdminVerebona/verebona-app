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
 * Le nom libre (« Chaudière », « TV salon ») n'est PAS lu : il ne suffirait
 * jamais seul (exigence du ticket), et un indice qui ne peut jamais suffire
 * seul n'ajoute rien dès qu'une donnée structurée suffit déjà. Un équipement
 * non classifiable n'est PAS énergétique : aucun repli « tous les
 * équipements » (l'ancienne règle reprenait la télévision ou le portail).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type CilEnergyUsage = 'chauffage' | 'refroidissement' | 'ecs' | 'ventilation' | 'enr';

/** Données structurées d'un équipement lues par la règle (colonnes `equipments` + `equipment_cil_specs`). */
export interface CilEnergyEquipmentInput {
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
  basis: 'category' | 'type' | 'cil_specs';
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

/** Classification B6 d'un équipement ; `null` : hors périmètre (non classifiable compris). */
export function classifyCilEnergyEquipment(e: CilEnergyEquipmentInput): CilEnergyClassification | null {
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

/** Équipements du périmètre B6, dans l'ordre reçu. Jamais de repli sur la liste complète. */
export function cilEnergyEquipments<T extends CilEnergyEquipmentInput>(list: readonly T[]): T[] {
  return list.filter(isCilEnergyEquipment);
}
