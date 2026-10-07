/**
 * Notification « envoi réussi » (lot 32, décision PO Q18/Q19) — module PUR,
 * partagé par le catalogue (serveur) et la cloche (client).
 */
/** Titre et texte de la notification (une par lot d'envoi). */
export function uploadNotificationText(p: { count: number; documentTitle?: string; kind?: 'file' | 'web_link' }): { title: string; body: string } {
  if (p.count > 1) {
    return { title: 'Documents ajoutés', body: `${p.count} documents ont bien été ajoutés.` };
  }
  const nom = p.documentTitle ? `« ${p.documentTitle} »` : null;
  if (p.kind === 'web_link') {
    return { title: 'Lien web ajouté', body: nom ? `Le lien ${nom} a bien été ajouté.` : 'Votre lien web a bien été ajouté.' };
  }
  return { title: 'Document ajouté', body: nom ? `${nom} a bien été ajouté.` : 'Votre document a bien été ajouté.' };
}

