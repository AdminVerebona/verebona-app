"use client"

import { useEffect, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AlertTriangle, Loader2, Trash2 } from "lucide-react"
import { apiClient } from "@/lib/api-client"

export interface AssetDeletionSummary {
  documents: number
  photos: number
  deadlines: number
  events: number
  rooms: number
  equipments: number
}

interface DeleteAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Suppression confirmée : tout le contenu du bien part avec lui. */
  onConfirm: () => void
  assetId: number
  assetName: string
  isLoading?: boolean
}

const LABELS: Array<{ key: keyof AssetDeletionSummary; one: string; many: string }> = [
  { key: "documents", one: "document", many: "documents" },
  { key: "deadlines", one: "échéance", many: "échéances" },
  { key: "events", one: "événement", many: "événements" },
  { key: "photos", one: "photo", many: "photos" },
  { key: "rooms", one: "pièce", many: "pièces" },
  { key: "equipments", one: "équipement", many: "équipements" },
]

/** « 12 documents », « 1 échéance » — éléments à zéro omis. */
export function describeDeletionSummary(summary: AssetDeletionSummary): string[] {
  return LABELS.filter(({ key }) => summary[key] > 0).map(
    ({ key, one, many }) => `${summary[key]} ${summary[key] > 1 ? many : one}`,
  )
}

/**
 * Confirmation de suppression d'un bien — règle produit : TOUT est supprimé.
 *
 * Le dialogue annonce, chiffres à l'appui (GET /api/assets/[id]/deletion-summary),
 * ce que la suppression emportera : documents, échéances, événements, photos,
 * pièces, équipements. Aucune option « conserver les documents » : l'API n'en
 * a jamais appliqué aucune (anciens `keepDocuments` / `keepEvents`, retirés).
 * Les fichiers stockés sont purgés ensuite. L'action est irréversible.
 */
export function DeleteAssetDialog({
  open,
  onOpenChange,
  onConfirm,
  assetId,
  assetName,
  isLoading = false,
}: DeleteAssetDialogProps) {
  const [summary, setSummary] = useState<AssetDeletionSummary | null>(null)
  const [summaryState, setSummaryState] = useState<"idle" | "loading" | "ready" | "error">("idle")

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSummary(null)
    setSummaryState("loading")
    apiClient
      .get<AssetDeletionSummary>(`/api/assets/${assetId}/deletion-summary`)
      .then((data) => {
        if (cancelled) return
        setSummary(data)
        setSummaryState("ready")
      })
      .catch(() => {
        if (!cancelled) setSummaryState("error")
      })
    return () => {
      cancelled = true
    }
  }, [open, assetId])

  const items = summary ? describeDeletionSummary(summary) : []

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <Trash2 className="w-5 h-5 text-destructive mt-1 flex-shrink-0 btn-delete-trash-icon" />
            <div>
              <AlertDialogTitle>Supprimer le bien &quot;{assetName}&quot; ?</AlertDialogTitle>
              <AlertDialogDescription className="mt-2">
                Le bien et tout ce qui lui est rattaché seront supprimés définitivement.
                Cette action est irréversible.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-2">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            Seront également supprimés
          </div>
          {summaryState === "loading" && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Calcul des éléments concernés…
            </p>
          )}
          {summaryState === "ready" && items.length > 0 && (
            <ul className="list-disc pl-5 text-foreground" data-testid="asset-deletion-summary">
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {summaryState === "ready" && items.length === 0 && (
            <p className="text-muted-foreground">
              Aucun document, échéance ni autre élément n&apos;est rattaché à ce bien.
            </p>
          )}
          {summaryState === "error" && (
            <p className="text-muted-foreground">
              Le décompte n&apos;a pas pu être chargé. Tous les documents, photos, échéances,
              événements, pièces et équipements du bien seront néanmoins supprimés.
            </p>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Pour garder un document, téléchargez-le avant de supprimer le bien.
        </p>

        <div className="flex gap-2 justify-end pt-4 border-t">
          <AlertDialogCancel disabled={isLoading}>Annuler</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isLoading || summaryState === "loading"}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 btn-delete border-0"
          >
            {isLoading ? "Suppression en cours..." : "Supprimer définitivement"}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
