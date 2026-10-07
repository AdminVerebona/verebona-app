/**
 * Champs d'un bien modifiables depuis l'assistant — VUE DU REGISTRE
 * CANONIQUE (CDC 15 T2-39, T2-40 ; lot 15).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « METS DATE D'ACHAT LE 25/05/2021 POUR LA POLO »
 *
 * L'assistant propose la modification, avec l'ancienne et la nouvelle
 * valeur, et ne l'exécute qu'après confirmation explicite — par le même
 * service que la fiche bien (asset-details-write.service), origine USER.
 *
 * La liste n'est plus maintenue ici : ce sont les champs du registre
 * `assistantWritable: true`, avec leur libellé, leur type, leurs familles et
 * leurs formulations (`assistantPhrases`). Un champ absent du registre, ou
 * non modifiable par l'assistant, n'est jamais écrit depuis le chat — le
 * modèle n'intervient pas dans le choix du champ. La LECTURE passe par le
 * même registre (`canonical/field-reader`, `assistantReadable`) : T2 ne sait
 * jamais modifier un champ qu'il ne sait pas lire (T2-40).
 *
 * Seule information propre à l'assistant : la section de la fiche par
 * famille quand elle diffère de la section du registre (fiche véhicule :
 * « Assurance » dans `vehicle_insurance`). Parité vérifiée par un test.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { toAssetFamilyCode } from '@/lib/asset-taxonomy';
import { CANONICAL_FIELDS, type CanonicalFieldDef } from '@/services/canonical/registry';

export type AssetFamily = 'IMMOBILIER' | 'VEHICULE' | 'OBJET';

export interface AssetFieldDefinition {
  key: string;
  label: string;
  /** Section de la fiche : celle qui s'applique à la famille du bien. */
  sections: Partial<Record<AssetFamily, string>>;
  type: 'date' | 'number' | 'text';
  /** Formes reconnues dans le message, sans accents, en minuscules. */
  aliases: string[];
  unit?: string;
}

/** Section de la fiche par famille quand elle diffère de celle du registre. */
const SECTION_OVERRIDES: Readonly<Record<string, Partial<Record<AssetFamily, string>>>> = {
  insurer: { VEHICULE: 'vehicle_insurance' },
  insuranceExpiry: { VEHICULE: 'vehicle_insurance' },
};

const FAMILLE_ASSISTANT: Readonly<Record<string, AssetFamily>> = { IMMOBILIER: 'IMMOBILIER', VEHICULE: 'VEHICULE', OBJECT: 'OBJET' };

/** Définition assistant d'un champ du registre (pure, testée). */
export function assistantFieldOf(d: CanonicalFieldDef): AssetFieldDefinition {
  const sections: Partial<Record<AssetFamily, string>> = {};
  for (const f of d.families) {
    const fam = FAMILLE_ASSISTANT[f];
    if (fam) sections[fam] = SECTION_OVERRIDES[d.key]?.[fam] ?? d.section ?? 'common';
  }
  const type: AssetFieldDefinition['type'] = d.valueType === 'date' ? 'date'
    : d.valueType === 'number' || d.valueType === 'money_eur' || d.valueType === 'money_cents' ? 'number' : 'text';
  const unit = d.valueType === 'money_eur' || d.unit === 'EUR' ? '€' : d.unit;
  return {
    key: d.key, label: d.label, sections, type, aliases: [...(d.assistantPhrases ?? [])],
    ...(unit ? { unit } : {}),
  };
}

/**
 * Ordre EXACT de l'ancienne liste (tag lot14b), restauré à la relecture du
 * lot 15 : il départage deux alias de même longueur dans `findAssetField`
 * (le premier champ de la liste gagne — ex. « kilométrage » et
 * « prochain ct », 11 caractères chacun → prochain contrôle technique).
 * Un champ ajouté au registre sans figurer ici vient après, dans l'ordre du
 * registre.
 */
export const ASSISTANT_FIELD_ORDER: readonly string[] = [
  'acquisitionDate', 'acquisitionPrice', 'estimatedValue', 'nextInspection', 'insuranceExpiry',
  'insurer', 'mileage', 'registrationNumber', 'firstRegistrationDate',
];

const rang = (key: string) => {
  const i = ASSISTANT_FIELD_ORDER.indexOf(key);
  return i < 0 ? ASSISTANT_FIELD_ORDER.length : i;
};

/** Champs modifiables depuis l'assistant : registre, `assistantWritable`, ordre historique. */
export const ASSISTANT_ASSET_FIELDS: AssetFieldDefinition[] = CANONICAL_FIELDS
  .filter((d) => d.assistantWritable && d.assistantReadable)
  .map((d, i) => ({ d, i }))
  .sort((a, b) => rang(a.d.key) - rang(b.d.key) || a.i - b.i)
  .map(({ d }) => assistantFieldOf(d));

export function familyOf(category: string): AssetFamily {
  // Résolveur unique des familles (lot 30) : inconnue → objet, comme avant.
  return FAMILLE_ASSISTANT[toAssetFamilyCode(category) ?? 'OBJECT'];
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

/** Champ désigné par le message : l'alias le plus long gagne (« prochain contrôle technique » avant « valeur »). */
export function findAssetField(message: string): { def: AssetFieldDefinition; alias: string; index: number } | null {
  const m = plain(message);
  let best: { def: AssetFieldDefinition; alias: string; index: number } | null = null;
  for (const def of ASSISTANT_ASSET_FIELDS) {
    for (const alias of def.aliases) {
      const re = new RegExp(`(^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`);
      const hit = re.exec(m);
      if (hit && (!best || alias.length > best.alias.length)) {
        best = { def, alias, index: hit.index + hit[1].length };
      }
    }
  }
  return best;
}

/** « 12 500,50 € », « 12500 km », « 45 000 » → nombre. */
export function parseNumberFr(text: string): number | null {
  const m = plain(text).match(/(\d{1,3}(?:[  .]\d{3})+|\d+)(?:,(\d+))?\s*(km|k€|k(?![a-z])|€|euros?|eur)?/);
  if (!m) return null;
  const entier = m[1].replace(/[  .]/g, '');
  let n = Number(`${entier}${m[2] ? `.${m[2]}` : ''}`);
  if (!Number.isFinite(n)) return null;
  if (m[3] === 'k' || m[3] === 'k€') n *= 1000;
  return n;
}

/**
 * Valeur saisie, lue dans le texte qui suit le champ.
 * Une date sans année n'est pas acceptée pour un champ du passé : « le
 * 25 mai » serait projeté sur l'année prochaine.
 */
export function parseFieldValue(
  def: AssetFieldDefinition,
  after: string,
  today: string,
  parseDate: (text: string, today: string) => string | null,
): string | number | null {
  const t = plain(after);
  if (def.type === 'date') {
    const avecAnnee = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}(?:er)?\s+[a-z]+\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(t);
    const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso) return iso[1];
    if (!avecAnnee && def.key !== 'nextInspection' && def.key !== 'insuranceExpiry') return null;
    return parseDate(t, today);
  }
  if (def.type === 'number') {
    // Sans la date éventuelle (« au 12/03/2024 ») qui fournirait un faux nombre.
    const sansDate = t.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ');
    // Le nombre introduit par « à / au / : / de / est » d'abord : celui du nom
    // du bien (« la Polo 2019 », « la 208 ») n'est pas la valeur.
    const introduit = sansDate.match(/(?:^|\s)(?:a|au|:|=|->|de|est|vaut|en)\s+(\d[\d \u00a0.,]*(?:\s*(?:km|k€|k(?![a-z])|€|euros?|eur))?)/);
    return parseNumberFr(introduit ? introduit[1] : sansDate);
  }
  // Texte : ce qui suit « à / en / : / par », jusqu'au bien — que le bien
  // soit nommé avant (« l'assureur de la Polo en MAIF ») ou après
  // (« l'assureur à MAIF pour la Polo »).
  const liaison = /(?:^|\s)(?:a|à|au|en|par|est|:|=|->|comme)\s+/i.exec(after);
  const brut = (liaison ? after.slice(liaison.index + liaison[0].length) : after)
    .split(/\s+(?:pour|de la|du|de ma|de mon|sur|de l['’])\s+/i)[0]
    .replace(/^["«“\s]+|["»”\s.!?]+$/g, '')
    .trim();
  return brut.length >= 2 && brut.length <= 80 ? brut : null;
}

export function formatFieldValue(def: AssetFieldDefinition, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'non renseigné';
  if (def.type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, d)));
  }
  if (def.type === 'number' && typeof value === 'number') {
    return `${new Intl.NumberFormat('fr-FR').format(value)}${def.unit ? ` ${def.unit}` : ''}`;
  }
  return String(value);
}
