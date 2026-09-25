"use client"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Trash2 } from "lucide-react"

interface DeleteAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (deleteRelated: { documents: boolean; events: boolean }) => void
  assetName: string
  isLoading?: boolean
}

/**
 * Confirmation de suppression d'un bien — GAP-05 (CDC Centre d'aide §14).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CASE « CONSERVER LES DOCUMENTS » NE CONSERVAIT RIEN
 *
 * Le dialogue proposait « Conserver les documents » et « Conserver les
 * événements ». Or `DELETE /api/assets?id=` supprime la ligne `assets` et,
 * par les clés étrangères `ON DELETE CASCADE`, tous les fichiers
 * (`asset_files`), événements et échéances du bien ; ses branches
 * `keepDocuments` / `keepEvents` sont vides, et la page appelante ne
 * transmettait même pas le choix. L'utilisateur qui cochait la case perdait
 * ses documents en croyant les garder.
 *
 * Le message décrit donc la règle réellement appliquée. Si le produit arrête
 * une règle de conservation (GAP-05), elle devra d'abord exister dans l'API
 * avant de réapparaître ici. `onConfirm` garde sa signature (tout supprimé).
 * ══════════════════════════════════════════════════════════════════════════
 */
export function DeleteAssetDialog({
  open,
  onOpenChange,
  onConfirm,
  assetName,
  isLoading = false,
}: DeleteAssetDialogProps) {
  const handleConfirm = () => {
    onConfirm({ documents: true, events: true })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <Trash2 className="w-5 h-5 text-destructive mt-1 flex-shrink-0 btn-delete-trash-icon" />
            <div>
              <AlertDialogTitle>Supprimer le bien &quot;{assetName}&quot; ?</AlertDialogTitle>
              <AlertDialogDescription className="mt-2">
                Cette action est irréversible. Le bien sera supprimé définitivement, ainsi que ses documents, photos, événements et échéances.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <p className="text-sm text-muted-foreground py-4">
          Pour garder un document, téléchargez-le avant de supprimer le bien.
        </p>

        <div className="flex gap-2 justify-end pt-4 border-t">
          <AlertDialogCancel disabled={isLoading}>Annuler</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isLoading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 btn-delete border-0"
          >
            {isLoading ? "Suppression en cours..." : "Supprimer le bien"}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
