'use client';

/**
 * Champs Rubrique + Type — CDC V2.0 §5.1, §5.2, §2.2.
 *
 * Repris de l'ancien tiroir « Classer » (RubricClassificationDrawer, ouvert
 * par le bas) pour être intégré au tiroir document, qui s'ouvre à droite :
 * un seul endroit pour modifier un document.
 *
 * Règles conservées à l'identique :
 *   - le choix d'une Rubrique filtre immédiatement les Types disponibles, et
 *     un Type devenu incompatible est vidé (§5.1) ;
 *   - choisir un Type suffit : sa Rubrique est déduite (§2.2) ;
 *   - « Autre » est proposé à l'utilisateur, jamais à l'IA (§5.2) ;
 *   - une Rubrique sans Type reste un classement valide.
 */

import { useMemo } from 'react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RUBRICS,
  getRubric,
  getDocumentType,
  getTypesForRubric,
  rubricOfType,
  type RubricCode,
} from '@/lib/referential/v2';
import { MICROCOPY } from '@/lib/referential/v2/microcopy';

/** Sentinelle du Select : une valeur vide n'est pas sélectionnable par Radix. */
const NO_TYPE = '__NONE__';

export interface RubricTypeValue {
  rubricCode: string | null;
  documentTypeCode: string | null;
}

/** Rubrique effective : celle enregistrée, sinon déduite du Type (§2.2). */
export function effectiveRubric(value: RubricTypeValue): string | null {
  return value.rubricCode ?? (value.documentTypeCode ? rubricOfType(value.documentTypeCode) : null);
}

/** Libellés lisibles pour l'affichage en lecture. */
export function rubricTypeLabels(value: RubricTypeValue): { rubric: string | null; type: string | null } {
  const rubric = effectiveRubric(value);
  const type = value.documentTypeCode
    ? getDocumentType(value.documentTypeCode as never)?.label ?? null
    : null;
  return { rubric: rubric ? getRubric(rubric)?.label ?? null : null, type };
}

export function RubricTypeFields({
  value,
  onChange,
  disabled,
  idPrefix = 'doc',
}: {
  value: RubricTypeValue;
  onChange: (next: RubricTypeValue) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const rubricCode = effectiveRubric(value);
  const typeCode = value.documentTypeCode;

  const types = useMemo(
    () => (rubricCode ? getTypesForRubric(rubricCode as RubricCode) : []),
    [rubricCode],
  );

  const changeRubric = (next: string) => {
    const typeCompatible = typeCode && rubricOfType(typeCode) === next;
    onChange({ rubricCode: next, documentTypeCode: typeCompatible ? typeCode : null });
  };

  const changeType = (next: string) => {
    if (next === NO_TYPE) {
      onChange({ rubricCode, documentTypeCode: null });
      return;
    }
    onChange({ rubricCode: rubricOfType(next) ?? rubricCode, documentTypeCode: next });
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-rubric`} className="text-xs">Rubrique</Label>
        <Select value={rubricCode ?? undefined} onValueChange={changeRubric} disabled={disabled}>
          <SelectTrigger id={`${idPrefix}-rubric`} className="w-full">
            <SelectValue placeholder={MICROCOPY.unfiledZone} />
          </SelectTrigger>
          <SelectContent>
            {RUBRICS.map((rubric) => (
              <SelectItem key={rubric.code} value={rubric.code}>
                {rubric.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-type`} className="text-xs">Type</Label>
        <Select
          value={typeCode ?? NO_TYPE}
          onValueChange={changeType}
          // Choisir un Type sans Rubrique n'a pas de sens : sa Rubrique serait
          // déduite et écraserait le choix en cours.
          disabled={disabled || !rubricCode}
        >
          <SelectTrigger id={`${idPrefix}-type`} className="w-full">
            <SelectValue placeholder={MICROCOPY.missingType} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TYPE}>Aucun type</SelectItem>
            {types.map((type) => (
              <SelectItem key={type.code} value={type.code}>
                {type.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!typeCode && rubricCode && (
          <p className="text-xs text-muted-foreground">
            Un document peut rester dans sa rubrique sans type.
          </p>
        )}
      </div>
    </div>
  );
}
