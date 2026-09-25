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

