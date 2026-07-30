/**
 * Rendu HTML figé d'une version de CGVU — CDC 7 §13 et §16.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE FICHIER EST PUREMENT FONCTIONNEL, ET CE N'EST PAS UN DÉTAIL
 *
 * Le §13 exige que le fichier téléchargé « contienne exactement le même texte
 * que la page » et « ne dépende pas d'un appel API pour afficher son contenu
 * principal ». La seule façon d'en être certain est que la page servie et le
 * fichier téléchargé soient LE MÊME OCTET — celui figé à la publication et
 * dont l'empreinte SHA-256 est enregistrée.
 *
 * Ce module produit donc une chaîne, une fois, à la publication. Il ne lit ni
 * base ni requête : il est testable intégralement, et la même entrée produit
 * toujours la même sortie — condition nécessaire pour qu'une empreinte ait un
 * sens.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface RenderVersionInput {
  /** Code de version, format `AAAA-MM-JJ-vN`. */
  versionCode: string;
  title: string;
  /** Corps du document, en HTML déjà structuré (h2, p, ul…). */
  bodyHtml: string;
  effectiveAt: Date;
  /** Résumé des modifications, affiché en tête (§8.3). */
  changeSummary?: string;
}

/** Libellé affiché du document. Une seule occurrence pour tout le dépôt. */
export const LEGAL_DOCUMENT_LABEL = 'Conditions générales de vente et d’utilisation';
export const LEGAL_DOCUMENT_SHORT_LABEL = 'CGVU';

/** Échappe le texte inséré dans les attributs et les nœuds de texte. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Date en français, sans dépendance à la locale du serveur. */
export function formatFrenchDate(date: Date): string {
  const months = [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
  ];
  // UTC : la date d'entrée en vigueur ne doit pas glisser d'un jour selon le
  // fuseau du serveur qui produit le fichier.
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Nom du fichier téléchargé (§13). */
export function buildDownloadFilename(versionCode: string): string {
  return `CGVU_Verebona_${versionCode}.html`;
}

/**
 * Feuille de style embarquée.
 *
 * Aucune ressource externe : le fichier doit rester lisible hors ligne (§13).
 * Les tailles sont en unités relatives pour que le zoom fonctionne (§16.4), et
 * la règle `@media print` retire la navigation pour une impression propre.
 */
const STYLESHEET = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1rem 4rem;
    font-family: Georgia, 'Times New Roman', serif;
    /* Contraste 13,6:1 sur blanc — au-delà du niveau AAA (§16.4). */
    color: #1a1a1a;
    background: #ffffff;
    line-height: 1.65;
    font-size: 1rem;
  }
  main { max-width: 46rem; margin: 0 auto; }
  header.doc-header {
    border-bottom: 2px solid #1a1a1a;
    padding-bottom: 1rem;
    margin-bottom: 2rem;
  }
  h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 0.5rem; }
  h2 { font-size: 1.25rem; margin: 2rem 0 0.75rem; }
  h3 { font-size: 1.05rem; margin: 1.5rem 0 0.5rem; }
  p, li { margin: 0 0 0.75rem; }
  ul, ol { padding-left: 1.5rem; }
  .doc-meta { font-size: 0.9rem; color: #40454d; margin: 0; }
  .doc-meta dt { font-weight: bold; display: inline; }
  .doc-meta dd { display: inline; margin: 0 1rem 0 0.25rem; }
  .doc-summary {
    background: #f4f6f8;
    border-left: 4px solid #40454d;
    padding: 0.75rem 1rem;
    margin: 1.5rem 0;
    font-size: 0.95rem;
  }
  .doc-actions { margin: 1.5rem 0 0; }
  .doc-actions button {
    font: inherit;
    font-size: 0.95rem;
    padding: 0.5rem 1rem;
    border: 1px solid #1a1a1a;
    background: #ffffff;
    color: #1a1a1a;
    cursor: pointer;
    border-radius: 4px;
  }
  .doc-actions button:focus-visible { outline: 3px solid #0b5fff; outline-offset: 2px; }
  footer.doc-footer {
    margin-top: 3rem; padding-top: 1rem;
    border-top: 1px solid #c3c8ce;
    font-size: 0.85rem; color: #40454d;
  }
  @media print {
    body { padding: 0; font-size: 11pt; }
    .doc-actions { display: none; }
    h2, h3 { page-break-after: avoid; }
    p, li { page-break-inside: avoid; }
  }
`.trim();

/**
 * Produit le document HTML autonome et figé.
 *
 * Le bouton « Imprimer » est le seul script de la page, et son absence
 * n'empêche pas la lecture : le contenu principal ne dépend d'aucun script ni
 * d'aucun appel réseau (§13).
 */
export function renderLegalVersionHtml(input: RenderVersionInput): string {
  const { versionCode, title, bodyHtml, effectiveAt, changeSummary } = input;
  const safeTitle = escapeHtml(title);
  const safeCode = escapeHtml(versionCode);
  const effective = formatFrenchDate(effectiveAt);

  const summaryBlock = changeSummary
    ? `      <section class="doc-summary" aria-label="Résumé des modifications">
        <strong>Résumé des modifications :</strong> ${escapeHtml(changeSummary)}
      </section>\n`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} — version ${safeCode}</title>
  <meta name="description" content="${escapeHtml(LEGAL_DOCUMENT_LABEL)} de Verebona, version ${safeCode}.">
  <meta name="robots" content="index, follow">
  <style>
${STYLESHEET}
  </style>
</head>
<body>
  <main>
    <header class="doc-header">
      <h1>${safeTitle}</h1>
      <dl class="doc-meta">
        <dt>Version</dt><dd>${safeCode}</dd>
        <dt>Entrée en vigueur</dt><dd>${escapeHtml(effective)}</dd>
      </dl>
      <p class="doc-meta">
        Cette page correspond exclusivement à la version ${safeCode}. Elle ne
        sera jamais modifiée. Vous pouvez l’enregistrer ou l’imprimer.
      </p>
      <p class="doc-actions">
        <button type="button" onclick="window.print()">Imprimer cette version</button>
      </p>
    </header>
${summaryBlock}    <article>
${bodyHtml}
    </article>

    <footer class="doc-footer">
      <p>
        Verebona — ${escapeHtml(LEGAL_DOCUMENT_LABEL)}, version ${safeCode},
        en vigueur à compter du ${escapeHtml(effective)}.
      </p>
    </footer>
  </main>
</body>
</html>
`;
}
