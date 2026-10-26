/**
 * Texte et contenu de la notification de fin de lot — sans dépendance, pour
 * être lu à la fois par l'émetteur (lot-notification.ts), le catalogue des
 * notifications et la cloche, sans import circulaire.
 */

/** Document analysé, tel que la notification le nomme et l'ouvre. */
export interface LotDocument {
  assetFileId: number;
  title: string;
}

/** Au-delà, la notification cite les premiers et compte les autres. */
export const LOT_DOCUMENTS_MAX = 5;

/**
 * ══════════════════════════════════════════════════════════════════════════
 * NOMMER LE DOCUMENT, PAS COMPTER LES FICHIERS
 *
 * « Analyse terminée — 1 document(s) analysé(s) » ne disait ni lequel, ni où
 * le trouver, et le clic menait à la liste des documents. La notification
 * porte désormais le titre retenu et l'identifiant du document : un seul
 * document → « Le document “Titre” a été analysé », et le clic ouvre son
 * tiroir. Toujours UNE notification par lot (§7.2).
 * ══════════════════════════════════════════════════════════════════════════
 */
export function lotNotificationPayload(
  lotId: number,
  analysedCount: number,
  documents: LotDocument[],
): {
  lotId: number; analysedCount: number; failedCount: number;
  assetFileId?: number; documentTitle?: string; documents?: LotDocument[];
} {
  const docs = documents.filter((d) => d.title.trim()).slice(0, LOT_DOCUMENTS_MAX);
  const payload = { lotId, analysedCount, failedCount: 0 };
  if (analysedCount === 1 && docs.length >= 1) {
    return { ...payload, assetFileId: docs[0].assetFileId, documentTitle: docs[0].title, documents: docs.slice(0, 1) };
  }
  return docs.length ? { ...payload, documents: docs } : payload;
}

/** Texte de la notification — partagé par le catalogue (push) et la cloche. */
export function lotNotificationText(p: {
  analysedCount?: number; documentTitle?: string; documents?: LotDocument[];
}): string {
  const n = p.analysedCount ?? p.documents?.length ?? 0;
  if (n <= 1 && p.documentTitle) return `Le document “${p.documentTitle}” a été analysé`;
  const titres = (p.documents ?? []).map((d) => `“${d.title}”`);
  if (titres.length === 0) return n <= 1 ? 'Votre document a été analysé' : `${n} documents ont été analysés`;
  const autres = n - titres.length;
  return `${n} documents ont été analysés : ${titres.join(', ')}${autres > 0 ? ` et ${autres} autre${autres > 1 ? 's' : ''}` : ''}`;
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 81E — RÉSULTAT RÉEL DU LOT : RÉUSSITE, RÉUSSITE PARTIELLE, ÉCHEC
//
// Le résultat est établi depuis les états PERSISTÉS des documents
// (`lot-notification.ts`), jamais depuis un compteur. Un doublon ou un
// regroupement légitime n'est pas un échec ; une analyse encore en cours ou
// reprise automatiquement n'est pas présentée comme définitive. Textes
// partagés par le catalogue (cloche, push) et la cloche (lignes existantes).
// ══════════════════════════════════════════════════════════════════════════

/** Action réellement possible après un échec d'analyse (tiroir du document). */
export const ANALYSIS_RETRY_ACTION = 'Vous pouvez relancer l’analyse depuis la fiche du document, dans Documents.';

export type LotOutcomeType = 'DOCUMENT_BATCH_COMPLETED' | 'DOCUMENT_BATCH_PARTIALLY_FAILED' | 'DOCUMENT_BATCH_FAILED';

/** Contenu d'une notification d'échec (total ou partiel) d'un lot. */
interface LotFailurePayload {
  lotId: number;
  analysedCount: number;
  failedCount: number;
  /** Documents qui n'ont pas pu être analysés (nommés). */
  documents?: LotDocument[];
  /** Un seul document en échec : il s'ouvre en tiroir. */
  assetFileId?: number;
}

/** Charge utile d'un lot en échec total ou partiel (pure). */
export function lotFailurePayload(lotId: number, analysedCount: number, failed: LotDocument[]): LotFailurePayload {
  const docs = failed.filter((d) => d.title.trim()).slice(0, LOT_DOCUMENTS_MAX);
  return {
    lotId, analysedCount, failedCount: failed.length,
    ...(docs.length ? { documents: docs } : {}),
    ...(failed.length === 1 ? { assetFileId: failed[0].assetFileId } : {}),
  };
}

function titres(docs: LotDocument[] | undefined, total: number): string {
  const t = (docs ?? []).filter((d) => d?.title?.trim()).map((d) => `“${d.title}”`);
  if (t.length === 0) return '';
  const autres = total - t.length;
  return ` : ${t.join(', ')}${autres > 0 ? ` et ${autres} autre${autres > 1 ? 's' : ''}` : ''}`;
}

/** Texte d'un lot partiellement en échec (cloche, catalogue). */
export function lotPartialFailureText(p: Partial<LotFailurePayload>): string {
  const ok = p.analysedCount ?? 0;
  const ko = p.failedCount ?? p.documents?.length ?? 0;
  const analyses = `${ok} document${ok > 1 ? 's' : ''} analysé${ok > 1 ? 's' : ''}`;
  const echecs = ko > 1 ? `${ko} n’ont pas pu l’être` : `${ko} n’a pas pu l’être`;
  return `${analyses}, ${echecs}${titres(p.documents, ko)}. ${ANALYSIS_RETRY_ACTION}`;
}

/** Texte d'un lot entièrement en échec (cloche, catalogue). */
export function lotFailureText(p: Partial<LotFailurePayload>): string {
  const ko = p.failedCount ?? p.documents?.length ?? 0;
  const docs = (p.documents ?? []).filter((d) => d?.title?.trim());
  if (ko <= 1) {
    return docs.length
      ? `Le document “${docs[0].title}” n’a pas pu être analysé. ${ANALYSIS_RETRY_ACTION}`
      : `Votre document n’a pas pu être analysé. ${ANALYSIS_RETRY_ACTION}`;
  }
  return `${ko} documents n’ont pas pu être analysés${titres(docs, ko)}. ${ANALYSIS_RETRY_ACTION}`;
}
