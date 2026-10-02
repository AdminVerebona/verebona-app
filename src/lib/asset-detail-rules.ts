/**
 * Règles de saisie des caractéristiques d'un bien — partagées par
 * l'interface (fiche bien), la route PATCH /details/[section] et les
 * commandes de l'assistant. Une seule définition : une valeur refusée à
 * l'écran l'est aussi par le serveur, et par le chat.
 *
 * Module pur (aucun import serveur) : lisible côté client.
 */

/** AAAA-MM-JJ du jour, à Paris — la date qui compte pour l'utilisateur. */
export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Champs datés : jour calendaire valide attendu. */
export const DATE_DETAIL_FIELDS = new Set([
  'acquisitionDate', 'estimatedValueDate', 'valuationDate', 'dpeDate', 'firstRegistrationDate',
  'mileageDate', 'insuranceExpiry', 'nextInspection', 'lastRevision',
  // CDC 15, D-E (lot 20) : dates du registre devenues modifiables sur la fiche.
  'dpeExpiryDate', 'maintenanceDueDate', 'lastInspectionDate', 'registrationExpiry',
  'contractStartDate', 'warrantyStartDate',
]);

/**
 * Champs qui annoncent une échéance à venir : une date passée n'a pas de
 * sens (« prochain contrôle technique : 18 avril 2020 »). Le jour même est
 * accepté.
 */
export const FUTURE_ONLY_DETAIL_FIELDS: Record<string, string> = {
  nextInspection: 'Le prochain contrôle technique ne peut pas être dans le passé.',
};

export interface DetailFieldError {
  field: string;
  message: string;
}

export function isValidDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const vide = (v: unknown) => v === null || v === undefined || v === '';

/**
 * Valide les valeurs MODIFIÉES d'une section.
 *
 * L'interface renvoie la section entière à l'enregistrement : une valeur
 * déjà en base (un contrôle technique passé saisi il y a deux ans) ne doit
 * pas empêcher d'enregistrer un autre champ. Seules les valeurs qui changent
 * sont contrôlées.
 */
export function validateDetailChanges(
  fields: Record<string, unknown>,
  previous: Record<string, unknown>,
  today: string = todayParis(),
): DetailFieldError[] {
  const errors: DetailFieldError[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (vide(value) || value === previous[key]) continue;
    if (DATE_DETAIL_FIELDS.has(key)) {
      const day = String(value).slice(0, 10);
      if (!isValidDay(day)) {
        errors.push({ field: key, message: 'Date invalide.' });
        continue;
      }
      if (FUTURE_ONLY_DETAIL_FIELDS[key] && day < today) {
        errors.push({ field: key, message: FUTURE_ONLY_DETAIL_FIELDS[key] });
      }
    }
  }
  return errors;
}

/**
 * Filtre des écritures automatiques (analyse de document, suggestions IA,
 * propagation) : une date passée pour un champ « à venir » est écartée
 * plutôt qu'enregistrée — un procès-verbal de contrôle technique de 2021
 * ne dit pas quand aura lieu le prochain.
 */
export function acceptDetailDate(key: string, day: string, today: string = todayParis()): string | null {
  return FUTURE_ONLY_DETAIL_FIELDS[key] && day < today ? null : day;
}

// ─── Fiche de l'équipement (CDC 15, D-D / D-N, lot 20) ──────────────────────

/**
 * Caractéristiques saisissables dans le tiroir d'un équipement — clés
 * canoniques du registre (cible EQUIPMENT). Écrites par PUT
 * /api/assets/[id]/equipments/[equipId] avec l'origine USER, comme le prix
 * d'achat et la valeur estimée (`recordManualEntityEdit`).
 */
export const EQUIPMENT_FICHE_FIELDS: ReadonlyArray<{ key: string; label: string; type: 'number' | 'text'; unit?: string; max?: number }> = [
  { key: 'powerKw', label: 'Puissance (kW)', type: 'number', unit: 'kW' },
  { key: 'cop', label: 'COP', type: 'number', max: 20 },
  { key: 'refrigerant', label: 'Fluide frigorigène', type: 'text' },
  { key: 'hourMeter', label: 'Compteur horaire (h)', type: 'number', unit: 'h' },
];

/**
 * Valide la fiche envoyée par le tiroir : clés connues seulement, nombre ≥ 0
 * (borne du registre pour le COP) ou texte, `null` / vide pour effacer.
 * Les clés absentes ne sont pas touchées.
 */
export function parseEquipmentFiche(input: unknown): { values: Record<string, number | string | null>; errors: DetailFieldError[] } {
  const values: Record<string, number | string | null> = {};
  const errors: DetailFieldError[] = [];
  if (input === undefined || input === null) return { values, errors };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { values, errors: [{ field: 'fiche', message: 'Fiche invalide.' }] };
  }
  const src = input as Record<string, unknown>;
  for (const f of EQUIPMENT_FICHE_FIELDS) {
    // Clé absente (ou `undefined`) : non touchée — jamais transformée en effacement.
    if (!(f.key in src) || src[f.key] === undefined) continue;
    const v = src[f.key];
    if (vide(v)) { values[f.key] = null; continue; }
    if (f.type === 'text') {
      const s = String(v).trim();
      values[f.key] = s === '' ? null : s.slice(0, 200);
      continue;
    }
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || (f.max !== undefined && n > f.max)) {
      errors.push({ field: f.key, message: `${f.label} : valeur invalide.` });
      continue;
    }
    values[f.key] = n;
  }
  return { values, errors };
}

/**
 * Clés de la fiche d'équipement RÉELLEMENT modifiées dans le tiroir, par
 * rapport à la fiche chargée. `undefined` (rien à envoyer) quand la fiche
 * n'a pas été chargée (GET en échec ou pas encore répondu) ou que rien n'a
 * changé : un formulaire vide ne doit jamais effacer des valeurs en USER.
 */
export function equipmentFicheChanges(
  loaded: Record<string, unknown> | null | undefined,
  form: Record<string, string | undefined>,
): Record<string, string | null> | undefined {
  if (!loaded) return undefined;
  const out: Record<string, string | null> = {};
  for (const f of EQUIPMENT_FICHE_FIELDS) {
    if (form[f.key] === undefined) continue;
    const saisi = String(form[f.key]).trim();
    const avant = loaded[f.key] === null || loaded[f.key] === undefined ? '' : String(loaded[f.key]).trim();
    if (saisi === avant) continue;
    if (f.type === 'number' && saisi !== '' && avant !== '' && Number(saisi.replace(',', '.')) === Number(avant)) continue;
    out[f.key] = saisi === '' ? null : saisi;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Valeur de formulaire comparable : vide → '', structure → JSON, sinon texte rogné. */
const comparable = (v: unknown): string =>
  vide(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).trim();

/**
 * Champs d'une section de la fiche RÉELLEMENT modifiés par rapport aux
 * valeurs affichées à l'ouverture de l'édition (lot 20) : seuls ceux-là sont
 * envoyés. Un champ non touché — même affiché vide parce que sa valeur vit
 * sous un alias ou une colonne miroir — n'est jamais renvoyé, donc jamais
 * effacé ni marqué USER.
 */
export function changedDetailFields(base: Record<string, unknown>, form: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) {
    if (comparable(v) !== comparable(base[k])) out[k] = v;
  }
  return out;
}
