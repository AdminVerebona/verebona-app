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

export type ReferencedType = 'asset' | 'document' | 'agenda_item';

export interface PresentedEntity {
  position: number;
  type: ReferencedType;
  id: number;
  label?: string | null;
}

export interface ThreadContext {
  conversationId: number;
  /** Jusqu'à 8 messages utiles du fil, du plus ancien au plus récent. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
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

const ORDINAUX: Array<[RegExp, number]> = [
  [/\b(premier|premiere|1er|1re|1ere)\b/, 1],
  [/\b(deuxieme|2e|2eme|second|seconde)\b/, 2],
  [/\b(troisieme|3e|3eme)\b/, 3],
  [/\b(quatrieme|4e|4eme)\b/, 4],
  [/\b(cinquieme|5e|5eme)\b/, 5],
  [/\b(dernier|derniere)\b/, -1],
];

const DEMONSTRATIF_DOC = /\b(ce|cet|cette)\s+(document|fichier|facture|contrat|devis|pdf|piece)\b/;
const DEMONSTRATIF_BIEN = /\b(ce|cet|cette)\s+(bien|maison|appartement|logement|voiture|vehicule|moto|bateau|velo|immeuble|terrain|objet)\b/;
const AUTRE = /\b(l'autre|l autre|pour l'autre|et l'autre)\b/;
const PRECEDENT = /\b(le precedent|la precedente|celui d'avant|celle d'avant)\b/;
const PRONOM = /\b(celui-ci|celle-ci|celui-la|celle-la|lui)\b|\b(sa|son|ses)\s+(date|montant|echeance|prix|titre|fournisseur|adresse|reference|numero|immatriculation|date d'achat)\b/;

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
  const bien = m.match(DEMONSTRATIF_BIEN);
  if (bien) {
    if (ctx.lastSelected?.type === 'asset') return { kind: 'resolved', entity: ctx.lastSelected, method: 'demonstrative', detected: bien[0] };
    if (ctx.currentAssetId) return { kind: 'resolved', entity: { type: 'asset', id: ctx.currentAssetId }, method: 'demonstrative', detected: bien[0] };
    const biens = derniere.filter((e) => e.type === 'asset');
    const seul = unique(biens);
    if (seul) return { kind: 'resolved', entity: seul, method: 'demonstrative', detected: bien[0] };
    if (biens.length >= 2) return { kind: 'ambiguous', candidates: biens, detected: bien[0] };
    return { kind: 'none' };
  }

  // 5. Pronoms — « sa date », « celui-ci » : l'entité sélectionnée, ou
  //    l'unique entité présentée.
  const pron = m.match(PRONOM);
  if (pron) {
    if (ctx.lastSelected) return { kind: 'resolved', entity: ctx.lastSelected, method: 'pronoun', detected: pron[0] };
    const seul = unique(derniere);
    if (seul) return { kind: 'resolved', entity: seul, method: 'pronoun', detected: pron[0] };
    if (derniere.length >= 2) return { kind: 'ambiguous', candidates: derniere, detected: pron[0] };
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
  const lignes = ctx.messages.map((x) => `${x.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${x.content.replace(/\s+/g, ' ').slice(0, 300)}`);
  if (resolved) lignes.push(`Référence résolue dans la question : ${resolved.type} ${resolved.label ? `« ${resolved.label} »` : `n°${resolved.id}`}`);
  return lignes.join('\n');
}
