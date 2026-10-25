/**
 * Pastille du Type d'un document (en-tête des tiroirs, desktop et mobile) —
 * lot 87D, ticket PO « Supprimer type en anglais / technique sur les
 * documents » (capture : pastille « BUILDING_PERMIT »).
 *
 * Libellé français du Type V2 ENREGISTRÉ (`documentTypeDisplayLabel`, lot
 * 86E) ; sans Type connu : « Type à compléter » ; type encore inconnu de
 * l'écran (document non chargé, `undefined`) : aucune pastille. Jamais un code
 * technique, quelle que soit la valeur reçue.
 */
import { Badge } from '@/components/ui/badge';
import { documentTypeDisplayLabel, MISSING_TYPE_LABEL } from '@/lib/referential/v2';
import { userFacingLabel } from '@/lib/referential/user-facing-labels';

export function documentTypeBadgeLabel(typeCode: string | null | undefined): string | null {
  if (typeCode === undefined) return null;
  return userFacingLabel(documentTypeDisplayLabel(typeCode), MISSING_TYPE_LABEL);
}

export function DocumentTypeBadge({ typeCode }: { typeCode: string | null | undefined }) {
  const label = documentTypeBadgeLabel(typeCode);
  if (!label) return null;
  return <Badge variant="outline" className="mt-1.5 text-xs" data-testid="document-type-badge">{label}</Badge>;
}
