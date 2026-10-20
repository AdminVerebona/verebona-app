"use client"

/**
 * « Déplacer vers l'espace Duo » — lot 74B, point 4.
 *
 * Fiche du bien, MÊME composant sur ordinateur et sur mobile (WebView) :
 *   · `MoveToDuoSpaceButton` n'apparaît que si le serveur propose au moins un
 *     espace Duo (membre actif des deux espaces, `GET …/move-to-space`) ;
 *   · le dialogue charge l'APERÇU exact (déplacement exécuté puis annulé côté
 *     serveur) : ce qui part, ce qui reste dans l'espace actuel, ce qui n'est
 *     jamais déplacé, quotas de l'espace Duo après déplacement ;
 *   · « Déplacer » renvoie l'empreinte de cet aperçu : si le contenu a changé
 *     entre-temps, le nouvel aperçu s'affiche et une nouvelle confirmation
 *     est demandée. Un refus de quota s'affiche tel quel, rien n'est déplacé ;
 *   · après succès, l'espace Duo s'ouvre sur la fiche du bien.
 */
import { useEffect, useState } from "react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ArrowRightLeft, Info, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { apiClient } from "@/lib/api-client"
import { switchToAccount } from "@/components/account/AccountSwitcher"

interface MoveTarget { accountId: number; name: string; roleLabel: string }
interface MoveDocument { id: number; title: string }
interface MovePreview {
  assetName: string
  to: { accountId: number; name: string }
  moves: {
    documents: MoveDocument[]; equipments: number; rooms: number; agendaItems: number; events: number;
    deadlines: number; operations: number; toProcessActions: number; suppliersCopied: number; suppliersReused: number
  }
  stays: { sharedDocuments: MoveDocument[]; sharedAgendaItems: number; sharedOperations: number; pendingTransmissionsCancelled: number }
  personal: string[]
  quotas: { assets: { used: number; limit: number }; documents: { used: number; limit: number } }
  fingerprint: string
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`

/** Lignes « x éléments » non nulles (pures, testées). */
export function describeMoves(m: MovePreview["moves"]): string[] {
  const out: string[] = []
  if (m.equipments) out.push(plural(m.equipments, "équipement", "équipements"))
  if (m.rooms) out.push(plural(m.rooms, "pièce", "pièces"))
  if (m.agendaItems) out.push(plural(m.agendaItems, "élément d’agenda", "éléments d’agenda"))
  if (m.events + m.deadlines) out.push(plural(m.events + m.deadlines, "événement ou échéance de l’historique", "événements et échéances de l’historique"))
  if (m.operations) out.push(plural(m.operations, "opération (intervention, sinistre…)", "opérations (interventions, sinistres…)"))
  if (m.toProcessActions) out.push(plural(m.toProcessActions, "action « À traiter »", "actions « À traiter »"))
  if (m.suppliersCopied) out.push(plural(m.suppliersCopied, "fiche fournisseur recopiée (sans coordonnées bancaires)", "fiches fournisseur recopiées (sans coordonnées bancaires)"))
  return out
}

export function describeStays(s: MovePreview["stays"]): string[] {
  const out: string[] = s.sharedDocuments.map((d) => `${d.title} (aussi rattaché à un autre bien : son lien avec ce bien est retiré)`)
  if (s.sharedAgendaItems) out.push(plural(s.sharedAgendaItems, "élément d’agenda partagé avec un autre bien (lien retiré)", "éléments d’agenda partagés avec d’autres biens (lien retiré)"))
  if (s.sharedOperations) out.push(plural(s.sharedOperations, "opération partagée avec un autre bien (lien retiré)", "opérations partagées avec d’autres biens (lien retiré)"))
  if (s.pendingTransmissionsCancelled) out.push(plural(s.pendingTransmissionsCancelled, "transmission en attente annulée", "transmissions en attente annulées"))
  return out
}

/** Appel JSON avec renouvellement de session sur 401 (une fois). */
async function call(url: string, init?: { body: unknown }): Promise<{ status: number; data: Record<string, any> }> {
  const go = () => fetch(url, {
    method: init ? "POST" : "GET",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
  })
  let res = await go()
  if (res.status === 401 && (await apiClient.refreshToken()) === true) res = await go()
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

/** Bouton de la fiche du bien : rendu seulement si un espace Duo est proposé. */
export function MoveToDuoSpaceButton({ assetId, assetName }: { assetId: number; assetName: string }) {
  const [targets, setTargets] = useState<MoveTarget[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let annule = false
    call(`/api/assets/${assetId}/move-to-space`)
      .then((r) => { if (!annule && r.status === 200) setTargets((r.data.targets as MoveTarget[]) ?? []) })
      .catch(() => undefined)
    return () => { annule = true }
  }, [assetId])
  if (targets.length === 0) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="move-to-duo-space"
        className="flex-shrink-0 inline-flex items-center gap-1.5 min-h-9 px-2 rounded-md text-sm text-[color:var(--text-muted)] hover:text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] transition-colors"
        title="Déplacer vers l’espace Duo"
        aria-label="Déplacer vers l’espace Duo"
      >
        <ArrowRightLeft className="w-4 h-4" aria-hidden />
        <span className="hidden md:inline">Déplacer vers le Duo</span>
      </button>
      <MoveToDuoSpaceDialog open={open} onOpenChange={setOpen} assetId={assetId} assetName={assetName} targets={targets} />
    </>
  )
}

export function MoveToDuoSpaceDialog({ open, onOpenChange, assetId, assetName, targets }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  assetId: number
  assetName: string
  targets: MoveTarget[]
}) {
  const [targetId, setTargetId] = useState<number>(targets[0]?.accountId ?? 0)
  const [preview, setPreview] = useState<MovePreview | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "refused" | "moving" | "error">("loading")
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (!open || !targetId) return
    let annule = false
    setState("loading"); setPreview(null); setMessage("")
    call(`/api/assets/${assetId}/move-to-space`, { body: { targetAccountId: targetId, preview: true } })
      .then(({ status, data }) => {
        if (annule) return
        if (status === 200) { setPreview(data.preview as MovePreview); setState("ready"); return }
        if (data.preview) setPreview(data.preview as MovePreview)
        setMessage(typeof data.message === "string" ? data.message : "Le déplacement n’est pas possible pour le moment.")
        setState(status >= 500 ? "error" : "refused")
      })
      .catch(() => { if (!annule) { setMessage("Connexion impossible. Réessayez."); setState("error") } })
    return () => { annule = true }
  }, [open, assetId, targetId])

  const confirmer = async () => {
    if (!preview) return
    setState("moving"); setMessage("")
    try {
      const { status, data } = await call(`/api/assets/${assetId}/move-to-space`, {
        body: { targetAccountId: targetId, confirm: true, fingerprint: preview.fingerprint },
      })
      if (status === 200) {
        apiClient.clearCache()
        const r = await switchToAccount(targetId, `/assets/${assetId}`)
        if (!r.ok) window.location.assign("/assets")
        return
      }
      if (data.preview) setPreview(data.preview as MovePreview)
      setMessage(typeof data.message === "string" ? data.message : "Le déplacement a échoué : rien n’a été modifié.")
      setState(data.code === "PREVIEW_STALE" ? "ready" : "refused")
    } catch {
      setMessage("Connexion impossible : rien n’a été modifié. Réessayez.")
      setState("error")
    }
  }

  const target = targets.find((t) => t.accountId === targetId)
  const moves = preview ? describeMoves(preview.moves) : []
  const stays = preview ? describeStays(preview.stays) : []
  const docs = preview?.moves.documents ?? []
  const busy = state === "loading" || state === "moving"

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <AlertDialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <ArrowRightLeft className="w-5 h-5 mt-1 flex-shrink-0 text-[color:var(--accent)]" aria-hidden />
            <div className="min-w-0">
              <AlertDialogTitle>Déplacer « {assetName} » vers l’espace Duo ?</AlertDialogTitle>
              <AlertDialogDescription className="mt-2">
                Le bien et tout ce qui s’y rattache rejoignent l’espace « {target?.name ?? ""} » : tous ses membres y auront accès,
                et il n’apparaîtra plus dans votre espace actuel.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        {targets.length > 1 && (
          <label className="block text-sm">
            <span className="vb-app-label">Espace de destination</span>
            <select
              className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg-card)] px-3 py-2 text-sm"
              value={targetId}
              disabled={busy}
              onChange={(e) => setTargetId(Number(e.target.value))}
            >
              {targets.map((t) => <option key={t.accountId} value={t.accountId}>{t.name} ({t.roleLabel})</option>)}
            </select>
          </label>
        )}

        {state === "loading" && (
          <p className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Calcul de ce qui sera déplacé…
          </p>
        )}

        {preview && state !== "loading" && (
          <div className="space-y-3 text-sm" data-testid="move-to-duo-preview">
            <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-3 space-y-1.5">
              <p className="font-medium text-[color:var(--text-primary)]">Partent avec le bien</p>
              <ul className="list-disc pl-5 space-y-0.5 text-[color:var(--text-primary)]">
                <li>{docs.length === 0 ? "Aucun document" : plural(docs.length, "document", "documents")}</li>
                {docs.slice(0, 8).map((d) => <li key={d.id} className="ml-4 list-[circle] break-words text-[color:var(--text-muted)]">{d.title}</li>)}
                {docs.length > 8 && <li className="ml-4 list-[circle] text-[color:var(--text-muted)]">et {docs.length - 8} autre(s)</li>}
                {moves.map((x) => <li key={x}>{x}</li>)}
              </ul>
            </section>
            {stays.length > 0 && (
              <section className="rounded-md border border-[color:var(--border)] p-3 space-y-1.5">
                <p className="font-medium text-[color:var(--text-primary)]">Restent dans votre espace actuel</p>
                <ul className="list-disc pl-5 space-y-0.5 text-[color:var(--text-muted)]">
                  {stays.map((x) => <li key={x} className="break-words">{x}</li>)}
                </ul>
              </section>
            )}
            <p className="flex items-start gap-2 text-[color:var(--text-muted)]">
              <Info className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
              <span>Ne sont jamais déplacés : {preview.personal.join(", ")}.</span>
            </p>
            <p className="text-[color:var(--text-muted)]">
              Après déplacement, l’espace Duo comptera {plural(preview.quotas.assets.used, "bien", "biens")} sur {preview.quotas.assets.limit} et{" "}
              {plural(preview.quotas.documents.used, "document", "documents")} sur {preview.quotas.documents.limit}.
            </p>
          </div>
        )}

        {message && (
          <p role="alert" className={`text-sm ${state === "ready" ? "text-[color:var(--text-warning-soft)]" : "text-destructive"}`}>{message}</p>
        )}

        <div className="flex flex-col-reverse sm:flex-row gap-2 justify-end pt-4 border-t">
          <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
          <Button type="button" onClick={() => void confirmer()} disabled={state !== "ready" || !preview} className="gap-2">
            {state === "moving" ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ArrowRightLeft className="w-4 h-4" aria-hidden />}
            Déplacer vers l’espace Duo
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
