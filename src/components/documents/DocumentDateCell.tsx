/**
 * Cellule « date du document » d'une ligne de liste — lot 108D.
 *
 * Contrat unique (`@/lib/documents/document-row-date`) : la date métier du
 * document (`documentDate`), au format court français, ou « – ». Jamais la
 * date d'ajout. Sans hook : appelable comme une fonction dans les tests.
 *
 * Accessibilité : un élément `<time datetime>` porte la date ; le nom
 * accessible dit ce qu'est cette date (« Date du document : 20 décembre
 * 2025 », ou « Date du document non renseignée » pour « – », que les lecteurs
 * d'écran ne lisent pas utilement).
 *
 * Alignement : largeur fixe, texte aligné à droite, chiffres tabulaires — les
 * dates et « – » restent en colonne, titres longs compris, sur ordinateur et
 * sur téléphone.
 */
import { documentRowDate } from '@/lib/documents/document-row-date';

export function DocumentDateCell({
  value,
  className = '',
  'data-testid': testId = 'document-row-date',
}: {
  value: string | null | undefined;
  className?: string;
  'data-testid'?: string;
}) {
  const d = documentRowDate(value);
  return (
    <span
      className={`shrink-0 whitespace-nowrap text-right tabular-nums ${className}`}
      data-testid={testId}
      data-document-date={d.dateTime ?? ''}
    >
      <span className="sr-only">{d.ariaLabel}</span>
      {d.dateTime ? (
        <time dateTime={d.dateTime} aria-hidden>{d.label}</time>
      ) : (
        <span aria-hidden>{d.label}</span>
      )}
    </span>
  );
}
