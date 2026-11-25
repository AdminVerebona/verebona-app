/**
 * Carte #807 — MODIFICATIONS À PLUSIEURS CHAMPS depuis l'Assistant (écarts E01 à E04, E07).
 *
 *   E01  UPDATE_EQUIPMENT   modifier un équipement avec la même couverture que sa fiche (W05) ;
 *   E02  CREATE_EQUIPMENT   informations fournies à la création (W04) ;
 *   E03  UPDATE_AGENDA_ITEM champs du tiroir de l'Agenda (W16) ;
 *   E04  UPDATE_SUPPLIER    adresse, SIREN, SIRET, TVA, coordonnées bancaires MASQUÉES (W19).
 *
 * Même parcours que toutes les commandes : état LU dans le compte, avant / après annoncés, plan figé,
 * confirmation, puis écriture par la FAÇADE MÉTIER de l'écran correspondant. Rien n'est écrit ici en SQL.
 *
 * E07 — chaque action figée porte CE QUE L'UTILISATEUR A DEMANDÉ (`requested`), indépendamment de l'état lu.
 * Si la cible change entre l'aperçu et la confirmation, la façade refuse sous verrou ; l'action est alors
 * RECONSTRUITE ici sur l'état actuel (`rebuildAfterConflict`) et reproposée : nouvel avant / après, nouvelle
 * confirmation. Aucune écriture fondée sur un état périmé.
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';
import { EQUIPMENT_FICHE_FIELDS, parseEquipmentFiche } from '@/lib/asset-detail-rules';
import { EQUIPMENT_ENERGY_USAGE_OPTIONS } from '@/lib/cil/energy-equipment';
import { SITUATION_FIELD_LABEL, SITUATION_LABELS, situationOf } from '@/lib/agenda/situation';
import { SUPPLIER_FIELD_LABELS as FICHE_FOURNISSEUR_LABELS, maskIban } from '@/lib/suppliers/supplier-fiche-config';
import { isValidEquipmentStatus } from '@/types/domain';
import { formatDateFr } from '../core/deterministic-format';
import { plain } from '../core/routing-text';
import type {
  AgendaRequestedPatch, CommandParams, EquipmentRequestedValues, PlannedAction, SupplierCommandField,
} from './catalog';
import { parseAmountCents, parseTimeFr, type LabelledValue } from './labelled-values';
import { parseDateFr } from './parser';
import type { AgendaLabelKey, EquipmentLabelKey } from './rich-edit-labels';
import type { CommandLookup, SupplierState } from './plan.service';

type Resolution = PlannedAction | { needInfo: string };
const VIDE = '(vide)';
const texte = (v: unknown): string => (v === null || v === undefined || v === '' ? VIDE : String(v));
const mots = (s: string): string[] => plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
const memeNom = (a: string, b: string): boolean => mots(a).join(' ') === mots(b).join(' ');
const euros = (cents: number | null | undefined): string =>
  (cents === null || cents === undefined ? VIDE : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100).replace(/[  ]/g, ' '));

// ══════════════════════════════════════════════════════════════════════════
// ÉQUIPEMENTS (E01, E02)
// ══════════════════════════════════════════════════════════════════════════

/** Statuts d'un équipement : libellés du tiroir de l'équipement, et mots par lesquels ils sont demandés. */
export const EQUIPMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  EN_SERVICE: 'En service', EN_PANNE: 'En panne', EN_REPARATION: 'En réparation', INACTIF: 'Inactif',
};
const STATUT_DEMANDE: ReadonlyArray<{ code: string; re: RegExp }> = [
  { code: 'EN_REPARATION', re: /\breparation\b/ },
  { code: 'EN_PANNE', re: /\b(?:en panne|panne|hors service|hs)\b/ },
  { code: 'INACTIF', re: /\b(?:inactif|inactive|desactive|a l'arret)\b/ },
  { code: 'EN_SERVICE', re: /\b(?:en service|fonctionne|en marche|actif|active)\b/ },
];

const FICHE_PAR_CLE = new Map(EQUIPMENT_FICHE_FIELDS.map((f) => [f.key, f]));
const LIBELLE_EQUIPEMENT: Readonly<Record<string, string>> = {
  name: 'Nom', type: 'Type', category: 'Catégorie', status: 'Statut', energyUsage: 'Usage énergétique',
  purchasePriceCents: 'Prix d’achat', estimatedValueCents: 'Valeur estimée',
  ...Object.fromEntries(EQUIPMENT_FICHE_FIELDS.map((f) => [f.key, f.label])),
};

/** Équipement tel que sa fiche le montre — état présenté à l'aperçu et relu avant d'écrire. */
export interface EquipmentFullState {
  id: number; name: string; assetId: number; assetName: string;
  roomId: number | null; roomName: string | null;
  type: string | null; category: string | null; status: string; energyUsage: string | null;
  purchasePriceCents: number | null; estimatedValueCents: number | null;
  /** Fiche (marque, modèle, n° de série…) : clés de `EQUIPMENT_FICHE_FIELDS`, valeurs canoniques. */
  fiche: Record<string, string | number | null>;
  /** Ce qui lui est rattaché et le suit (jamais copié, jamais supprimé). */
  documents: number; agenda: number;
  /** Horodatage de dernière modification (microsecondes, texte) : version exigée par la façade. */
  updatedAt: string;
  /** Empreinte de l'état présenté. */
  version: string;
}

/** Lecture seule, bornée au compte : équipement NON archivé d'un bien non supprimé du compte. */
export async function readEquipmentFullState(accountId: number, equipmentId: number): Promise<EquipmentFullState | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT e.id, e.name, e.type, e.category, e.status, e.energy_usage AS "energyUsage",
            e.purchase_price_cents AS "purchasePriceCents", e.estimated_value_cents AS "estimatedValueCents",
            e.substructure_id AS "roomId", a.id AS "assetId", a.name AS "assetName",
            (SELECT r.name FROM substructures r WHERE r.id = e.substructure_id AND r.asset_id = a.id) AS "roomName",
            (SELECT count(*)::int FROM asset_files f WHERE f.account_id = $2 AND f.deleted_at IS NULL AND f.equipment_id = e.id) AS documents,
            (SELECT count(*)::int FROM agenda_equipment_links l JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $2 WHERE l.equipment_id = e.id) AS agenda,
            (extract(epoch FROM e.updated_at) * 1000000)::bigint::text AS "updatedAt"
       FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
      WHERE e.id = $1 AND e.archived_at IS NULL`,
    [equipmentId, accountId] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  if (!r) return null;
  const { getCanonicalEntityState } = await import('@/services/canonical/entity-state/entity-view');
  const vue = await getCanonicalEntityState({ type: 'EQUIPMENT', id: Number(r.id) }, accountId).catch(() => null);
  const fiche: Record<string, string | number | null> = {};
  for (const f of EQUIPMENT_FICHE_FIELDS) {
    const v = vue?.fields[f.key]?.value;
    fiche[f.key] = typeof v === 'number' || typeof v === 'string' ? v : null;
  }
  const nombre = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const base = {
    id: Number(r.id), name: String(r.name), assetId: Number(r.assetId), assetName: String(r.assetName),
    roomId: nombre(r.roomId), roomName: (r.roomName as string | null) ?? null,
    type: (r.type as string | null) ?? null, category: (r.category as string | null) ?? null,
    status: String(r.status ?? 'EN_SERVICE'), energyUsage: (r.energyUsage as string | null) ?? null,
    purchasePriceCents: nombre(r.purchasePriceCents), estimatedValueCents: nombre(r.estimatedValueCents),
    fiche, documents: Number(r.documents), agenda: Number(r.agenda), updatedAt: String(r.updatedAt ?? ''),
  };
  const empreinte = createHash('sha256').update(JSON.stringify([
    base.id, base.name, base.assetId, base.roomId, base.type, base.category, base.status, base.energyUsage,
    base.purchasePriceCents, base.estimatedValueCents, EQUIPMENT_FICHE_FIELDS.map((f) => fiche[f.key]), base.documents, base.agenda, base.updatedAt,
  ])).digest('hex').slice(0, 32);
  return { ...base, version: empreinte };
}

/** Ce que la demande dit d'un équipement : valeurs de la fiche, pièce et bien parent (pure, testée). */
export interface EquipmentIntent {
  requested: EquipmentRequestedValues;
  /** Pièce demandée : mots de son nom ; `null` = « aucune pièce » ; absente = non demandée. */
  room?: string | null;
  /** Bien parent demandé (mots de son nom). */
  asset?: string;
}

export function interpretEquipmentValues(values: ReadonlyArray<LabelledValue<EquipmentLabelKey>>): EquipmentIntent | { needInfo: string } {
  const requested: EquipmentRequestedValues = {};
  const fiche: Record<string, string | number | null> = {};
  const intent: EquipmentIntent = { requested };
  for (const { key, raw } of values) {
    const libelle = LIBELLE_EQUIPEMENT[key] ?? key;
    if (key === 'room') { intent.room = raw; continue; }
    if (key === 'asset') {
      if (!raw) return { needInfo: 'Vers quel bien voulez-vous déplacer cet équipement ?' };
      intent.asset = raw; continue;
    }
    if (key === 'name') {
      if (!raw) return { needInfo: 'Le nom d’un équipement ne peut pas être vide.' };
      requested.name = raw.slice(0, 120); continue;
    }
    if (key === 'status') {
      const code = raw ? STATUT_DEMANDE.find((s) => s.re.test(plain(raw)))?.code : undefined;
      if (!code || !isValidEquipmentStatus(code)) {
        return { needInfo: `Quel statut voulez-vous donner à cet équipement ? ${Object.values(EQUIPMENT_STATUS_LABELS).join(', ')}.` };
      }
      requested.status = code; continue;
    }
    if (key === 'energyUsage') {
      if (!raw) { requested.energyUsage = null; continue; }
      const option = EQUIPMENT_ENERGY_USAGE_OPTIONS.find((o) => plain(o.label).includes(plain(raw)) || plain(o.value) === plain(raw));
      if (!option) return { needInfo: `Quel usage énergétique voulez-vous enregistrer ? ${EQUIPMENT_ENERGY_USAGE_OPTIONS.map((o) => o.label).join(', ')}.` };
      requested.energyUsage = option.value; continue;
    }
    if (key === 'purchasePriceCents' || key === 'estimatedValueCents') {
      const cents = raw ? parseAmountCents(raw) : null;
      if (raw && cents === null) return { needInfo: `Je n’ai pas compris le montant de « ${libelle} ». Écrivez-le en euros, par exemple « 2 500 € ».` };
      requested[key] = cents; continue;
    }
    if (key === 'type') { requested.type = raw ? raw.slice(0, 100) : null; continue; }
    if (key === 'category') { requested.category = raw ? raw.slice(0, 100) : null; continue; }
    const def = FICHE_PAR_CLE.get(key);
    if (!def) continue;
    fiche[key] = raw === null ? null : def.type === 'number' ? raw.replace(/\s*(?:kw|h|heures?)\s*$/i, '').replace(',', '.') : raw;
  }
  if (Object.keys(fiche).length) {
    // Mêmes règles que le tiroir de l'équipement (clés connues, nombres ≥ 0, bornes du registre).
    const lue = parseEquipmentFiche(fiche);
    if (lue.errors.length) return { needInfo: `${lue.errors.map((e) => e.message).join(' ')} Pouvez-vous vérifier ?` };
    requested.fiche = lue.values;
  }
  return intent;
}

const valeurEquipement = (cle: string, v: unknown): string => {
  if (cle === 'status') return EQUIPMENT_STATUS_LABELS[String(v)] ?? texte(v);
  if (cle === 'energyUsage') return v ? EQUIPMENT_ENERGY_USAGE_OPTIONS.find((o) => o.value === v)?.label ?? String(v) : VIDE;
  if (cle === 'purchasePriceCents' || cle === 'estimatedValueCents') return euros(v as number | null);
  return texte(v);
};
const identiques = (a: unknown, b: unknown): boolean =>
  (a === null || a === undefined || a === '' ? '' : String(a)) === (b === null || b === undefined || b === '' ? '' : String(b));

/**
 * Écart entre l'état d'un équipement et ce qui est demandé (pure, testée) : corps à transmettre à la façade
 * (seulement ce qui CHANGE) et lignes « Libellé : avant → après ». Pièce et bien parent : par identifiant.
 */
export function equipmentDiff(
  state: EquipmentFullState, requested: EquipmentRequestedValues, roomId: number | null | undefined, newAssetId: number | undefined,
): { body: Record<string, unknown>; lines: string[]; moved: boolean; roomChanged: boolean } {
  const body: Record<string, unknown> = {};
  const lines: string[] = [];
  const scalaires = ['name', 'type', 'category', 'status', 'energyUsage', 'purchasePriceCents', 'estimatedValueCents'] as const;
  for (const k of scalaires) {
    if (requested[k] === undefined || identiques(state[k], requested[k])) continue;
    body[k] = requested[k];
    lines.push(`${LIBELLE_EQUIPEMENT[k]} : ${valeurEquipement(k, state[k])} → ${valeurEquipement(k, requested[k])}`);
  }
  const fiche: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(requested.fiche ?? {})) {
    if (identiques(state.fiche[k], v)) continue;
    fiche[k] = v;
    lines.push(`${LIBELLE_EQUIPEMENT[k] ?? k} : ${texte(state.fiche[k])} → ${texte(v)}`);
  }
  if (Object.keys(fiche).length) body.fiche = fiche;
  const moved = newAssetId !== undefined && newAssetId !== state.assetId;
  if (moved) body.newAssetId = newAssetId;
  const roomChanged = roomId !== undefined && roomId !== state.roomId;
  if (roomChanged) body.substructureId = roomId;
  return { body, lines, moved, roomChanged };
}

/** Lookups nécessaires à la préparation d'une modification d'équipement (ceux de `CommandLookup`). */
type StructureLookup = Pick<CommandLookup, 'getAsset' | 'getAssetKind' | 'structureRefusal' | 'getRoomState' | 'findEquipments'>;

/**
 * Action figée « modifier un équipement » à partir de l'état LU et de ce qui est demandé — ou la précision à
 * demander. Partagée par la préparation et par la reconstruction après un conflit (E07).
 */
export async function buildEquipmentUpdate(p: {
  accountId: number; actionId: string; state: EquipmentFullState; requested: EquipmentRequestedValues;
  roomId?: number | null; newAssetId?: number; lookup: StructureLookup;
}): Promise<Resolution> {
  const { state: s, lookup, accountId } = p;
  if (!lookup.getAssetKind || !lookup.structureRefusal || !lookup.getRoomState || !lookup.findEquipments) {
    return { needInfo: 'Je ne peux pas faire cette modification depuis l’assistant.' };
  }
  // Bien parent : celui du compte, disponible, qui accepte des équipements (mêmes contrôles que l'écran).
  const deplace = p.newAssetId !== undefined && p.newAssetId !== s.assetId;
  const dest = deplace ? await lookup.getAsset(accountId, p.newAssetId!) : null;
  if (deplace && !dest) return { needInfo: 'Je n’ai pas trouvé ce bien dans votre compte. Vers quel bien voulez-vous déplacer cet équipement ?' };
  const bienFinal = { id: dest?.id ?? s.assetId, name: dest?.name ?? s.assetName };
  const nature = await lookup.getAssetKind(accountId, bienFinal.id);
  if (!nature) return { needInfo: 'Bien introuvable ou hors de votre compte.' };
  const refus = await lookup.structureRefusal(accountId, nature, 'equipment');
  if (refus) return { needInfo: refus };

  // Pièce : elle appartient au bien FINAL. Un déplacement sans pièce nommée retire la pièce d'origine.
  let roomId = p.roomId;
  let piece: { id: number; name: string } | null = null;
  if (typeof roomId === 'number') {
    const etat = await lookup.getRoomState(accountId, roomId);
    if (!etat || etat.assetId !== bienFinal.id) return { needInfo: `Cette pièce n’appartient pas à ${bienFinal.name}. Dans quelle pièce de ${bienFinal.name} se trouve cet équipement ?` };
    piece = { id: etat.id, name: etat.name };
  } else if (deplace && roomId === undefined && s.roomId !== null) roomId = null;

  const diff = equipmentDiff(s, p.requested, roomId, dest?.id);
  if (diff.roomChanged) diff.lines.push(`Pièce : ${s.roomName ?? 'aucune'} → ${piece?.name ?? 'aucune'}`);
  if (diff.lines.length === 0 && !diff.moved) return { needInfo: `L’équipement « ${s.name} » a déjà ces valeurs : rien à modifier.` };

  // Jamais deux équipements du même nom dans un bien (règle de la création et du renommage).
  const nomFinal = typeof diff.body.name === 'string' ? diff.body.name : s.name;
  if (diff.body.name !== undefined || diff.moved) {
    const homonymes = (await lookup.findEquipments(accountId, mots(nomFinal), bienFinal.id)).filter((x) => x.id !== s.id && memeNom(x.name, nomFinal));
    if (homonymes.length) return { needInfo: `L’équipement « ${homonymes[0].name} » existe déjà dans ${bienFinal.name}.` };
  }

  const liens = [
    ...(s.documents ? [`${s.documents} document${s.documents > 1 ? 's' : ''}`] : []),
    ...(s.agenda ? [`${s.agenda} échéance${s.agenda > 1 ? 's' : ''}`] : []),
  ];
  const params: Extract<CommandParams, { kind: 'equipment_update' }> = {
    kind: 'equipment_update', equipmentId: s.id, equipmentAssetId: s.assetId, requested: p.requested,
    ...(roomId !== undefined ? { roomId } : {}), ...(diff.moved ? { newAssetId: bienFinal.id } : {}),
    expectedVersion: s.version, expectedUpdatedAt: s.updatedAt,
  };
  const detail = diff.lines.length ? ` : ${diff.lines.join(' ; ')}` : '';
  return {
    actionId: p.actionId, command: 'UPDATE_EQUIPMENT', dependsOn: [],
    targets: [{ type: 'equipment', id: s.id, label: s.name }],
    params,
    preview: diff.moved
      ? `Déplacer l’équipement « ${s.name} » de ${s.assetName} vers ${bienFinal.name}${detail}.`
      : `Modifier l’équipement « ${s.name} » (${s.assetName})${detail}.`,
    effects: [
      ...(diff.moved ? [`Bien : ${s.assetName} → ${bienFinal.name}`] : []),
      ...diff.lines,
      ...(diff.moved ? [
        'C’est le même équipement qui change de bien : rien n’est copié ni supprimé.',
        liens.length ? `Il garde ce qui lui est rattaché : ${liens.join(', ')}, ainsi que son historique.` : 'Aucun document ni échéance ne lui est rattaché ; son historique est conservé.',
        ...(s.roomId !== null && piece === null ? [`Sa pièce actuelle (« ${s.roomName ?? '—'} ») appartient à ${s.assetName} : il ne sera plus rattaché à une pièce.`] : []),
        'Le rapprochement de ses documents est relancé pour son nouveau bien.',
      ] : []),
      'Ces valeurs sont enregistrées comme votre saisie : elles ne seront pas remplacées par une analyse.',
    ],
  };
}

/** Lignes de l'aperçu pour les informations fournies à la CRÉATION d'un équipement (E02). */
export function equipmentCreationLines(details: EquipmentRequestedValues): string[] {
  const lines: string[] = [];
  for (const k of ['type', 'category', 'status', 'energyUsage', 'purchasePriceCents', 'estimatedValueCents'] as const) {
    if (details[k] !== undefined && details[k] !== null) lines.push(`${LIBELLE_EQUIPEMENT[k]} : ${valeurEquipement(k, details[k])}`);
  }
  for (const [k, v] of Object.entries(details.fiche ?? {})) if (v !== null) lines.push(`${LIBELLE_EQUIPEMENT[k] ?? k} : ${texte(v)}`);
  return lines;
}

// ══════════════════════════════════════════════════════════════════════════
// AGENDA (E03)
// ══════════════════════════════════════════════════════════════════════════

const SITUATION_DEMANDEE: ReadonlyArray<{ code: 'A_EU_LIEU' | 'A_PREVOIR'; re: RegExp }> = [
  { code: 'A_EU_LIEU', re: /\b(?:a eu lieu|eu lieu|realisee?|faite?|passee?|terminee?)\b/ },
  { code: 'A_PREVOIR', re: /\b(?:a prevoir|prevoir|a venir|a planifier|planifiee?)\b/ },
];

type AgendaLookup = Pick<CommandLookup, 'findAssets' | 'findRooms' | 'findEquipments' | 'findDocuments'>;

/** Ce que la demande dit d'une échéance → patch (valeurs et liens à AJOUTER, résolus dans le compte). */
export async function interpretAgendaValues(
  values: ReadonlyArray<LabelledValue<AgendaLabelKey>>, accountId: number, today: string, lookup: AgendaLookup,
): Promise<AgendaRequestedPatch | { needInfo: string }> {
  const patch: AgendaRequestedPatch = {};
  const unSeul = <T extends { id: number }>(trouves: T[], nom: (t: T) => string, objet: string, raw: string): T | { needInfo: string } => {
    if (trouves.length === 0) return { needInfo: `Je n’ai pas trouvé ${objet} « ${raw} » dans votre compte.` };
    const exacts = trouves.filter((t) => memeNom(nom(t), raw));
    const retenus = exacts.length === 1 ? exacts : trouves;
    if (retenus.length > 1) return { needInfo: `Plusieurs réponses possibles pour ${objet} « ${raw} » : ${retenus.slice(0, 5).map(nom).join(', ')}. Précisez dans votre demande.` };
    return retenus[0];
  };
  for (const { key, raw } of values) {
    if (key === 'noDeadline') { patch.noDeadline = true; continue; }
    if (key === 'title') {
      if (!raw) return { needInfo: 'Le titre d’une échéance ne peut pas être vide.' };
      patch.title = raw.slice(0, 200); continue;
    }
    if (key === 'description') { patch.description = raw; continue; }
    if (key === 'startDate' || key === 'endDate') {
      if (raw === null) { patch[key] = null; continue; }
      const date = parseDateFr(raw, today);
      if (!date) return { needInfo: 'Je n’ai pas compris la date. Pouvez-vous l’écrire en entier, par exemple « 12 mars 2027 » ?' };
      patch[key] = date; continue;
    }
    if (key === 'startTime' || key === 'endTime') {
      if (raw === null) { patch[key] = null; continue; }
      const heure = parseTimeFr(raw);
      if (!heure) return { needInfo: 'Je n’ai pas compris l’heure. Pouvez-vous l’écrire sous la forme « 14h30 » ?' };
      patch[key] = heure; continue;
    }
    if (key === 'situation') {
      const code = raw ? SITUATION_DEMANDEE.find((s) => s.re.test(plain(raw)))?.code : undefined;
      if (!code) return { needInfo: `${SITUATION_FIELD_LABEL} : ${Object.values(SITUATION_LABELS).map((l) => `« ${l} »`).join(' ou ')} ?` };
      patch.situation = code; continue;
    }
    // Carte #843 (E03) — règle remplacée : « je peux ajouter un lien, pas en retirer ». Un lien se RETIRE en le
    // nommant (« retirer le bien Polo ») ; « bien aucun » reste ambigu (lequel ?) : question, rien n'est retiré.
    if (key === 'removeAsset' || key === 'removeRoom' || key === 'removeEquipment' || key === 'removeDocument') {
      if (!raw) return { needInfo: AGENDA_REMOVE_WHICH };
      const r = key === 'removeAsset' ? unSeul(await lookup.findAssets(accountId, mots(raw)), (a) => a.name, 'le bien', raw)
        : key === 'removeRoom' ? unSeul(await lookup.findRooms!(accountId, mots(raw), null), (x) => x.name, 'la pièce', raw)
          : key === 'removeEquipment' ? unSeul(await lookup.findEquipments!(accountId, mots(raw), null), (x) => x.name, 'l’équipement', raw)
            : unSeul(await lookup.findDocuments!(accountId, mots(raw)), (d) => d.title, 'le document', raw);
      if ('needInfo' in r) return r;
      const cle = key === 'removeAsset' ? 'removeAssetIds' : key === 'removeRoom' ? 'removeRoomIds' : key === 'removeEquipment' ? 'removeEquipmentIds' : 'removeFileIds';
      patch[cle] = [...(patch[cle] ?? []), r.id];
      continue;
    }
    if (!raw) return { needInfo: AGENDA_REMOVE_WHICH };
    if (key === 'asset') {
      const r = unSeul(await lookup.findAssets(accountId, mots(raw)), (a) => a.name, 'le bien', raw);
      if ('needInfo' in r) return r;
      patch.addAssetIds = [...(patch.addAssetIds ?? []), r.id];
    } else if (key === 'room') {
      const r = unSeul(await lookup.findRooms!(accountId, mots(raw), null), (x) => x.name, 'la pièce', raw);
      if ('needInfo' in r) return r;
      patch.addRoomIds = [...(patch.addRoomIds ?? []), r.id];
    } else if (key === 'equipment') {
      const r = unSeul(await lookup.findEquipments!(accountId, mots(raw), null), (x) => x.name, 'l’équipement', raw);
      if ('needInfo' in r) return r;
      patch.addEquipmentIds = [...(patch.addEquipmentIds ?? []), r.id];
    } else if (key === 'document') {
      const r = unSeul(await lookup.findDocuments!(accountId, mots(raw)), (d) => d.title, 'le document', raw);
      if ('needInfo' in r) return r;
      patch.addFileIds = [...(patch.addFileIds ?? []), r.id];
    }
  }
  if (patch.noDeadline && patch.startDate) return { needInfo: 'Une tâche « Sans échéance » n’a pas de date : voulez-vous une date, ou « Sans échéance » ?' };
  return patch;
}

/** Carte #843 (E03) : lien à retirer non désigné (texte à valider par le PO). */
export const AGENDA_REMOVE_WHICH = 'Quel lien voulez-vous retirer de cette échéance ? Nommez-le, par exemple « retirer le bien Polo » ou « retirer le document Facture ».';
/** Carte #843 (E03) : retrait qui laisserait un document, une pièce ou un équipement d'un bien retiré (texte à valider par le PO). */
export const AGENDA_REMOVE_INCOHERENT = 'Ce retrait laisserait sur l’échéance un document, une pièce ou un équipement du bien retiré : retirez-les aussi dans la même demande (par exemple « retirer le bien Maison, retirer le document Facture »), ou gardez ce bien. Rien n’a été modifié.';
/** Carte #843 (E03) : modification d'une SÉRIE demandée — non disponible dans l'Agenda (texte à valider par le PO). */
export const AGENDA_SERIES_UPDATE_UNSUPPORTED = 'L’Agenda ne permet pas de modifier toute une série d’un seul geste : je ne peux modifier qu’une échéance à la fois (les autres de la série ne changent pas). Pour toute la série, supprimez-la puis recréez-la, ou modifiez chaque échéance. Rien n’a été modifié.';

/** Échéance telle que le tiroir de l'Agenda la montre (lecture du service de l'Agenda, compte borné). */
type AgendaEtat = NonNullable<Awaited<ReturnType<typeof import('@/services/agenda/AgendaQueryService').getAgendaItemById>>>;

/** Entrée du service de l'Agenda (`updateAgendaItem`) : seulement les champs du tiroir. */
export interface AgendaWriteInput {
  title?: string; description?: string | null;
  startDate?: string | null; startTime?: string | null; endDate?: string | null; endTime?: string | null;
  noDeadline?: boolean; situation?: 'A_EU_LIEU' | 'A_PREVOIR';
  assetIds?: number[]; substructureIds?: number[]; equipmentIds?: number[]; fileIds?: number[];
}

/** Écart entre une échéance et le patch demandé (pure, testée) : entrée du service de l'Agenda et lignes de l'aperçu. */
export function agendaDiff(item: AgendaEtat, patch: AgendaRequestedPatch, noms: AgendaLinkNames = {}): {
  input: AgendaWriteInput; lines: string[];
} {
  const input: AgendaWriteInput = {};
  const lines: string[] = [];
  const date = (d: string | null | undefined) => (d ? formatDateFr(d) : 'aucune');
  const heure = (h: string | null | undefined) => (h ? h.slice(0, 5) : 'aucune');
  if (patch.title !== undefined && patch.title !== item.title) { input.title = patch.title; lines.push(`Titre : ${item.title} → ${patch.title}`); }
  if (patch.description !== undefined && !identiques(item.description, patch.description)) {
    input.description = patch.description; lines.push(`Description : ${texte(item.description)} → ${texte(patch.description)}`);
  }
  if (patch.startDate !== undefined && patch.startDate !== item.startDate) { input.startDate = patch.startDate; lines.push(`Date de début : ${date(item.startDate)} → ${date(patch.startDate)}`); }
  if (patch.startTime !== undefined && heure(patch.startTime) !== heure(item.startTime)) { input.startTime = patch.startTime; lines.push(`Heure de début : ${heure(item.startTime)} → ${heure(patch.startTime)}`); }
  if (patch.endDate !== undefined && patch.endDate !== item.endDate) { input.endDate = patch.endDate; lines.push(`Date de fin : ${date(item.endDate)} → ${date(patch.endDate)}`); }
  if (patch.endTime !== undefined && heure(patch.endTime) !== heure(item.endTime)) { input.endTime = patch.endTime; lines.push(`Heure de fin : ${heure(item.endTime)} → ${heure(patch.endTime)}`); }
  if (patch.noDeadline !== undefined && patch.noDeadline !== (item.noDeadline ?? false)) {
    input.noDeadline = patch.noDeadline;
    lines.push(`Sans échéance : ${item.noDeadline ? 'oui' : 'non'} → ${patch.noDeadline ? 'oui (la date est retirée)' : 'non'}`);
  }
  const situation = situationOf(item.situation);
  if (patch.situation !== undefined && patch.situation !== situation) {
    input.situation = patch.situation;
    lines.push(`${SITUATION_FIELD_LABEL} : ${situation ? SITUATION_LABELS[situation] : 'non précisée'} → ${SITUATION_LABELS[patch.situation]}`);
  }
  // Liens : la liste complète transmise est celle de l'échéance RELUE, plus les ajouts, moins les retraits CIBLÉS
  // (carte #843, E03) — un lien qui n'est ni ajouté ni retiré n'est jamais touché.
  const ajuster = (cle: 'assetIds' | 'substructureIds' | 'equipmentIds' | 'fileIds', libelle: string, actuels: number[],
    ajouts: number[] | undefined, retraits: number[] | undefined, nomsAjoutes: string[] | undefined, nomsRetires: string[] | undefined) => {
    const nouveaux = (ajouts ?? []).filter((id) => !actuels.includes(id));
    const retires = (retraits ?? []).filter((id) => actuels.includes(id));
    if (!nouveaux.length && !retires.length) return;
    input[cle] = [...actuels.filter((id) => !retires.includes(id)), ...nouveaux];
    if (nouveaux.length) lines.push(`${libelle} ajouté${nouveaux.length > 1 ? 's' : ''} : ${(nomsAjoutes ?? nouveaux.map(String)).join(', ')}`);
    if (retires.length) lines.push(`${libelle} retiré${retires.length > 1 ? 's' : ''} : ${(nomsRetires ?? retires.map(String)).join(', ')}`);
  };
  ajuster('assetIds', 'Bien', item.assetLinks.map((l) => l.assetId), patch.addAssetIds, patch.removeAssetIds, noms.assets, noms.removedAssets);
  ajuster('substructureIds', 'Pièce', item.roomLinks.map((l) => l.substructureId), patch.addRoomIds, patch.removeRoomIds, noms.rooms, noms.removedRooms);
  ajuster('equipmentIds', 'Équipement', item.equipmentLinks.map((l) => l.equipmentId), patch.addEquipmentIds, patch.removeEquipmentIds, noms.equipments, noms.removedEquipments);
  ajuster('fileIds', 'Document', item.fileLinks.map((l) => l.assetFileId), patch.addFileIds, patch.removeFileIds, noms.files, noms.removedFiles);
  return { input, lines };
}

/** Noms des liens ajoutés et retirés, pour les lignes de l'aperçu. */
export interface AgendaLinkNames {
  assets?: string[]; rooms?: string[]; equipments?: string[]; files?: string[];
  removedAssets?: string[]; removedRooms?: string[]; removedEquipments?: string[]; removedFiles?: string[];
}

async function nomsDesLiens(accountId: number, patch: AgendaRequestedPatch, item: AgendaEtat): Promise<AgendaLinkNames> {
  const lire = async (ids: number[] | undefined, actuels: number[], sql: string, retrait = false): Promise<string[] | undefined> => {
    const nouveaux = (ids ?? []).filter((id) => (retrait ? actuels.includes(id) : !actuels.includes(id)));
    if (!nouveaux.length) return undefined;
    const rows = (await pgClient.unsafe(sql, [nouveaux, accountId] as never[])) as unknown as Array<{ id: number; name: string }>;
    return nouveaux.map((id) => rows.find((r) => Number(r.id) === id)?.name ?? `n° ${id}`);
  };
  return {
    assets: await lire(patch.addAssetIds, item.assetLinks.map((l) => l.assetId), `SELECT id, name FROM assets WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL`),
    rooms: await lire(patch.addRoomIds, item.roomLinks.map((l) => l.substructureId), `SELECT r.id, r.name FROM substructures r JOIN assets a ON a.id = r.asset_id AND a.account_id = $2 WHERE r.id = ANY($1::int[])`),
    equipments: await lire(patch.addEquipmentIds, item.equipmentLinks.map((l) => l.equipmentId), `SELECT e.id, e.name FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 WHERE e.id = ANY($1::int[])`),
    files: await lire(patch.addFileIds, item.fileLinks.map((l) => l.assetFileId), `SELECT id, coalesce(retained_title, web_link_title, original_filename) AS name FROM asset_files WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL`),
    removedAssets: await lire(patch.removeAssetIds, item.assetLinks.map((l) => l.assetId), `SELECT id, name FROM assets WHERE id = ANY($1::int[]) AND account_id = $2`, true),
    removedRooms: await lire(patch.removeRoomIds, item.roomLinks.map((l) => l.substructureId), `SELECT r.id, r.name FROM substructures r JOIN assets a ON a.id = r.asset_id AND a.account_id = $2 WHERE r.id = ANY($1::int[])`, true),
    removedEquipments: await lire(patch.removeEquipmentIds, item.equipmentLinks.map((l) => l.equipmentId), `SELECT e.id, e.name FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 WHERE e.id = ANY($1::int[])`, true),
    removedFiles: await lire(patch.removeFileIds, item.fileLinks.map((l) => l.assetFileId), `SELECT id, coalesce(retained_title, web_link_title, original_filename) AS name FROM asset_files WHERE id = ANY($1::int[]) AND account_id = $2`, true),
  };
}

/**
 * Action figée « modifier une échéance » (champs du tiroir) à partir de l'échéance RELUE et du patch demandé —
 * ou la précision à demander. Partagée par la préparation et par la reconstruction après un conflit (E07).
 */
export async function buildAgendaUpdate(p: { accountId: number; actionId: string; agendaItemId: number; patch: AgendaRequestedPatch }): Promise<Resolution> {
  const [{ getAgendaItemById }, { agendaVersion, readAgendaSnapshot }] = await Promise.all([
    import('@/services/agenda/AgendaQueryService'), import('./undo.service'),
  ]);
  const item = await getAgendaItemById(p.agendaItemId, p.accountId);
  const cliche = await readAgendaSnapshot(pgClient, p.accountId, p.agendaItemId);
  if (!item || !cliche) return { needInfo: 'Je n’ai pas trouvé cette échéance dans votre Agenda. Indiquez son titre exact ou sa date.' };
  const { lines } = agendaDiff(item, p.patch, await nomsDesLiens(p.accountId, p.patch, item));
  const quand = item.startDate ? ` du ${formatDateFr(item.startDate)}` : '';
  // Carte #843 (E03) : un lien à retirer qui n'est pas posé sur CETTE échéance — dit, jamais un succès inventé.
  const absents = [
    ...(p.patch.removeAssetIds ?? []).filter((id) => !item.assetLinks.some((l) => l.assetId === id)),
    ...(p.patch.removeRoomIds ?? []).filter((id) => !item.roomLinks.some((l) => l.substructureId === id)),
    ...(p.patch.removeEquipmentIds ?? []).filter((id) => !item.equipmentLinks.some((l) => l.equipmentId === id)),
    ...(p.patch.removeFileIds ?? []).filter((id) => !item.fileLinks.some((l) => l.assetFileId === id)),
  ];
  if (absents.length) return { needInfo: `Ce lien n’est pas posé sur l’échéance « ${item.title} »${quand} : rien à retirer. Rien n’a été modifié.` };
  // Carte #843 (E03) : un RETRAIT qui rendrait les liens incohérents (document, pièce ou équipement d'un bien qui
  // n'est plus lié) est dit AVANT toute proposition — mêmes règles que le tiroir de l'Agenda (`validateAgendaWrite`),
  // jamais un échec découvert à la confirmation.
  const retraits = (p.patch.removeAssetIds?.length ?? 0) + (p.patch.removeRoomIds?.length ?? 0) + (p.patch.removeEquipmentIds?.length ?? 0) + (p.patch.removeFileIds?.length ?? 0);
  if (retraits) {
    const { input } = agendaDiff(item, p.patch);
    const { validateAgendaWrite } = await import('@/services/agenda/write-agenda-item');
    try {
      await validateAgendaWrite({ startDate: item.startDate, startTime: item.startTime, endDate: item.endDate, endTime: item.endTime }, {
        assetIds: input.assetIds ?? item.assetLinks.map((l) => l.assetId),
        fileIds: input.fileIds ?? item.fileLinks.map((l) => l.assetFileId),
        substructureIds: input.substructureIds ?? item.roomLinks.map((l) => l.substructureId),
        equipmentIds: input.equipmentIds ?? item.equipmentLinks.map((l) => l.equipmentId),
      }, p.accountId);
    } catch (e) {
      if (/appartient à un bien non sélectionné/.test((e as Error).message)) return { needInfo: AGENDA_REMOVE_INCOHERENT };
      throw e;
    }
  }
  if (lines.length === 0) return { needInfo: `L’échéance « ${item.title} »${quand} a déjà ces valeurs : rien à modifier.` };
  const [{ n }] = (await pgClient.unsafe(
    `SELECT CASE WHEN i.series_key IS NULL THEN 1 ELSE (SELECT count(*)::int FROM agenda_items s WHERE s.account_id = i.account_id AND s.series_key = i.series_key) END AS n
       FROM agenda_items i WHERE i.id = $1 AND i.account_id = $2`,
    [p.agendaItemId, p.accountId] as never[],
  )) as unknown as Array<{ n: number }>;
  return {
    actionId: p.actionId, command: 'UPDATE_AGENDA_ITEM', dependsOn: [],
    targets: [{ type: 'agenda_item', id: item.id, label: item.title }],
    params: { kind: 'agenda_update', agendaItemId: item.id, patch: p.patch, expectedVersion: agendaVersion(cliche), expectedUpdatedAt: cliche.updatedAt },
    preview: `Modifier l’échéance « ${item.title} »${quand} : ${lines.join(' ; ')}.`,
    effects: [
      ...lines,
      ...(lines.some((l) => / retirés? : /.test(l)) ? ['Seuls les liens nommés sont retirés : les autres liens de l’échéance, l’échéance elle-même et les objets retirés (bien, pièce, équipement, document) sont conservés.'] : []),
      ...(Number(n) > 1 ? [`Seule cette échéance est modifiée : les ${Number(n) - 1} autres de la série ne changent pas.`] : []),
      'Les rappels de cette échéance sont recalculés par l’Agenda.',
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════
// FOURNISSEURS (E04)
// ══════════════════════════════════════════════════════════════════════════

const CHAMPS_BANCAIRES: ReadonlySet<SupplierCommandField> = new Set(['iban', 'ibanHolderName']);
/** Case à cocher exigée avant de confirmer un changement bancaire (texte à valider par le PO). */
export const BANKING_CONFIRMATION_LABEL = 'J’ai vérifié ces coordonnées bancaires sur un document du fournisseur.';
export const BANKING_CONFIRMATION_REQUIRED = 'Ce changement touche des coordonnées bancaires : cochez la case de vérification avant de confirmer. Rien n’a été modifié.';

const REFUS_FORMAT: Partial<Record<SupplierCommandField, string>> = {
  email: 'Cette adresse e-mail ne semble pas valide. Pouvez-vous la vérifier ?',
  siren: 'Un numéro SIREN comporte 9 chiffres. Pouvez-vous le vérifier ?',
  siret: 'Un numéro SIRET comporte 14 chiffres. Pouvez-vous le vérifier ?',
  iban: 'Cet IBAN ne semble pas valide. Pouvez-vous le vérifier ? Il n’a pas été enregistré.',
  name: 'Le nom d’un fournisseur ne peut pas être vide.',
};

/** Valeur ACTUELLE d'un champ, telle qu'elle peut être montrée : l'IBAN n'existe ici que masqué. */
const actuelleFournisseur = (s: SupplierState, f: SupplierCommandField): string | null =>
  (f === 'iban' ? s.ibanMasked ?? null : (s as unknown as Record<string, string | null | undefined>)[f] ?? null);

/**
 * Action figée « modifier un fournisseur » (un ou plusieurs champs) — ou la précision à demander. Mêmes
 * validations que la fiche (`validateSupplierPatch`). L'IBAN n'apparaît JAMAIS en clair dans l'aperçu, ses
 * effets ni son résumé : seule sa forme masquée (4 premiers et 4 derniers caractères) est montrée.
 */
export async function buildSupplierUpdate(p: {
  actionId: string; state: SupplierState; requested: Partial<Record<SupplierCommandField, string | null>>;
}): Promise<Resolution> {
  const s = p.state;
  const { validateSupplierPatch } = await import('@/services/suppliers/supplier-validation');
  const v = validateSupplierPatch(Object.fromEntries(Object.entries(p.requested).map(([k, x]) => [k, x ?? ''])));
  if (!v.ok) {
    return { needInfo: (v.field && REFUS_FORMAT[v.field as SupplierCommandField]) ?? 'Cette valeur ne peut pas être enregistrée telle quelle. Pouvez-vous la vérifier ?' };
  }
  const patch: Partial<Record<SupplierCommandField, string | null>> = {};
  const lines: string[] = [];
  for (const [k, nouvelle] of Object.entries(v.updates) as Array<[SupplierCommandField, string | null]>) {
    const actuelle = actuelleFournisseur(s, k);
    // IBAN : l'état lu ne porte que sa forme masquée — deux IBAN de même forme ne sont pas réputés identiques.
    const pareil = k === 'iban' ? !nouvelle && !s.hasIban : identiques(actuelle, nouvelle);
    if (pareil) continue;
    patch[k] = nouvelle;
    lines.push(`${FICHE_FOURNISSEUR_LABELS[k] ?? k} : ${texte(actuelle)} → ${k === 'iban' ? texte(maskIban(nouvelle)) : texte(nouvelle)}`);
  }
  if (lines.length === 0) return { needInfo: `Le fournisseur « ${s.name} » a déjà ces valeurs : rien à modifier.` };
  const bancaire = (Object.keys(patch) as SupplierCommandField[]).some((k) => CHAMPS_BANCAIRES.has(k));
  return {
    actionId: p.actionId, command: 'UPDATE_SUPPLIER', dependsOn: [],
    targets: [{ type: 'supplier', id: s.id, label: s.name }],
    params: {
      kind: 'supplier_update', supplierId: s.id, patch, expectedVersion: s.version,
      ...(s.rowVersion ? { expectedRowVersion: s.rowVersion } : {}), ...(bancaire ? { banking: true as const } : {}),
    },
    preview: `Modifier le fournisseur « ${s.name} » : ${lines.join(' ; ')}.`,
    effects: [
      `Fournisseur : ${s.name}`,
      ...lines,
      ...(bancaire ? [
        'Coordonnées bancaires : l’IBAN n’est jamais affiché en entier. Vérifiez-le sur un document du fournisseur avant de confirmer.',
        'Une confirmation renforcée vous est demandée pour ce changement.',
      ] : []),
      'Ces valeurs ne seront pas remplacées par celles d’un document.',
    ],
  };
}

/**
 * Actions d'un plan telles qu'elles peuvent être JOURNALISÉES (E04) : l'IBAN y est remplacé par sa forme
 * masquée. Le plan figé, lui, garde la valeur à écrire jusqu'à son issue, puis elle en est retirée
 * (`scrubBankingPayloads`, plan.service). Pure.
 */
export function redactActionsForTrace(actions: PlannedAction[]): PlannedAction[] {
  return actions.map((a) => {
    const p = a.params as { kind?: string; patch?: Record<string, unknown> };
    if (p.kind !== 'supplier_update' || !p.patch || typeof p.patch.iban !== 'string') return a;
    return { ...a, params: { ...a.params, patch: { ...p.patch, iban: maskIban(p.patch.iban) }, ibanScrubbed: true } as PlannedAction['params'] };
  });
}

// ══════════════════════════════════════════════════════════════════════════
// E07 — reconstruction d'une action après un conflit de version
// ══════════════════════════════════════════════════════════════════════════

/**
 * Reconstruit, sur l'état ACTUEL du compte, une action refusée parce que sa cible avait changé depuis l'aperçu.
 * `null` : cette commande ne se reconstruit pas ici (l'utilisateur refait sa demande) ou n'a plus rien à changer.
 */
export async function rebuildAfterConflict(action: PlannedAction, accountId: number, lookup: CommandLookup): Promise<PlannedAction | null> {
  const p = action.params as CommandParams;
  let r: Resolution | null = null;
  if ('kind' in p && p.kind === 'equipment_update') {
    const state = await readEquipmentFullState(accountId, p.equipmentId);
    if (state) r = await buildEquipmentUpdate({ accountId, actionId: action.actionId, state, requested: p.requested, roomId: p.roomId, newAssetId: p.newAssetId, lookup });
  } else if ('kind' in p && p.kind === 'supplier_update') {
    const state = lookup.getSupplierState ? await lookup.getSupplierState(accountId, p.supplierId) : null;
    if (state) r = await buildSupplierUpdate({ actionId: action.actionId, state, requested: p.patch });
  } else if ('kind' in p && p.kind === 'agenda_update') {
    r = await buildAgendaUpdate({ accountId, actionId: action.actionId, agendaItemId: p.agendaItemId, patch: p.patch });
  } else {
    // Carte #843 (E07) : anciennes voies (renommage, archivage, suppression, documents, opérations et liens).
    const { rebuildLegacyAfterConflict } = await import('./conflict-rebuild');
    return rebuildLegacyAfterConflict(action, accountId, lookup);
  }
  return r && !('needInfo' in r) ? r : null;
}
