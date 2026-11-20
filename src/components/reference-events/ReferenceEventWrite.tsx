"use client";

/**
 * Carte #744, travaux D — ÉCRITURE (CDC « Opérations / Agenda V2.0 » §14,
 * §19 ; décisions du PO du 15/11/2026) — gestes de la page d'un événement de
 * référence : corriger (intitulé, type, dates), supprimer, rattacher /
 * détacher un événement de l'Agenda, un document, un fournisseur, associer /
 * dissocier une autre opération, scinder (le déplacement direct d'un document est retiré : carte #806 §1), et
 * — travaux D « contenu » — écrire ou retirer la NOTE LIBRE
 * (« Notes / Description », migration 1722 ; CDC §5, §14 ; AC42).
 *
 * `useReferenceEventWrite` rend les ACTIONS (données à
 * `ReferenceEventPageContent`) et les FENÊTRES à monter dans la page. Chaque
 * geste :
 *   · passe par la garde d'écriture (`useWriteGuard`) : un compte en lecture
 *     seule voit la fenêtre habituelle, rien n'est envoyé ;
 *   · appelle UNE route `/api/evenements-reference/:id/...` (le serveur fait
 *     foi : garde, compte, version attendue) ;
 *   · affiche la PHRASE rendue par le serveur — jamais un code ;
 *   · en cas de conflit de version (409), relit la fiche.
 * Aucune règle métier ici. Même composant sur ordinateur et sur mobile
 * (fenêtres en pleine largeur, cibles tactiles de 44 px), charte Sérénité
 * (jetons de couleur seulement). Le mot « Opération » n'apparaît jamais.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useWriteGuard } from "@/contexts/WriteGuardContext";
import { apiClient } from "@/lib/api-client";
import { isWriteBlockedCode } from "@/lib/write-blocked";
import {
  REFERENCE_EVENT_DATE_ROLES, REFERENCE_EVENT_PAGE_LABELS as P, referenceEventDay, referenceEventRelationLabel,
  type ReferenceEventDateRole,
} from "@/lib/reference-events/reference-event-page";
import {
  REFERENCE_EVENT_SPLIT_EMPTY_FORM, REFERENCE_EVENT_SPLIT_PARTS, REFERENCE_EVENT_WRITE_LABELS as L,
  buildReferenceEventCorrection, buildReferenceEventSplit, referenceEventAssociationOptions, referenceEventCorrectionForm, referenceEventSplitItems,
  type ReferenceEventAssociationOption, type ReferenceEventCandidate, type ReferenceEventCandidateKind, type ReferenceEventCandidateList,
  type ReferenceEventCorrectionForm, type ReferenceEventSplitForm, type ReferenceEventSplitItem, type ReferenceEventSplitPart,
  type ReferenceEventSplitPreview, type ReferenceEventTypeOption, type ReferenceEventWriteResponse,
} from "@/lib/reference-events/reference-event-write";
import {
  REFERENCE_EVENT_NOTES_LABELS as N, REFERENCE_EVENT_NOTES_MAX, buildReferenceEventNotes,
} from "@/lib/reference-events/reference-event-summary";
import type { ReferenceEventPageView } from "@/services/business-operations/graph/reference-event-page";

/** Actions proposées par la page ; absentes : page en consultation seule. */
export interface ReferenceEventPageActions {
  correct: () => void;
  remove: () => void;
  linkAgenda: () => void;
  unlinkAgenda: (agendaItemId: number, title: string) => void;
  linkDocument: () => void;
  unlinkDocument: (fileId: number, title: string) => void;
  linkSupplier: () => void;
  unlinkSupplier: (supplierId: number, name: string) => void;
  associate: () => void;
  dissociate: (operationId: number, label: string) => void;
  /** Scinder (CDC §7, §14) ; absent : la fiche ne porte encore aucun fait déplaçable. */
  split?: () => void;
  /** Notes / Description (carte #744, travaux D — contenu) : le texte libre de l'utilisateur. */
  editNotes?: () => void;
}

export interface ReferenceEventDeleted { id: number; title: string; version: number | null }

type ConfirmKind = "delete" | "unlinkAgenda" | "unlinkDocument" | "unlinkSupplier" | "dissociate";
type Fenetre =
  | { kind: "correct" }
  | { kind: "notes" }
  | { kind: "split" }
  | { kind: "confirm"; confirm: ConfirmKind; targetId: number; name: string }
  | { kind: "pick"; pick: ReferenceEventCandidateKind; fileId?: number; name?: string };

const BTN = "h-11 md:h-9";

/** Phrase d'un échec : celle du serveur ; refus « lecture seule » : la fenêtre habituelle s'en charge (null). */
function phraseEchec(err: unknown): string | null {
  const e = err as { status?: number; code?: string; serverMessage?: string } | null;
  if (e?.status === 403 && isWriteBlockedCode(e.code)) return null;
  return e?.serverMessage && e.status ? e.serverMessage : L.networkError;
}

const adresse = (id: number, suite = ""): string => `/api/evenements-reference/${id}${suite}`;

/** Envoie le geste d'annulation de la suppression (utilisé par la page, après « Supprimer »). */
export async function restoreReferenceEvent(deleted: ReferenceEventDeleted): Promise<{ ok: true; message: string } | { ok: false; message: string | null }> {
  try {
    const r = await apiClient.post<ReferenceEventWriteResponse>(adresse(deleted.id, "/restauration"), deleted.version !== null ? { expectedVersion: deleted.version } : {});
    return { ok: true, message: r.message };
  } catch (err) {
    return { ok: false, message: phraseEchec(err) };
  }
}

// ── Fenêtre « Corriger » ───────────────────────────────────────────────────

function CorrectDialog({ fiche, onClose, onSend }: {
  fiche: ReferenceEventPageView; onClose: () => void;
  onSend: (call: () => Promise<ReferenceEventWriteResponse>) => Promise<string | null>;
}) {
  const [form, setForm] = useState<ReferenceEventCorrectionForm>(() => referenceEventCorrectionForm(fiche));
  const [types, setTypes] = useState<ReferenceEventTypeOption[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let actif = true;
    apiClient.get<{ types?: ReferenceEventTypeOption[] }>(adresse(fiche.id, "/candidats?kind=type"))
      .then((r) => { if (actif) setTypes(r.types ?? []); })
      .catch(() => { /* Sans référentiel : le type n'est simplement pas proposé ; l'intitulé et les dates restent corrigibles. */ });
    return () => { actif = false; };
  }, [fiche.id]);

  const enregistrer = async () => {
    const demande = buildReferenceEventCorrection(fiche, form);
    if (!demande.ok) { setErreur(demande.error); return; }
    setBusy(true);
    setErreur(null);
    const echec = await onSend(() => apiClient.patch<ReferenceEventWriteResponse>(adresse(fiche.id), demande.body));
    setBusy(false);
    if (echec) setErreur(echec);
  };
  const date = (role: ReferenceEventDateRole, v: string) => setForm((f) => ({ ...f, dates: { ...f.dates, [role]: v } }));

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent data-testid="reference-event-correct-dialog">
        <DialogHeader>
          <DialogTitle>{L.correctTitle}</DialogTitle>
          <DialogDescription>{L.correctHint}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">{L.labelField}</span>
            <Input
              value={form.label} maxLength={220} placeholder={L.labelPlaceholder} className="h-11 md:h-9"
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} data-testid="reference-event-correct-label"
            />
          </label>
          {types.length > 0 && (
            <div className="space-y-1 text-sm">
              <span className="text-muted-foreground" id="reference-event-correct-type-label">{L.typeField}</span>
              <Select value={form.typeCode || undefined} onValueChange={(v) => setForm((f) => ({ ...f, typeCode: v }))}>
                <SelectTrigger className="h-11 w-full md:h-9" aria-labelledby="reference-event-correct-type-label" data-testid="reference-event-correct-type">
                  <SelectValue placeholder={L.typeUnset} />
                </SelectTrigger>
                <SelectContent>
                  {types.map((t) => <SelectItem key={t.code} value={t.code}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <fieldset className="space-y-2">
            <legend className="text-sm text-muted-foreground">{L.datesLegend}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {REFERENCE_EVENT_DATE_ROLES.map((role) => (
                <label key={role} className="block space-y-1 text-sm">
                  <span className="text-muted-foreground">{P.dateRoles[role]}</span>
                  <Input
                    type="date" value={form.dates[role]} className="h-11 md:h-9"
                    onChange={(e) => date(role, e.target.value)} data-testid={`reference-event-correct-date-${role}`}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          {erreur && <p className="text-sm text-[color:var(--danger)]" role="alert" data-testid="reference-event-write-error">{erreur}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" className={BTN} onClick={onClose} disabled={busy}>{L.cancel}</Button>
          <Button type="button" className={BTN} onClick={() => { void enregistrer(); }} disabled={busy} data-testid="reference-event-correct-save">
            {busy ? L.busy : L.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Fenêtre « Notes / Description » (CDC §5, §14 ; AC42) ───────────────────

/**
 * Le texte libre de l'utilisateur. Vider le champ RETIRE la note. Ouvrir et
 * enregistrer sans toucher au texte n'écrit rien (même règle que le champ d'un
 * document, lot 113Z). Le serveur fait foi (version attendue, droits).
 */
function NotesDialog({ fiche, onClose, onSend }: {
  fiche: ReferenceEventPageView; onClose: () => void;
  onSend: (call: () => Promise<ReferenceEventWriteResponse>) => Promise<string | null>;
}) {
  const [texte, setTexte] = useState(fiche.notes?.text ?? "");
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enregistrer = async () => {
    const demande = buildReferenceEventNotes(fiche, texte);
    if (!demande.ok) { setErreur(demande.error); return; }
    setBusy(true);
    setErreur(null);
    const echec = await onSend(() => apiClient.put<ReferenceEventWriteResponse>(adresse(fiche.id, "/notes"), demande.body));
    setBusy(false);
    if (echec) setErreur(echec);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent data-testid="reference-event-notes-dialog">
        <DialogHeader>
          <DialogTitle>{N.dialogTitle}</DialogTitle>
          <DialogDescription>{N.dialogHint}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">{N.field}</span>
            <Textarea
              value={texte} rows={6} maxLength={REFERENCE_EVENT_NOTES_MAX} placeholder={N.placeholder}
              onChange={(e) => { setErreur(null); setTexte(e.target.value); }} data-testid="reference-event-notes-input"
            />
          </label>
          <p className="text-xs text-muted-foreground">{N.clearHint}</p>
          {erreur && <p className="text-sm text-[color:var(--danger)]" role="alert" data-testid="reference-event-write-error">{erreur}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" className={BTN} onClick={onClose} disabled={busy}>{L.cancel}</Button>
          <Button type="button" className={BTN} onClick={() => { void enregistrer(); }} disabled={busy} data-testid="reference-event-notes-save">
            {busy ? L.busy : L.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Fenêtre de confirmation (supprimer, détacher, retirer, dissocier) ──────

const CONFIRM_TEXTS: Readonly<Record<ConfirmKind, { title: string; body: readonly string[]; action: string; destructive: boolean }>> = {
  delete: { title: L.deleteTitle, body: [L.deleteKept, L.deleteProjected, L.deleteUndo], action: L.deleteConfirm, destructive: true },
  unlinkAgenda: { title: L.unlinkAgendaTitle, body: [L.unlinkAgendaBody], action: L.unlinkAgenda, destructive: false },
  unlinkDocument: { title: L.unlinkDocumentTitle, body: [L.unlinkDocumentBody], action: L.unlinkDocument, destructive: false },
  unlinkSupplier: { title: L.unlinkSupplierTitle, body: [L.unlinkSupplierBody], action: L.unlinkSupplier, destructive: false },
  dissociate: { title: L.dissociateTitle, body: [L.dissociateBody], action: L.dissociate, destructive: false },
};

function ConfirmDialog({ confirm, name, onClose, onConfirm }: {
  confirm: ConfirmKind; name: string; onClose: () => void; onConfirm: () => Promise<string | null>;
}) {
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = CONFIRM_TEXTS[confirm];
  const valider = async () => {
    setBusy(true);
    setErreur(null);
    const echec = await onConfirm();
    setBusy(false);
    if (echec) setErreur(echec);
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent data-testid={`reference-event-confirm-${confirm}`}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{name}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {t.body.map((p) => <p key={p} className="text-sm text-[color:var(--text-primary)]">{p}</p>)}
          {erreur && <p className="text-sm text-[color:var(--danger)]" role="alert" data-testid="reference-event-write-error">{erreur}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" className={BTN} onClick={onClose} disabled={busy}>{L.cancel}</Button>
          <Button type="button" variant={t.destructive ? "destructive" : "default"} className={BTN} onClick={() => { void valider(); }} disabled={busy} data-testid="reference-event-confirm-action">
            {busy ? L.busy : t.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Fenêtre de choix d'un objet à relier ───────────────────────────────────

const PICK_TEXTS: Readonly<Record<ReferenceEventCandidateKind, { title: string; hint: string }>> = {
  agenda: { title: L.pickerAgendaTitle, hint: L.pickerAgendaHint },
  document: { title: L.pickerDocumentTitle, hint: L.pickerDocumentHint },
  supplier: { title: L.pickerSupplierTitle, hint: L.pickerSupplierHint },
  reference: { title: L.pickerReferenceTitle, hint: L.pickerReferenceHint },
};

function PickDialog({ fiche, pick, name, onClose, onPick }: {
  fiche: ReferenceEventPageView; pick: ReferenceEventCandidateKind; name?: string; onClose: () => void;
  onPick: (candidate: ReferenceEventCandidate, option: ReferenceEventAssociationOption | null) => Promise<string | null>;
}) {
  const [q, setQ] = useState("");
  const [liste, setListe] = useState<ReferenceEventCandidateList | null>(null);
  const [etat, setEtat] = useState<"loading" | "ready" | "error">("loading");
  const [choisi, setChoisi] = useState<ReferenceEventCandidate | null>(null);
  const [option, setOption] = useState(0);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tour = useRef(0);
  const t = PICK_TEXTS[pick];

  useEffect(() => {
    const moi = ++tour.current;
    setEtat("loading");
    const attente = setTimeout(() => {
      apiClient.get<ReferenceEventCandidateList>(adresse(fiche.id, `/candidats?kind=${pick}&q=${encodeURIComponent(q)}`))
        .then((r) => { if (tour.current === moi) { setListe({ items: r.items ?? [], more: r.more === true }); setEtat("ready"); } })
        .catch(() => { if (tour.current === moi) setEtat("error"); });
    }, q ? 250 : 0);
    return () => clearTimeout(attente);
  }, [fiche.id, pick, q]);

  const options = useMemo(
    () => (pick === "reference" && choisi ? referenceEventAssociationOptions(fiche.typeCode, choisi.typeCode) : []),
    [pick, choisi, fiche.typeCode],
  );
  const envoyer = async (c: ReferenceEventCandidate, o: ReferenceEventAssociationOption | null) => {
    setBusy(true);
    setErreur(null);
    const echec = await onPick(c, o);
    setBusy(false);
    if (echec) setErreur(echec);
  };
  const choisir = (c: ReferenceEventCandidate) => {
    // Association : la nature du lien est choisie avant d'enregistrer ; les autres gestes s'enregistrent au choix.
    if (pick === "reference") { setChoisi(c); setOption(0); setErreur(null); } else void envoyer(c, null);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent data-testid={`reference-event-pick-${pick}`}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{name ? `${name} — ${t.hint}` : t.hint}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {choisi ? (
            <div className="space-y-3" data-testid="reference-event-association-step">
              <p className="text-sm font-medium text-[color:var(--text-primary)] [overflow-wrap:anywhere]">{choisi.title}</p>
              <fieldset className="space-y-1">
                <legend className="text-sm text-muted-foreground">{L.associationNature}</legend>
                {options.map((o, i) => (
                  <label key={`${o.nature}-${o.direction}`} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md px-1 text-sm hover:bg-muted/40">
                    <input type="radio" name="reference-event-association" checked={option === i} onChange={() => setOption(i)} className="h-4 w-4 accent-[color:var(--accent)]" />
                    <span>{referenceEventRelationLabel(o.nature, o.direction)}</span>
                  </label>
                ))}
              </fieldset>
            </div>
          ) : (
            <>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">{L.pickerSearch}</span>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L.pickerSearchPlaceholder} className="h-11 md:h-9" data-testid="reference-event-pick-search" />
              </label>
              {etat === "loading" && <p className="text-sm text-muted-foreground" role="status">{L.pickerLoading}</p>}
              {etat === "error" && <p className="text-sm text-[color:var(--danger)]" role="alert">{L.pickerError}</p>}
              {etat === "ready" && liste && liste.items.length === 0 && <p className="text-sm text-muted-foreground" data-testid="reference-event-pick-empty">{L.pickerEmpty}</p>}
              {etat === "ready" && liste && liste.items.length > 0 && (
                <ul className="divide-y divide-[color:var(--border-subtle)]" data-testid="reference-event-pick-list">
                  {liste.items.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button" disabled={busy} onClick={() => choisir(c)} data-reference-event-candidate={c.id}
                        className="flex min-h-[44px] w-full items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-muted/40 disabled:opacity-60"
                      >
                        <span className="min-w-0 flex-1 text-sm font-medium text-[color:var(--text-primary)] [overflow-wrap:anywhere]">{c.title}</span>
                        {pick !== "supplier" && <span className="shrink-0 text-xs text-muted-foreground">{referenceEventDay(c.date) ?? L.undatedCandidate}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {etat === "ready" && liste?.more && <p className="text-xs text-muted-foreground" data-testid="reference-event-pick-more">{L.pickerMore}</p>}
            </>
          )}
          {erreur && <p className="text-sm text-[color:var(--danger)]" role="alert" data-testid="reference-event-write-error">{erreur}</p>}
        </DialogBody>
        <DialogFooter>
          {choisi ? (
            <>
              <Button type="button" variant="secondary" className={BTN} onClick={() => { setChoisi(null); setErreur(null); }} disabled={busy}>{L.back}</Button>
              <Button type="button" className={BTN} onClick={() => { void envoyer(choisi, options[option] ?? null); }} disabled={busy || options.length === 0} data-testid="reference-event-associate-confirm">
                {busy ? L.busy : L.associateConfirm}
              </Button>
            </>
          ) : (
            <Button type="button" variant="secondary" className={BTN} onClick={onClose} disabled={busy}>{L.close}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Fenêtre « Scinder » (CDC §7, §14 ; AC46) ───────────────────────────────

const SPLIT_PART_LABELS: Readonly<Record<ReferenceEventSplitPart, string>> = {
  agenda: L.splitPartAgenda, document: L.splitPartDocument, supplier: L.splitPartSupplier,
};

/** Liste d'un aperçu (ce qui part, ce qui reste) ; vide : la ligne n'est pas affichée. */
function SplitPreviewList({ title, items, testId }: { title: string; items: readonly ReferenceEventSplitItem[]; testId: string }) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="text-xs font-semibold text-muted-foreground">{title} ({items.length})</p>
      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map((i) => (
            <li key={`${i.part}-${i.id}`} className="text-sm text-[color:var(--text-primary)] [overflow-wrap:anywhere]" data-split-preview={`${i.part}-${i.id}`}>
              {i.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Scinder : on désigne ce qui appartient à une autre réalité, on VÉRIFIE
 * l'aperçu (ce qui part, ce qui reste), puis on enregistre. Les refus qui se
 * voient sans serveur (aucun intitulé, rien de désigné, tout désigné) sont dits
 * avant tout envoi. Le serveur fait foi (version attendue, rattachements,
 * droits).
 */
function SplitDialog({ fiche, onClose, onSend }: {
  fiche: ReferenceEventPageView; onClose: () => void;
  onSend: (call: () => Promise<ReferenceEventWriteResponse>) => Promise<string | null>;
}) {
  const [form, setForm] = useState<ReferenceEventSplitForm>(REFERENCE_EVENT_SPLIT_EMPTY_FORM);
  const [apercu, setApercu] = useState<ReferenceEventSplitPreview | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = useMemo(() => referenceEventSplitItems(fiche), [fiche]);
  const designe = (i: ReferenceEventSplitItem): boolean =>
    (i.part === "agenda" ? form.agendaItemIds : i.part === "document" ? form.fileIds : form.supplierIds).includes(i.id);

  const basculer = (i: ReferenceEventSplitItem) => {
    setErreur(null);
    setForm((f) => {
      const change = (liste: readonly number[]): number[] => (liste.includes(i.id) ? liste.filter((x) => x !== i.id) : [...liste, i.id]);
      if (i.part === "agenda") return { ...f, agendaItemIds: change(f.agendaItemIds) };
      if (i.part === "document") return { ...f, fileIds: change(f.fileIds) };
      return { ...f, supplierIds: change(f.supplierIds) };
    });
  };

  const verifier = () => {
    const demande = buildReferenceEventSplit(fiche, form);
    if (!demande.ok) { setErreur(demande.error); setApercu(null); return; }
    setErreur(null);
    setApercu(demande.preview);
  };
  const enregistrer = async () => {
    const demande = buildReferenceEventSplit(fiche, form);
    if (!demande.ok) { setErreur(demande.error); setApercu(null); return; }
    setBusy(true);
    setErreur(null);
    const echec = await onSend(() => apiClient.post<ReferenceEventWriteResponse>(adresse(fiche.id, "/scission"), demande.body));
    setBusy(false);
    if (echec) setErreur(echec);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent data-testid="reference-event-split-dialog">
        <DialogHeader>
          <DialogTitle>{L.splitTitle}</DialogTitle>
          <DialogDescription>{L.splitHint}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {apercu ? (
            <div className="space-y-3" data-testid="reference-event-split-preview">
              <p className="text-sm font-medium text-[color:var(--text-primary)] [overflow-wrap:anywhere]">{L.splitPreviewTitle}</p>
              <SplitPreviewList title={L.splitPreviewMoved} items={apercu.moved} testId="reference-event-split-moved" />
              <SplitPreviewList title={L.splitPreviewKept} items={apercu.kept} testId="reference-event-split-kept" />
              <p className="text-xs text-muted-foreground">{L.splitPreviewHint}</p>
            </div>
          ) : (
            <>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">{L.splitLabelField}</span>
                <Input
                  value={form.label} maxLength={220} placeholder={L.splitLabelPlaceholder} className="h-11 md:h-9"
                  onChange={(e) => { setErreur(null); setForm((f) => ({ ...f, label: e.target.value })); }}
                  data-testid="reference-event-split-label"
                />
              </label>
              <fieldset className="space-y-3">
                <legend className="text-sm text-muted-foreground">{L.splitPartsLegend}</legend>
                {REFERENCE_EVENT_SPLIT_PARTS.map((part) => {
                  const liste = items.filter((i) => i.part === part);
                  if (liste.length === 0) return null;
                  return (
                    <div key={part} className="space-y-1" data-testid={`reference-event-split-part-${part}`}>
                      <p className="text-xs font-semibold text-muted-foreground">{SPLIT_PART_LABELS[part]}</p>
                      {liste.map((i) => (
                        <label key={i.id} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md px-1 text-sm hover:bg-muted/40">
                          <input
                            type="checkbox" checked={designe(i)} onChange={() => basculer(i)}
                            className="h-4 w-4 accent-[color:var(--accent)]" data-split-choice={`${part}-${i.id}`}
                          />
                          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{i.title}</span>
                        </label>
                      ))}
                    </div>
                  );
                })}
              </fieldset>
              <p className="text-xs text-muted-foreground">{L.splitTypeNote}</p>
            </>
          )}
          {erreur && <p className="text-sm text-[color:var(--danger)]" role="alert" data-testid="reference-event-write-error">{erreur}</p>}
        </DialogBody>
        <DialogFooter>
          {apercu ? (
            <>
              <Button type="button" variant="secondary" className={BTN} onClick={() => { setApercu(null); setErreur(null); }} disabled={busy}>{L.back}</Button>
              <Button type="button" className={BTN} onClick={() => { void enregistrer(); }} disabled={busy} data-testid="reference-event-split-save">
                {busy ? L.busy : L.splitConfirm}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="secondary" className={BTN} onClick={onClose} disabled={busy}>{L.cancel}</Button>
              <Button type="button" className={BTN} onClick={verifier} disabled={busy} data-testid="reference-event-split-review">{L.splitReview}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Chef d'orchestre ───────────────────────────────────────────────────────

/**
 * Actions et fenêtres d'écriture de la page. `onChanged` : la fiche est à
 * relire (geste appliqué, ou conflit de version) ; `onDeleted` : l'événement
 * de référence vient d'être supprimé (la page propose d'annuler).
 */
export function useReferenceEventWrite(
  fiche: ReferenceEventPageView | null,
  handlers: { onChanged: () => void; onDeleted: (deleted: ReferenceEventDeleted) => void },
): { actions: ReferenceEventPageActions | undefined; dialogs: React.ReactNode } {
  const { garder } = useWriteGuard();
  const [fenetre, setFenetre] = useState<Fenetre | null>(null);
  const { onChanged, onDeleted } = handlers;
  const fermer = useCallback(() => setFenetre(null), []);

  /** Envoie un geste ; rend la phrase d'échec à afficher dans la fenêtre, ou null (réussi, ou refus déjà affiché). */
  const envoyer = useCallback(async (call: () => Promise<ReferenceEventWriteResponse>, apres?: (r: ReferenceEventWriteResponse) => void): Promise<string | null> => {
    try {
      const r = await call();
      if (r.changed) toast.success(r.message); else toast(r.message);
      setFenetre(null);
      if (apres) apres(r); else onChanged();
      return null;
    } catch (err) {
      // Conflit (version périmée, événement supprimé entre-temps) : la fiche affichée n'est plus à jour.
      if ((err as { status?: number } | null)?.status === 409) onChanged();
      const phrase = phraseEchec(err);
      if (phrase === null) setFenetre(null);
      return phrase;
    }
  }, [onChanged]);

  const actions = useMemo<ReferenceEventPageActions | undefined>(() => {
    if (!fiche) return undefined;
    const ouvrir = (f: Fenetre) => garder(() => setFenetre(f));
    return {
      correct: () => ouvrir({ kind: "correct" }),
      remove: () => ouvrir({ kind: "confirm", confirm: "delete", targetId: fiche.id, name: fiche.title }),
      linkAgenda: () => ouvrir({ kind: "pick", pick: "agenda" }),
      unlinkAgenda: (targetId, name) => ouvrir({ kind: "confirm", confirm: "unlinkAgenda", targetId, name }),
      linkDocument: () => ouvrir({ kind: "pick", pick: "document" }),
      unlinkDocument: (targetId, name) => ouvrir({ kind: "confirm", confirm: "unlinkDocument", targetId, name }),
      linkSupplier: () => ouvrir({ kind: "pick", pick: "supplier" }),
      unlinkSupplier: (targetId, name) => ouvrir({ kind: "confirm", confirm: "unlinkSupplier", targetId, name }),
      associate: () => ouvrir({ kind: "pick", pick: "reference" }),
      dissociate: (targetId, name) => ouvrir({ kind: "confirm", confirm: "dissociate", targetId, name }),
      // Scinder n'a de sens que s'il y a quelque chose à déplacer (CDC §14 : une action dit son périmètre).
      ...(referenceEventSplitItems(fiche).length > 0 ? { split: () => ouvrir({ kind: "split" }) } : {}),
      editNotes: () => ouvrir({ kind: "notes" }),
    };
  }, [fiche, garder]);

  let dialogs: React.ReactNode = null;
  if (fiche && fenetre?.kind === "correct") {
    dialogs = <CorrectDialog fiche={fiche} onClose={fermer} onSend={(call) => envoyer(call)} />;
  } else if (fiche && fenetre?.kind === "notes") {
    dialogs = <NotesDialog fiche={fiche} onClose={fermer} onSend={(call) => envoyer(call)} />;
  } else if (fiche && fenetre?.kind === "split") {
    dialogs = <SplitDialog fiche={fiche} onClose={fermer} onSend={(call) => envoyer(call)} />;
  } else if (fiche && fenetre?.kind === "confirm") {
    const { confirm, targetId, name } = fenetre;
    const id = fiche.id;
    const onConfirm = (): Promise<string | null> => {
      switch (confirm) {
        case "delete":
          return envoyer(
            () => apiClient.delete<ReferenceEventWriteResponse>(adresse(id, `?version=${fiche.version}`)),
            (r) => onDeleted({ id, title: fiche.title, version: r.version }),
          );
        case "unlinkAgenda": return envoyer(() => apiClient.delete<ReferenceEventWriteResponse>(adresse(id, `/evenements?agendaItemId=${targetId}`)));
        case "unlinkDocument": return envoyer(() => apiClient.delete<ReferenceEventWriteResponse>(adresse(id, `/documents?fileId=${targetId}`)));
        case "unlinkSupplier": return envoyer(() => apiClient.delete<ReferenceEventWriteResponse>(adresse(id, `/fournisseurs?supplierId=${targetId}`)));
        case "dissociate": return envoyer(() => apiClient.delete<ReferenceEventWriteResponse>(adresse(id, `/associations?otherId=${targetId}`)));
      }
    };
    dialogs = <ConfirmDialog confirm={confirm} name={name} onClose={fermer} onConfirm={onConfirm} />;
  } else if (fiche && fenetre?.kind === "pick") {
    const { pick, fileId, name } = fenetre;
    const id = fiche.id;
    const onPick = (c: ReferenceEventCandidate, o: ReferenceEventAssociationOption | null): Promise<string | null> => {
      switch (pick) {
        case "agenda": return envoyer(() => apiClient.post<ReferenceEventWriteResponse>(adresse(id, "/evenements"), { agendaItemId: c.id }));
        case "document": return envoyer(() => apiClient.post<ReferenceEventWriteResponse>(adresse(id, "/documents"), { fileId: c.id }));
        case "supplier": return envoyer(() => apiClient.post<ReferenceEventWriteResponse>(adresse(id, "/fournisseurs"), { supplierId: c.id }));
        case "reference":
          return envoyer(() => apiClient.post<ReferenceEventWriteResponse>(adresse(id, "/associations"), {
            otherId: c.id, nature: o?.nature ?? "ASSOCIATED", direction: o?.direction ?? "UNDIRECTED",
          }));
      }
    };
    dialogs = <PickDialog key={`${pick}-${fileId ?? 0}`} fiche={fiche} pick={pick} name={name} onClose={fermer} onPick={onPick} />;
  }
  return { actions, dialogs };
}
