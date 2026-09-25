/**
 * Champs d'un bien modifiables depuis l'assistant — liste FERMÉE, en code.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « METS DATE D'ACHAT LE 25/05/2021 POUR LA POLO »
 *
 * L'assistant répondait « Je ne peux pas encore réaliser cette action ».
 * Il propose désormais la modification, avec l'ancienne et la nouvelle
 * valeur, et ne l'exécute qu'après confirmation explicite — par le même
 * service que la fiche bien (asset-details-write.service), donc avec les
 * mêmes contrôles.
 *
 * Seuls les champs listés ici sont proposés : chacun a un libellé, une
 * section, un type et les familles de biens auxquelles il s'applique. Un
 * champ absent de la liste n'est jamais écrit depuis le chat — le modèle
 * n'intervient pas dans le choix du champ.
 * ══════════════════════════════════════════════════════════════════════════
 */

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

export const ASSISTANT_ASSET_FIELDS: AssetFieldDefinition[] = [
  {
    key: 'acquisitionDate', label: 'Date d’achat', type: 'date',
    sections: { IMMOBILIER: 'common', VEHICULE: 'common', OBJET: 'common' },
    aliases: ["date d'achat", "date d'acquisition", 'date achat', 'date acquisition', "achete le", "acquis le"],
  },
  {
    key: 'acquisitionPrice', label: 'Prix d’achat', type: 'number', unit: '€',
    sections: { IMMOBILIER: 'common', VEHICULE: 'common', OBJET: 'common' },
    aliases: ["prix d'achat", "prix d'acquisition", 'prix achat', "cout d'achat"],
  },
  {
    key: 'estimatedValue', label: 'Valeur estimée', type: 'number', unit: '€',
    sections: { IMMOBILIER: 'valuation', VEHICULE: 'valuation', OBJET: 'valuation' },
    aliases: ['valeur estimee', 'valeur actuelle', 'estimation', 'valeur'],
  },
  {
    key: 'nextInspection', label: 'Prochain contrôle technique', type: 'date',
    sections: { VEHICULE: 'vehicle_insurance' },
    aliases: ['prochain controle technique', 'date du controle technique', 'controle technique', 'prochain ct'],
  },
  {
    key: 'insuranceExpiry', label: 'Échéance de l’assurance', type: 'date',
    sections: { IMMOBILIER: 'insurance', VEHICULE: 'vehicle_insurance', OBJET: 'insurance' },
    aliases: ["echeance de l'assurance", "echeance d'assurance", "fin d'assurance", "date d'echeance de l'assurance"],
  },
  {
    key: 'insurer', label: 'Assureur', type: 'text',
    sections: { IMMOBILIER: 'insurance', VEHICULE: 'vehicle_insurance', OBJET: 'insurance' },
    aliases: ['assureur', 'compagnie d\'assurance'],
  },
  {
    key: 'mileage', label: 'Kilométrage', type: 'number', unit: 'km',
    sections: { VEHICULE: 'vehicle_usage' },
    aliases: ['kilometrage', 'compteur', 'nombre de kilometres'],
  },
  {
    key: 'registrationNumber', label: 'Immatriculation', type: 'text',
    sections: { VEHICULE: 'vehicle_identification' },
    aliases: ['immatriculation', "plaque d'immatriculation", 'plaque'],
  },
  {
    key: 'firstRegistrationDate', label: 'Date de première immatriculation', type: 'date',
    sections: { VEHICULE: 'vehicle_technical' },
    aliases: ['date de premiere immatriculation', 'premiere immatriculation', 'date de mise en circulation', 'mise en circulation'],
  },
];

export function familyOf(category: string): AssetFamily {
  return category === 'IMMOBILIER' || category === 'VEHICULE' ? category : 'OBJET';
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
