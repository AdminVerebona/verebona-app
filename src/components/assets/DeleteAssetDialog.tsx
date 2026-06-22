"use client"

import { useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Trash2, File, Calendar } from "lucide-react"

interface DeleteAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (deleteRelated: { documents: boolean; events: boolean }) => void
  assetName: string
  isLoading?: boolean
}

export function DeleteAssetDialog({
  open,
  onOpenChange,
  onConfirm,
  assetName,
  isLoading = false,
}: DeleteAssetDialogProps) {
  const [keepDocuments, setKeepDocuments] = useState(false)
  const [keepEvents, setKeepEvents] = useState(false)

  const handleConfirm = () => {
    onConfirm({
      documents: !keepDocuments,
      events: !keepEvents,
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <Trash2 className="w-5 h-5 text-destructive mt-1 flex-shrink-0 btn-delete-trash-icon" />
            <div>
              <AlertDialogTitle>Supprimer le bien "{assetName}" ?</AlertDialogTitle>
              <AlertDialogDescription className="mt-2">
                Cette action est irréversible. Le bien sera supprimé définitivement.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            Vos documents et événements associés peuvent être conservés. Que souhaitez-vous faire ?
          </p>

          <div className="space-y-3 pl-2">
            <div className="flex items-center gap-3 p-2 rounded hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setKeepDocuments(!keepDocuments)}>
              <Checkbox
                id="keep-docs"
                checked={keepDocuments}
                onCheckedChange={(checked) => setKeepDocuments(checked as boolean)}
                disabled={isLoading}
              />
              <Label htmlFor="keep-docs" className="font-medium text-sm cursor-pointer flex items-center gap-2">
                <File className="w-4 h-4" />
                Conserver les documents
              </Label>
            </div>

            <div className="flex items-center gap-3 p-2 rounded hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => setKeepEvents(!keepEvents)}>
              <Checkbox
                id="keep-events"
                checked={keepEvents}
                onCheckedChange={(checked) => setKeepEvents(checked as boolean)}
                disabled={isLoading}
              />
              <Label htmlFor="keep-events" className="font-medium text-sm cursor-pointer flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Conserver les événements
              </Label>
            </div>
          </div>
        </div>

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
