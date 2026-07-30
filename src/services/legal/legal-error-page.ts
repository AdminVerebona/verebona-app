/**
 * Page d'erreur des documents légaux — CDC 7 §16.3 et §18.
 *
 * Le §16.3 impose de « retourner une page explicite en cas d'incident » et de
 * « ne jamais rediriger silencieusement vers une version plus récente ». Le
 * §18 le redit pour le cas d'un fichier versionné indisponible : « ne jamais
 * rediriger vers la version courante ; retourner une erreur spécifique ».
 *
 * D'où cette page : elle explique ce qui manque, propose la version courante
 * comme LIEN — un choix laissé à l'utilisateur — et ne substitue jamais un
 * document à un autre.
 */
import { escapeHtml } from './legal-html.renderer';

export interface LegalErrorPageInput {
  title: string;
  message: string;
  /** Code demandé, affiché pour que l'utilisateur sache ce qui a échoué. */
  requestedVersion?: string;
  /** Proposé en lien, jamais servi à la place du document demandé. */
  offerCurrentLink?: boolean;
}

export function renderLegalErrorPage(input: LegalErrorPageInput): string {
  const currentLink = input.offerCurrentLink
    ? `      <p>
        <a href="/cgvu">Consulter la version actuellement en vigueur</a>
      </p>
      <p class="warn">
        Attention : cette version peut différer de celle que vous recherchez.
        Elle ne la remplace pas.
      </p>\n`
    : '';

  const requested = input.requestedVersion
    ? `      <p class="requested">Version demandée : <code>${escapeHtml(input.requestedVersion)}</code></p>\n`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <meta name="robots" content="noindex">
  <style>
    body {
      margin: 0; padding: 3rem 1rem;
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      color: #1a1a1a; background: #ffffff; line-height: 1.6;
    }
    main { max-width: 34rem; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin: 0 0 1rem; }
    code { background: #f4f6f8; padding: 0.1rem 0.35rem; border-radius: 3px; }
    .warn { font-size: 0.9rem; color: #7a4a00; }
    .requested { font-size: 0.95rem; color: #40454d; }
    a { color: #0b5fff; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.message)}</p>
${requested}${currentLink}    <p><a href="/">Retour à l’accueil</a></p>
  </main>
</body>
</html>
`;
}
