"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, Trash2 } from "lucide-react"
import { apiClient } from "@/lib/api-client"

/** Inventaire de la suppression définitive (GET /api/assets/[id]/deletion-summary) — carte #849. */
export interface AssetDeletionSummary {
  documents: number
  photos: number
  deadlines: number
  events: number
  rooms: number
  equipments: number
  documentVersions?: number
  agendaItems?: number
  operations?: number
  expenses?: number
  exports?: number
  shared?: { documents: number; agendaItems: number; operations: number; deadlines: number; events: number }
  fingerprint?: string
}

interface DeleteAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Suppression confirmée : reçoit l'empreinte de l'inventaire affiché (exigée par le serveur). */
  onConfirm: (inventoryFingerprint: string) => void
  assetId: number
  assetName: string
  isLoading?: boolean
}

type Noun = { key: keyof AssetDeletionSummary; one: string; many: string }

const LABELS: Noun[] = [
  { key: "documents", one: "document", many: "documents" },
  { key: "documentVersions", one: "version de document", many: "versions de documents" },
  { key: "deadlines", one: "échéance", many: "échéances" },
  { key: "events", one: "événement", many: "événements" },
  { key: "photos", one: "photo", many: "photos" },
  { key: "rooms", one: "pièce", many: "pièces" },
  { key: "equipments", one: "équipement", many: "équipements" },
  { key: "operations", one: "Opération", many: "Opérations" },
  { key: "expenses", one: "dépense", many: "dépenses" },
  { key: "agendaItems", one: "événement planifié", many: "événements planifiés" },
  { key: "exports", one: "export", many: "exports" },
]

const SHARED_LABELS: Array<{ key: keyof NonNullable<AssetDeletionSummary["shared"]>; one: string; many: string }> = [
  { key: "documents", one: "document", many: "documents" },
  { key: "operations", one: "Opération", many: "Opérations" },
  { key: "agendaItems", one: "événement planifié", many: "événements planifiés" },
  { key: "deadlines", one: "échéance", many: "échéances" },
  { key: "events", one: "événement", many: "événements" },
]

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`

/** « 12 documents », « 1 échéance » — éléments SUPPRIMÉS, à zéro omis (pure, testée). */
export function describeDeletionSummary(summary: AssetDeletionSummary): string[] {
  return LABELS.filter(({ key }) => Number(summary[key] ?? 0) > 0).map(
    ({ key, one, many }) => plural(Number(summary[key]), one, many),
  )
}

/** Éléments CONSERVÉS car liés aussi à un autre bien (pure, testée). */
export function describeSharedKept(summary: AssetDeletionSummary): string[] {
  const s = summary.shared
  if (!s) return []
  return SHARED_LABELS.filter(({ key }) => Number(s[key] ?? 0) > 0).map(({ key, one, many }) => plural(Number(s[key]), one, many))
}

/** État de l'export facultatif proposé dans la fenêtre (#849, C2). */
export type DeletionExportState =
  | "none"          // aucun export demandé : suppression libre après confirmation
  | "generating"    // archive en cours de génération
  | "downloading"   // archive prête, téléchargement en cours
  | "downloaded"    // archive téléchargée ET vérifiée (SHA-256)
  | "unverified"    // archive prête, téléchargement non vérifiable : confirmation explicite requise
  | "confirmed"     // l'utilisateur déclare avoir récupéré l'archive
  | "failed"        // génération ou téléchargement en échec
  | "abandoned"     // export abandonné explicitement

/**
 * Peut-on supprimer ? (pure, testée) — inventaire chargé avec son empreinte,
 * suppression confirmée explicitement, aucun traitement en cours, et, SI un
 * export a été demandé, archive récupérée (vérifiée ou déclarée) ou export
 * abandonné explicitement. Jamais de suppression aveugle.
 */
export function canConfirmDeletion(p: {
  inventoryReady: boolean
  fingerprint: string | null | undefined
  acknowledged: boolean
  exportState: DeletionExportState
  isLoading: boolean
}): boolean {
  if (!p.inventoryReady || !p.fingerprint || !p.acknowledged || p.isLoading) return false
  return ["none", "downloaded", "confirmed", "abandoned"].includes(p.exportState)
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Suppression définitive d'un bien — carte #849 (B1, C2).
 *
 * Une fenêtre unique : conséquences exactes (GET /api/assets/[id]/deletion-summary)
 * — ce qui est SUPPRIMÉ et ce qui est CONSERVÉ car lié aussi à un autre bien —,
 * export du ZIP complet FACULTATIF (moteur EXPORT_BRUT, portée `complete`) et
 * suppression après confirmation explicite. Inventaire introuvable ou
 * illisible : suppression BLOQUÉE, « Réessayer ». Export demandé : la
 * suppression attend l'archive réellement téléchargée (empreinte vérifiée) ou
 * un abandon explicite ; l'archive est supprimée du serveur avec le bien. Pas
 * de corbeille, pas de délai, pas de restauration ; ZIP non réimportable (V1).
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
  const [acknowledged, setAcknowledged] = useState(false)
  const [exportState, setExportState] = useState<DeletionExportState>("none")
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [archive, setArchive] = useState<{ url: string; sha256: string; size: number } | null>(null)
  const submitted = useRef(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    submitted.current = false
    setSummary(null)
    setSummaryState("loading")
    setAcknowledged(false)
    apiClient
      .get<AssetDeletionSummary>(`/api/assets/${assetId}/deletion-summary`, { useCache: false })
      .then((data) => {
        if (cancelled) return
        if (!data || typeof data.fingerprint !== "string") {
          setSummaryState("error")
          return
        }
        setSummary(data)
        setSummaryState("ready")
      })
      .catch(() => {
        if (!cancelled) setSummaryState("error")
      })
    return () => {
      cancelled = true
    }
  }, [open, assetId, reload])

  useEffect(() => {
    if (open) return
    setExportState("none")
    setExportMessage(null)
    setArchive(null)
  }, [open])

  const busy = exportState === "generating" || exportState === "downloading"

  const download = useCallback(async (a: { url: string; sha256: string; size: number }) => {
    setExportState("downloading")
    setExportMessage(null)
    try {
      const res = await fetch(a.url, { credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      if (buf.byteLength !== a.size || (await sha256Hex(buf)) !== a.sha256) {
        setExportState("failed")
        setExportMessage("L’archive reçue ne correspond pas à l’archive générée (taille ou empreinte). Réessayez le téléchargement.")
        return
      }
      const objectUrl = URL.createObjectURL(new Blob([buf], { type: "application/zip" }))
      const link = document.createElement("a")
      link.href = objectUrl
      link.download = `${assetName || "bien"} - archive complète.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
      setExportState("downloaded")
    } catch {
      // Téléchargement non vérifiable (réseau, navigateur) : lien direct + déclaration explicite.
      setExportState("unverified")
      setExportMessage("Le téléchargement n’a pas pu être vérifié automatiquement. Utilisez le lien ci-dessous, ouvrez l’archive, puis confirmez l’avoir récupérée.")
    }
  }, [assetName])

  const startExport = useCallback(async () => {
    if (busy) return
    setExportState("generating")
    setExportMessage(null)
    try {
      const r = await apiClient.post<{ downloadZipUrl?: string | null; archive?: { sha256: string; size: number } }>(
        `/api/assets/${assetId}/exports`,
        { exportType: "EXPORT_BRUT", scope: "complete", options: { complete: true } },
      )
      if (!r?.downloadZipUrl || !r.archive?.sha256) {
        setExportState("failed")
        setExportMessage("L’archive complète n’a pas pu être produite. Réessayez.")
        return
      }
      const a = { url: r.downloadZipUrl, sha256: r.archive.sha256, size: r.archive.size }
      setArchive(a)
      await download(a)
    } catch (e) {
      const err = e as { details?: { detailCode?: string; missing?: unknown[] } }
      const manquants = Array.isArray(err?.details?.missing) ? err.details!.missing!.length : 0
      setExportState("failed")
      setExportMessage(err?.details?.detailCode === "EXPORT_INCOMPLETE"
        ? `Archive INCOMPLÈTE : ${manquants} élément(s) illisible(s) ou absent(s) du stockage. Aucun ZIP n’a été présenté comme complet.`
        : "L’archive complète n’a pas pu être produite. Réessayez.")
    }
  }, [assetId, busy, download])

  const items = summary ? describeDeletionSummary(summary) : []
  const kept = summary ? describeSharedKept(summary) : []
  const allowed = canConfirmDeletion({
    inventoryReady: summaryState === "ready", fingerprint: summary?.fingerprint, acknowledged, exportState, isLoading,
  })

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy && !isLoading) onOpenChange(o) }}>
      <AlertDialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <Trash2 className="w-5 h-5 text-destructive mt-1 flex-shrink-0 btn-delete-trash-icon" aria-hidden="true" />
            <div>
              <AlertDialogTitle>Supprimer définitivement le bien &quot;{assetName}&quot; ?</AlertDialogTitle>
              <AlertDialogDescription className="mt-2">
                Tout ce qui appartient exclusivement à ce bien sera supprimé définitivement.
                Cette action est irréversible : ni corbeille, ni restauration.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-2" aria-live="polite">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            Seront supprimés
          </div>
          {summaryState === "loading" && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Calcul des éléments concernés…
            </p>
          )}
          {summaryState === "ready" && items.length > 0 && (
            <ul className="list-disc pl-5 text-foreground" data-testid="asset-deletion-summary">
              <li>le bien lui-même</li>
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {summaryState === "ready" && items.length === 0 && (
            <p className="text-muted-foreground">
              Le bien seul : aucun document, Opération, échéance ni autre élément ne lui appartient exclusivement.
            </p>
          )}
          {summaryState === "error" && (
            <div className="space-y-2" role="alert">
              <p className="text-foreground">
                L’inventaire du bien n’a pas pu être établi : la suppression est bloquée tant qu’il n’est pas affiché.
              </p>
              <button
                type="button"
                onClick={() => setReload((n) => n + 1)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-sm hover:bg-muted"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Réessayer
              </button>
            </div>
          )}
        </div>

        {summaryState === "ready" && kept.length > 0 && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm space-y-1" data-testid="asset-deletion-kept">
            <div className="font-medium text-foreground">Conservés (liés aussi à un autre bien)</div>
            <p className="text-muted-foreground">{kept.join(", ")} — seule leur relation à ce bien disparaît.</p>
          </div>
        )}

        <div className="rounded-md border border-border p-3 text-sm space-y-2">
          <div className="font-medium text-foreground">Garder une copie (facultatif)</div>
          <p className="text-muted-foreground">
            Le ZIP complet réunit la fiche, les documents et leurs versions, les photos, les Opérations et dépenses,
            l’agenda et un manifeste vérifiable. Il se consulte mais ne se réimporte pas. Il est supprimé du serveur
            avec le bien : téléchargez-le avant de confirmer.
          </p>
          {exportState === "none" || exportState === "failed" ? (
            <button
              type="button"
              onClick={() => void startExport()}
              disabled={summaryState !== "ready" || isLoading}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 font-medium hover:bg-muted disabled:opacity-50"
            >
              <Download className="w-4 h-4" aria-hidden="true" /> Exporter le ZIP complet
            </button>
          ) : null}
          {busy && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              {exportState === "generating" ? "Préparation de l’archive complète…" : "Téléchargement et vérification de l’archive…"}
            </p>
          )}
          {exportState === "downloaded" && (
            <p className="flex items-center gap-2 text-foreground" data-testid="asset-deletion-export-done">
              <CheckCircle2 className="w-4 h-4 text-[color:var(--text-success)]" aria-hidden="true" /> Archive téléchargée et vérifiée.
            </p>
          )}
          {exportMessage && <p className="text-foreground" role="status">{exportMessage}</p>}
          {exportState === "unverified" && archive && (
            <div className="space-y-2">
              <a href={archive.url} className="underline" target="_blank" rel="noreferrer">Télécharger l’archive</a>
              <button
                type="button"
                onClick={() => setExportState("confirmed")}
                className="block rounded-md border border-border bg-background px-3 py-1.5 hover:bg-muted"
              >
                J’ai récupéré l’archive
              </button>
            </div>
          )}
          {(exportState === "failed" || exportState === "unverified") && (
            <button
              type="button"
              onClick={() => { setExportState("abandoned"); setExportMessage(null) }}
              className="block text-muted-foreground underline"
            >
              Abandonner l’export et continuer sans copie
            </button>
          )}
          {exportState === "failed" && archive && (
            <button type="button" onClick={() => void download(archive)} className="block underline">
              Réessayer le téléchargement
            </button>
          )}
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledged}
            disabled={summaryState !== "ready" || isLoading}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>Je comprends que cette suppression est définitive et irréversible.</span>
        </label>

        <div className="flex gap-2 justify-end pt-4 border-t">
          <AlertDialogCancel disabled={isLoading || busy}>Annuler</AlertDialogCancel>
          <button
            type="button"
            onClick={() => {
              if (!allowed || submitted.current || !summary?.fingerprint) return
              submitted.current = true
              onConfirm(summary.fingerprint)
            }}
            disabled={!allowed}
            aria-disabled={!allowed}
            className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 btn-delete border-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? "Suppression en cours..." : "Supprimer définitivement"}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
