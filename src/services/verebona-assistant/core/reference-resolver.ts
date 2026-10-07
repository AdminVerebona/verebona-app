/**
 * Résolution des références conversationnelles — CDC §16.4.
 *
 * « le deuxième », « l'autre », « ce document », « cette voiture », « sa
 * date », « le précédent »… résolus À PARTIR DU FIL COURANT UNIQUEMENT, sans
 * modèle, avant le routage et le retrieval.
 *
 * Module pur : il ne lit rien. Il reçoit le contexte du fil (entités
 * présentées dans l'ordre d'affichage, entité sélectionnée, bien / document
 * courants) et rend soit une entité, soit une ambiguïté (candidats), soit
 * rien. Il n'autorise rien : l'appelant re-vérifie l'entité en base.
 */

/** Lot 29 (ticket 13) : un équipement ou une pièce peut être la cible courante du fil. */
import { leadingAssetTerm } from '@/lib/asset-taxonomy';
import { findReadableFields } from '../canonical/field-vocabulary';

/** Réponse du fil restituant une donnée sensible, telle que vue par le modèle. */
export const SENSITIVE_ANSWER_PLACEHOLDER = '(réponse contenant une donnée protégée, non transmise)';

export type ReferencedType = 'asset' | 'document' | 'agenda_item' | 'equipment' | 'room';

export interface PresentedEntity {
  position: number;
  type: ReferencedType;
  id: number;
  label?: string | null;
}

export interface ThreadContext {
  conversationId: number;
  /**
   * Jusqu'à 8 messages utiles du fil, du plus ancien au plus récent.
   * `sensitive` : réponse restituant une donnée sensible (adresse…) — jamais
   * recopiée dans un prompt (lot 29, ticket 8a AC10).
   */
  messages: Array<{ role: 'user' | 'assistant'; content: string; sensitive?: boolean }>;
  /** Listes présentées, de la plus récente à la plus ancienne. */
  presentedLists: PresentedEntity[][];
  /** Dernière liste présentée (raccourci de presentedLists[0]). */
  lastPresentedEntities: PresentedEntity[];
  /** Dernière entité explicitement désignée (référence résolue, choix de clarification). */
  lastSelected: { type: ReferencedType; id: number; label?: string | null } | null;
  currentAssetId: number | null;
  currentDocumentId: number | null;
  pendingClarification: string | null;
}

export type ReferenceResolution =
  | { kind: 'none' }
  | { kind: 'resolved'; entity: { type: ReferencedType; id: number; label?: string | null }; method: string; detected: string }
  | { kind: 'ambiguous'; candidates: PresentedEntity[]; detected: string };

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’]/g, "'");

/**
 * « son kilométrage », « sa date de fin de garantie », « son numéro de
 * série » : un pronom suivi d'un CHAMP du registre canonique (vocabulaire
 * unique, lot 29) vise l'élément courant.
 */
function pronomDeChamp(m: string): string | null {
  const re = /\b(sa|son|ses)\s+/g;
  for (let x = re.exec(m); x; x = re.exec(m)) {
    const suite = m.slice(x.index + x[0].length);
    const champ = findReadableFields(suite)[0];
    if (champ && champ.index === 0) return `${x[0]}${champ.phrase}`;
  }
  return null;
}

const ORDINAUX: Array<[RegExp, number]> = [
  [/\b(premier|premiere|1er|1re|1ere)\b/, 1],
  [/\b(deuxieme|2e|2eme|second|seconde)\b/, 2],
  [/\b(troisieme|3e|3eme)\b/, 3],
  [/\b(quatrieme|4e|4eme)\b/, 4],
  [/\b(cinquieme|5e|5eme)\b/, 5],
  [/\b(dernier|derniere)\b/, -1],
];

const DEMONSTRATIF_DOC = /\b(ce|cet|cette)\s+(document|fichier|facture|contrat|devis|pdf|piece)\b/;
/**
 * « ce bien », « cette maison », « ce garage », « ce mobil-home » : le nom
 * qui suit le démonstratif vient du référentiel des biens (lot 30 — ancien
 * `DEMONSTRATIF_BIEN`, liste figée qui ignorait garage, camion, camping-car…).
 */
function demonstratifBien(m: string): string | null {
  const re = /\b(ce|cet|cette)\s+/g;
  for (let x = re.exec(m); x; x = re.exec(m)) {
    const terme = leadingAssetTerm(m.slice(x.index + x[0].length));
    if (terme) return `${x[0]}${terme}`;
  }
  return null;
}
const AUTRE = /\b(l'autre|l autre|pour l'autre|et l'autre)\b/;
const PRECEDENT = /\b(le precedent|la precedente|celui d'avant|celle d'avant)\b/;
const PRONOM = /\b(celui-ci|celle-ci|celui-la|celle-la|lui)\b|\b(sa|son|ses)\s+(date|montant|echeance|prix|titre|fournisseur|adresse|reference|numero|immatriculation|date d'achat)\b/;
// « son statut », « son état » visent l'élément sélectionné (E2E-T2-12).
const PRONOM_STATUT = /\b(sa|son|ses)\s+(statut|etat)\b/;

// Corpus §15 E2E-T2-12 : question de STATUT sur l'échéance choisie
// (« est-il réalisé ? », « a-t-il été fait ? »). L'inversion ne vaut renvoi
// QUE si le message ne contient rien d'autre que ce vocabulaire de suivi
// (court, aucune entité nommée), que la dernière sélection du fil est une
// échéance.
// « Le contrôle technique de la Clio est-il passé ? » n'est pas un renvoi.
const INVERSION = /^(?:et\s+)?(est-il|est-elle|a-t-il|a-t-elle)\b/;
const MOTS_DE_STATUT = new Set([
  'et', 'est-il', 'est-elle', 'a-t-il', 'a-t-elle', 'deja', 'bien', 'ete', 'eu', 'lieu', 'vraiment', 'maintenant',
  'fait', 'faite', 'realise', 'realisee', 'effectue', 'effectuee', 'passe', 'passee', 'termine', 'terminee',
  'confirme', 'confirmee', 'annule', 'annulee', 'en', 'retard', 'a', 'jour', 'prevu', 'prevue',
]);
function inversionDeStatut(m: string, ctx: ThreadContext): string | null {
  if (ctx.lastSelected?.type !== 'agenda_item') return null;
  const mots = m.replace(/[?.!,;:]/g, ' ').split(/\s+/).filter(Boolean);
  const hit = m.trim().match(INVERSION);
  if (!hit || mots.length > 6 || !mots.every((w) => MOTS_DE_STATUT.has(w))) return null;
  return hit[1];
}

/** Liste la plus récente qui contient la position demandée. */
function parPosition(ctx: ThreadContext, pos: number): PresentedEntity | null {
  for (const liste of ctx.presentedLists) {
    if (liste.length === 0) continue;
    if (pos === -1) return liste[liste.length - 1];
    const e = liste.find((x) => x.position === pos);
    if (e) return e;
  }
  return null;
}

function unique<T>(liste: T[]): T | null {
  return liste.length === 1 ? liste[0] : null;
}

export function resolveThreadReference(message: string, ctx: ThreadContext): ReferenceResolution {
  const m = plain(message);
  const derniere = ctx.lastPresentedEntities;

  // 1. Ordinal — « ouvre le deuxième » : position dans la liste AFFICHÉE.
  //
  // Seulement en position de référence (« le deuxième », « la deuxième
  // facture », « et le troisième ? ») : « mon dernier document » ou « la
  // première échéance de 2027 » sont des questions, pas des renvois.
  for (const [re, pos] of ORDINAUX) {
    const hit = m.match(re);
    if (!hit) continue;
    const suite = m.slice((hit.index ?? 0) + hit[0].length).trim();
    const nomsDeType = /^(document|fichier|facture|bien|echeance|element|resultat|lien|choix|contrat)s?\b/;
    const enReference = /^([?.!,]|de la liste|$)/.test(suite)
      || (pos !== -1 && nomsDeType.test(suite) && suite.split(/\s+/).length <= 2);
    if (!enReference) break;
    if (ctx.presentedLists.every((l) => l.length === 0)) break;
    const e = parPosition(ctx, pos);
    if (e) return { kind: 'resolved', entity: e, method: 'ordinal', detected: hit[0] };
    break;
  }

  // 2. « l'autre » : parmi deux éléments présentés, celui qui n'est pas
  //    sélectionné. Plusieurs « autres » possibles → ambiguïté.
  const autre = m.match(AUTRE);
  if (autre) {
    const liste = ctx.presentedLists.find((l) => l.length >= 2) ?? [];
    const sel = ctx.lastSelected;
    const restants = liste.filter((e) => !(sel && e.type === sel.type && e.id === sel.id));
    if (sel && restants.length === 1 && restants.length < liste.length) {
      return { kind: 'resolved', entity: restants[0], method: 'other', detected: autre[0] };
    }
    if (restants.length >= 2) return { kind: 'ambiguous', candidates: restants, detected: autre[0] };
    return { kind: 'none' };
  }

  // 3. « le précédent » : l'élément affiché avant celui sélectionné.
  const prec = m.match(PRECEDENT);
  if (prec && ctx.lastSelected) {
    const liste = ctx.presentedLists.find((l) => l.some((e) => e.type === ctx.lastSelected!.type && e.id === ctx.lastSelected!.id));
    const i = liste?.findIndex((e) => e.type === ctx.lastSelected!.type && e.id === ctx.lastSelected!.id) ?? -1;
    if (liste && i > 0) return { kind: 'resolved', entity: liste[i - 1], method: 'previous', detected: prec[0] };
    return { kind: 'none' };
  }

  // 4. Démonstratifs typés — « ce document », « cette voiture ».
  const doc = m.match(DEMONSTRATIF_DOC);
  if (doc) {
    if (ctx.lastSelected?.type === 'document') return { kind: 'resolved', entity: ctx.lastSelected, method: 'demonstrative', detected: doc[0] };
    if (ctx.currentDocumentId) return { kind: 'resolved', entity: { type: 'document', id: ctx.currentDocumentId }, method: 'demonstrative', detected: doc[0] };
    const docs = derniere.filter((e) => e.type === 'document');
    const seul = unique(docs);
    if (seul) return { kind: 'resolved', entity: seul, method: 'demonstrative', detected: doc[0] };
    if (docs.length >= 2) return { kind: 'ambiguous', candidates: docs, detected: doc[0] };
    return { kind: 'none' };
  }
  const bien = demonstratifBien(m);
  if (bien) {
    if (ctx.lastSelected?.type === 'asset') return { kind: 'resolved', entity: ctx.lastSelected, method: 'demonstrative', detected: bien };
    if (ctx.currentAssetId) return { kind: 'resolved', entity: { type: 'asset', id: ctx.currentAssetId }, method: 'demonstrative', detected: bien };
    const biens = derniere.filter((e) => e.type === 'asset');
    const seul = unique(biens);
    if (seul) return { kind: 'resolved', entity: seul, method: 'demonstrative', detected: bien };
    if (biens.length >= 2) return { kind: 'ambiguous', candidates: biens, detected: bien };
    return { kind: 'none' };
  }

  // 5. Pronoms — « sa date », « celui-ci » : l'entité sélectionnée, ou
  //    l'unique entité présentée.
  const statut = inversionDeStatut(m, ctx);
  if (statut) return { kind: 'resolved', entity: ctx.lastSelected!, method: 'pronoun', detected: statut };
  const pron = m.match(PRONOM)?.[0] ?? m.match(PRONOM_STATUT)?.[0] ?? pronomDeChamp(m);
  if (pron) {
    if (ctx.lastSelected) return { kind: 'resolved', entity: ctx.lastSelected, method: 'pronoun', detected: pron };
    const seul = unique(derniere);
    if (seul) return { kind: 'resolved', entity: seul, method: 'pronoun', detected: pron };
    if (derniere.length >= 2) return { kind: 'ambiguous', candidates: derniere, detected: pron };
  }

  return { kind: 'none' };
}

/**
 * Contexte borné pour le modèle : messages utiles et référence résolue,
 * jamais l'historique brut du compte.
 */
export function formatConversationForPrompt(
  ctx: ThreadContext | null,
  resolved: { type: ReferencedType; id: number; label?: string | null } | null,
): string {
  if (!ctx || (ctx.messages.length === 0 && !resolved)) return '(nouvelle conversation, aucun échange précédent)';
  // Réponse portant une donnée sensible : jamais recopiée vers le modèle (8a AC10).
  const lignes = ctx.messages.map((x) => `${x.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${
    x.sensitive ? SENSITIVE_ANSWER_PLACEHOLDER : x.content.replace(/\s+/g, ' ').slice(0, 300)}`);
  if (resolved) lignes.push(`Référence résolue dans la question : ${resolved.type} ${resolved.label ? `« ${resolved.label} »` : `n°${resolved.id}`}`);
  return lignes.join('\n');
}
