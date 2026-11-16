/**
 * Dépôt d'un fichier demandé depuis l'Assistant — Trello #753, CDC T2 §9.2 (« Document »), §14.3 W11
 * (`CMD_PREPARE_FILE_UPLOAD`), §14.4 « Documents », M27, porte P2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT NE FABRIQUE PAS UN FICHIER : IL OUVRE LE PARCOURS DE DÉPÔT
 *
 * Un dépôt exige un fichier réel, choisi par l'utilisateur sur son appareil.
 * L'Assistant ne peut donc pas l'exécuter lui-même (exception d'interaction du
 * CDC) : à « Dépose une facture pour la Clio », il résout le bien dans le
 * compte et propose le bouton EXISTANT « Ajouter un document », qui ouvre la
 * fenêtre de dépôt de l'application avec ce bien présélectionné. Le dépôt, ses
 * contrôles (droits, quota de documents, formats, analyse) et son écriture
 * restent ceux de ce parcours : aucun faux dépôt, aucun document créé ici,
 * aucune règle ajoutée.
 *
 * Reconnaissance SANS modèle, étroite : verbe à l'impératif en tête (ou
 * demande polie) immédiatement suivi d'un nom de fichier. « Ajouter un
 * document », « Comment déposer une facture ? » restent des demandes d'aide ;
 * « Ajoute le lien https://… » et « Ajoute la note … au document … » restent
 * les commandes déjà livrées (elles sont reconnues avant).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { plain } from '../core/routing-text';
import type { AssistantRequestInput } from '../types/contracts';
import { debutUtile } from './parser';

/** Brouillon d'une demande de dépôt : rien n'est lu ni écrit ici. */
export interface UploadDraft {
  /** Mots désignant le bien (« pour la Clio »). */
  assetWords: string[];
  /** Bien de la page ou de la conversation (« pour ce bien », ou aucun bien nommé). */
  assetFromContext: boolean;
}

const VERBE = String.raw`(?:ajoute|depose|televerse|importe|charge|joins|envoie)`;
const VERBE_POLI = String.raw`(?:ajouter|deposer|televerser|importer|charger|joindre|envoyer)`;
const DET = String.raw`(?:un|une|des|le|la|les|l'|ce|cet|cette|ces|mon|ma|mes)`;
/** Noms qui désignent un FICHIER à déposer (pas un contrat ou une garantie à enregistrer, ni un lien web). */
const FICHIER = String.raw`(?:documents?|fichiers?|factures?|justificatifs?|pieces? jointes?|photos?|scans?|pdf)`;
const DEBUT = (verbe: string) => new RegExp(String.raw`^${verbe}(?:[- ](?:moi|nous))?\s+${DET}\s*(?:nouveau\s+|nouvelle\s+|nouveaux\s+|nouvelles\s+)?${FICHIER}\b(?!\s+web\b)`);

const MOTS_VIDES = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'mon', 'ma', 'mes', 'notre', 'votre', 'bien', 'stp', 'svp', 'merci']);
const motsBien = (s: string) => plain(s).split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !MOTS_VIDES.has(w) && !/^\d+$/.test(w)).slice(0, 4);

/**
 * « Dépose une facture pour la Clio », « Ajoute un document », « Téléverse la facture du garage pour la maison »,
 * « Peux-tu importer un fichier pour ce bien ? » (pure, testée). `null` : pas une demande de dépôt.
 */
export function parseUploadRequest(message: string): UploadDraft | null {
  const entier = plain(message).trim();
  const debut = debutUtile(entier);
  const poli = debut > 0;
  const m = entier.slice(debut).replace(/\s+/g, ' ').trim();
  // Une question n'est jamais une demande de dépôt ; l'infinitif seul (« Ajouter un document ») reste une demande d'aide.
  if (/\?\s*$/.test(m) && !poli) return null;
  const tete = m.match(DEBUT(VERBE)) ?? (poli ? m.match(DEBUT(VERBE_POLI)) : null);
  if (!tete) return null;
  const reste = m.slice(tete[0].length).replace(/[.!?]+\s*$/, '').trim();
  // Un lien, une note ou un rattachement relèvent d'autres commandes (reconnues avant celle-ci).
  if (/https?:\/\/|\bwww\./.test(m) || /\b(?:note|notes|commentaire|description|lien)\b/.test(reste)) return null;
  // Le bien : le DERNIER complément « pour / sur / dans … » ; « de … » qualifie le fichier (« la facture du garage »).
  const pour = reste.match(/^(?:.*\s)?(?:pour|sur|dans)\s+(?:(ma|mon|mes|la|le|les|l'|notre|votre|ce|cet|cette)\s*)?([a-z0-9' -]+)$/);
  if (!pour) return { assetWords: [], assetFromContext: true };
  if (/^(?:ce|cet|cette)$/.test(pour[1] ?? '')) return { assetWords: [], assetFromContext: true };
  const mots = motsBien(pour[2]);
  return mots.length ? { assetWords: mots, assetFromContext: false } : { assetWords: [], assetFromContext: true };
}

/** Accès aux biens du compte (mêmes lectures que les commandes). */
export interface UploadDeps {
  findAssets(accountId: number, words: string[]): Promise<Array<{ id: number; name: string; city?: string | null }>>;
  getAsset(accountId: number, id: number): Promise<{ id: number; name: string } | null>;
}

/** Réponse à une demande de dépôt. */
export interface UploadAnswer {
  /** `open` : le bouton de dépôt est proposé ; `need_info` : précision demandée, aucun bouton. */
  kind: 'open' | 'need_info';
  message: string;
  /** Bien présélectionné dans la fenêtre de dépôt ; `null` : aucun (l'utilisateur le choisit dans la fenêtre). */
  assetId: number | null;
}

const nomBien = (a: { name: string; city?: string | null }) => (a.city ? `${a.name} (${a.city})` : a.name);

/** Libellé du bouton existant qui ouvre la fenêtre de dépôt (`action-resolver`, START_ADD_DOCUMENT). */
export const UPLOAD_BUTTON_LABEL = 'Ajouter un document';

export const uploadMessage = (bien: string | null) =>
  (bien
    ? `Pour déposer un document pour ${bien}, choisissez le fichier avec le bouton « ${UPLOAD_BUTTON_LABEL} » ci-dessous.`
    : `Pour déposer un document, choisissez le fichier avec le bouton « ${UPLOAD_BUTTON_LABEL} » ci-dessous. Vous indiquerez le bien concerné dans la fenêtre de dépôt.`);

/**
 * Traite une demande de dépôt : `null` si le message n'en est pas une. Jamais un bien choisi au hasard : plusieurs
 * biens → question ; bien nommé introuvable → aucun bien présélectionné (il se choisit dans la fenêtre de dépôt).
 */
export async function answerUploadRequest(input: AssistantRequestInput, deps: UploadDeps): Promise<UploadAnswer | null> {
  const draft = parseUploadRequest(input.message);
  if (!draft) return null;
  if (draft.assetWords.length) {
    const found = await deps.findAssets(input.accountId, draft.assetWords);
    if (found.length > 1) {
      return { kind: 'need_info', assetId: null, message: `Plusieurs biens correspondent : ${found.slice(0, 5).map(nomBien).join(', ')}. Précisez lequel dans votre demande.` };
    }
    return found.length === 1
      ? { kind: 'open', assetId: found[0].id, message: uploadMessage(found[0].name) }
      : { kind: 'open', assetId: null, message: uploadMessage(null) };
  }
  const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
  const bien = id ? await deps.getAsset(input.accountId, id) : null;
  return { kind: 'open', assetId: bien?.id ?? null, message: uploadMessage(bien?.name ?? null) };
}

/** Accès de production : biens du compte, par les lectures des commandes. */
export async function sqlUploadDeps(): Promise<UploadDeps> {
  const { sqlLookup } = await import('./plan.service');
  return { findAssets: (a, w) => sqlLookup.findAssets(a, w), getAsset: (a, id) => sqlLookup.getAsset(a, id) };
}
