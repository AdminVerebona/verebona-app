/**
 * CGVU — version du 25/09/2026 : médiation de la consommation.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE NOUVELLE VERSION, PAS UNE RETOUCHE DE LA VERSION 1
 *
 * La version 1 est publiée et figée (empreinte SHA-256, preuves
 * d'acceptation qui la référencent). La modifier casserait la preuve de ce
 * que chaque utilisateur a accepté. Le texte mis à jour est donc une
 * nouvelle version, créée en BROUILLON par `seed-cgvu-draft.ts`, relue puis
 * publiée depuis l'administration (§5, §6.1) — qui décide aussi si une
 * nouvelle acceptation est requise.
 *
 * Seul le §18.3 change (médiateur désigné : La Société Médiation
 * Professionnelle). La mention de la plateforme européenne de règlement en
 * ligne des litiges disparaît avec l'ancien paragraphe.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { CGVU_V1_BODY_HTML } from './cgvu-v1.content';

export const CGVU_2026_09_25_VERSION_CODE = '2026-09-25-v1';

export const CGVU_2026_09_25_CHANGE_SUMMARY =
  'Article 18.3 « Litige – Médiation de la consommation » : désignation du médiateur ' +
  '(La Société Médiation Professionnelle, Alteritae, 5 rue Salvaing, 12000 Rodez) et ' +
  'modalités de saisine. Aucune autre modification.';

export const CGVU_MEDIATION_HTML = `
      <h3>18.3. Litige – Médiation de la consommation</h3>
      <p>En cas de litige entre le Client et l’entreprise, ceux-ci s’efforceront de le résoudre à l’amiable (le Client adressera une réclamation écrite auprès du professionnel ou, le cas échéant, auprès du Service Relations Clientèle du professionnel).</p>
      <p>A défaut d’accord amiable ou en l’absence de réponse du professionnel dans un délai raisonnable d’un (1) mois, le Client consommateur au sens de l’article L.612-2 du code de la consommation a la possibilité de saisir gratuitement, si un désaccord subsiste, le médiateur compétent inscrit sur la liste des médiateurs établie par la Commission d’évaluation et de contrôle de la médiation de la consommation en application de l’article L.615-1 du code de la consommation, à savoir :</p>
      <p>La Société Médiation Professionnelle<br><a href="http://www.mediateur-consommation-smp.fr">http://www.mediateur-consommation-smp.fr</a><br>Alteritae, 5 rue Salvaing, 12000 Rodez</p>
`;

/** Corps : version 1, §18.3 remplacé (du titre 18.3 jusqu'au titre 19 exclu). */
export function buildCgvu20260925Body(v1: string = CGVU_V1_BODY_HTML): string {
  const start = v1.indexOf('<h3>18.3.');
  const end = v1.indexOf('<h2>19.', start);
  if (start < 0 || end < 0) throw new Error('CGVU v1 : §18.3 introuvable');
  // Conserve l'indentation de la ligne du titre 19.
  const lineStart = v1.lastIndexOf('\n', start) + 1;
  const endLine = v1.lastIndexOf('\n', end) + 1;
  return v1.slice(0, lineStart) + CGVU_MEDIATION_HTML.replace(/^\n/, '') + v1.slice(endLine);
}

export const CGVU_2026_09_25_BODY_HTML = buildCgvu20260925Body();
