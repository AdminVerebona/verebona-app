'use client';

/**
 * Drawer de classement — CDC V2.0 §5.1, §5.2, §7.4, §8.5, §8.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CHOIX D'UNE RUBRIQUE FILTRE LES TYPES, IMMÉDIATEMENT
 *
 * §5.1 : « Le choix d'une Rubrique filtre immédiatement les Types
 * disponibles. Si la Rubrique change et que le Type actuel n'est pas
 * compatible, le Type est vidé. »
 *
 * Le filtrage est fait ici, à partir du référentiel embarqué : aucun aller-
 * retour serveur n'est nécessaire, et un menu qui proposerait un Type
 * incompatible obligerait l'utilisateur à découvrir le refus après
 * enregistrement.
 *
 * ── « AUTRE » EST PROPOSÉ ICI, ET SEULEMENT ICI ───────────────────────────
 *
 * §5.2 : chaque Rubrique offre visuellement un Type « Autre », et seul
 * l'utilisateur peut le choisir. Il apparaît donc dans cette liste alors que
 * le prompt d'analyse ne le voit jamais (DOC-08). C'est la même règle vue des
 * deux côtés, pas une incohérence.
 *
 * ── « NON APPLICABLE » EST DANS LE DRAWER, JAMAIS SUR LA CARTE ────────────
 *
 * §7.4 : « Cette option n'apparaît jamais directement sur la carte À traiter ;
 * elle est proposée dans le drawer, près du champ concerné. » Elle n'est
 * offerte que si la règle l'autorise — jamais pour la Rubrique (§10.6).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from '@/components/ui/drawer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';
import {
  RUBRICS,
  getTypesForRubric,
  rubricOfType,
  type RubricCode,
} from '@/lib/referential/v2';
import { MICROCOPY } from '@/lib/referential/v2/microcopy';

/** Sentinelle du Select : une valeur vide n'est pas sélectionnable par Radix. */
const NO_TYPE = '__NONE__';

export interface DocumentClassificationDraft {
  /** Identifiant numérique, attendu par la suppression existante. */
  id?: number;
  publicId: string;
  title: string;
  rubricCode: string | null;
  documentTypeCode: string | null;
}

export function RubricClassificationDrawer({
  document,
  open,
  onOpenChange,
  onSaved,
  /** Champ sur lequel ouvrir, transmis par « Autre » ou « Compléter » (§8.5). */
  focusField,
  /** Action « À traiter » liée, si l'ouverture vient d'une carte. */
  actionPublicId,
  allowNotApplicable,
  onDelete,
}: {
  document: DocumentClassificationDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  focusField?: 'rubricCode' | 'documentTypeCode' | null;
  actionPublicId?: string | null;
  allowNotApplicable?: boolean;
  /** Suppression, confirmée ici même. Absente ⇒ le bouton n'est pas rendu. */
  onDelete?: () => void;
}) {
  const [rubricCode, setRubricCode] = useState<string | null>(null);
  const [typeCode, setTypeCode] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setRubricCode(document?.rubricCode ?? null);
    setTypeCode(document?.documentTypeCode ?? null);
    // Un « Confirmer » resté armé d'un document à l'autre supprimerait le
    // mauvais fichier au premier clic.
    setConfirmingDelete(false);
  }, [document]);

  const types = useMemo(
    () => (rubricCode ? getTypesForRubric(rubricCode as RubricCode) : []),
    [rubricCode],
  );

  /**
   * Changement de Rubrique.
   *
   * Le Type devenu incompatible est vidé DANS L'INTERFACE, avant même
   * l'enregistrement. Le serveur applique la même règle (§5.1) : la faire
   * aussi ici évite d'afficher un couple que l'enregistrement va défaire sans
   * prévenir.
   */
  const changeRubric = (next: string) => {
    setRubricCode(next);
    if (typeCode && rubricOfType(typeCode) !== next) setTypeCode(null);
  };

  /** Choisir un Type suffit : sa Rubrique est déduite (§2.2). */
  const changeType = (next: string) => {
    if (next === NO_TYPE) {
      setTypeCode(null);
      return;
    }
    setTypeCode(next);
    const deduced = rubricOfType(next);
    if (deduced) setRubricCode(deduced);
  };

  const save = async () => {
    if (!document) return;
    setSaving(true);
    try {
      await apiClient.patch(`/api/v2/documents/${document.publicId}/classification`, {
        rubricCode,
        documentTypeCode: typeCode,
      });
      toast.success('Classement enregistré.');
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error('Le classement n’a pas pu être enregistré.');
    } finally {
      setSaving(false);
    }
  };

  const markNotApplicable = async () => {
    if (!actionPublicId) return;
    try {
      await apiClient.post(`/api/v2/to-process/${actionPublicId}/resolve`, {
        mode: 'not_applicable',
      });
      toast.success('Noté comme non applicable.');
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error('L’action n’a pas pu être clôturée.');
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="truncate">{document?.title ?? 'Document'}</DrawerTitle>
        </DrawerHeader>

        <div className="space-y-5 px-4 pb-2">
          <div className="space-y-2">
            <Label htmlFor="rubric">Rubrique</Label>
            <Select value={rubricCode ?? undefined} onValueChange={changeRubric}>
              <SelectTrigger
                id="rubric"
                autoFocus={focusField === 'rubricCode'}
                className="w-full"
              >
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

          <div className="space-y-2">
            <Label htmlFor="type">Type</Label>
            <Select
              value={typeCode ?? NO_TYPE}
              onValueChange={changeType}
              // §5.1 : enregistrer une Rubrique sans Type reste valide, mais
              // choisir un Type sans Rubrique n'a pas de sens — sa Rubrique
              // serait déduite et écraserait le choix en cours.
              disabled={!rubricCode}
            >
              <SelectTrigger
                id="type"
                autoFocus={focusField === 'documentTypeCode'}
                className="w-full"
              >
                <SelectValue placeholder="Type à compléter" />
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

          {/* §7.4 : proposé près du champ, jamais sur la carte. */}
          {allowNotApplicable && actionPublicId && (
            <Button variant="ghost" size="sm" onClick={markNotApplicable} className="px-0">
              {MICROCOPY.notApplicable}
            </Button>
          )}
        </div>

        <DrawerFooter>
          {onDelete && (
            // Confirmation en deux temps, dans le bouton lui-même : une boîte
            // de dialogue par-dessus un drawer empile deux surfaces modales,
            // et la seconde se ferme souvent en fermant la première.
            <Button
              variant={confirmingDelete ? 'destructive' : 'ghost'}
              onClick={() => (confirmingDelete ? onDelete() : setConfirmingDelete(true))}
              disabled={saving}
            >
              {confirmingDelete ? 'Confirmer la suppression' : 'Supprimer le document'}
            </Button>
          )}
          <Button onClick={save} disabled={saving}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
