"use client";

/**
 * Regroupement d'un élément d'agenda — AFFICHAGE sans état ni appel réseau
 * (lot 84B, CDC v5 O-3 : §14.2, §14.3 ; AC27, AC28). Données et gestes :
 * `AgendaGroupingSection.tsx`. Séparé pour être rendu tel quel dans les tests
 * (rendu serveur et navigateur réel, largeur mobile).
 *
 * Libellés : `lib/agenda/grouping-view.ts` — jamais « Opération » ni
 * « principal » à l'écran. Desktop ET mobile : même composant, cibles 44 px
 * sur mobile ; le tiroir de choix (`GroupingPicker`) est un tiroir EMPILÉ du
 * composant de base 81F (zones sûres, bouton « Fermer », retour Android).
 *
 * Lot 86D (ticket « Documents / Agenda » §2) : quel que soit son rôle, un
 * élément montre SES documents (« Documents de cet élément ») — ouvrir,
 * relier, DÉTACHER individuellement (le document et l'élément restent, rien
 * n'est supprimé ; décision mémorisée côté serveur). Pour l'événement de
 * référence, la catégorie « Documents » de l'ensemble porte les deux gestes :
 * détacher de cet événement (lien) et retirer de l'ensemble.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Building2, CalendarDays, FileText, Grid2X2, Link2, Loader2, Plus, Search, Star, Unlink, Wrench, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntityCard, EntityCardList, type EntityCardKind } from "@/components/drawers/EntityCard";
import { restoreFocusOnClose } from "@/lib/drawers";
import {
  GROUPING_LABELS as L, REMOVE_ACTION, groupingCountsSummary,
  type AgendaGroupingView, type GroupingAction, type GroupingCandidate, type GroupingCandidateKind,
} from "@/lib/agenda/grouping-view";

const fmtDate = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "Sans date");

const KIND_CARD: Record<GroupingCandidateKind, EntityCardKind> = {
  elements: "echeance", documents: "document", biens: "bien", pieces: "piece", equipements: "equipement",
};
const KIND_ICON: Record<GroupingCandidateKind, typeof FileText> = {
  elements: CalendarDays, documents: FileText, biens: Building2, pieces: Grid2X2, equipements: Wrench,
};
/**
 * Gestes : 44 px de haut sur mobile (32 px sur desktop) ; un libellé long passe
 * à la ligne au lieu de déborder de l'écran (390 px).
 */
const BTN = "min-h-11 sm:min-h-8 h-auto py-2 sm:py-1 whitespace-normal text-left";
/**
 * Lot 89B (demande PO 25/10) : boutons d'ASSOCIATION (document ↔ agenda) au style neutre —
 * contour gris, texte courant, aucun accent pétrole au survol ni anneau cuivre au focus
 * (sur mobile, le focus rendu au bouton après la sélection affichait un contour rouge-brun).
 * Le focus clavier reste visible : anneau neutre 2 px (`data-focus-ring="off"` sur le bouton).
 */
export const ASSOCIATION_BTN =
  "border-[color:var(--border)] bg-[color:var(--bg-card)] text-[color:var(--text-primary)] hover:border-[color:var(--border)] hover:bg-[color:var(--bg-subtle)] hover:text-[color:var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--text-muted)]";

/** Les cinq catégories, dans l'ordre du CDC §14.2. */
export const MAIN_CATEGORIES: readonly GroupingCandidateKind[] = ["elements", "documents", "biens", "pieces", "equipements"];

interface Row { id: number; title: string; meta?: string | null; badge?: string | null; /** Lot 86D : document relié à CET élément (détachable). */ linked?: boolean }

/** Lignes d'une catégorie de l'ensemble (pure). */
export function categoryRows(view: AgendaGroupingView, kind: GroupingCandidateKind): Row[] {
  const e = view.ensemble;
  if (!e) return [];
  switch (kind) {
    case "elements": return e.items.map((i) => ({ id: i.id, title: i.title, meta: fmtDate(i.startDate), badge: i.isMain ? L.mainBadge : null }));
    case "documents": return e.documents.map((d) => ({ id: d.id, title: d.title, meta: d.documentDate ? fmtDate(d.documentDate) : null, badge: d.link === "DIRECT" ? L.directLink : null, linked: d.link !== null }));
    case "biens": return e.assets.map((a) => ({ id: a.id, title: a.name }));
    case "pieces": return e.rooms.map((r) => ({ id: r.id, title: r.name }));
    case "equipements": return e.equipments.map((q) => ({ id: q.id, title: q.name }));
  }
}

interface AgendaGroupingPanelProps {
  view: AgendaGroupingView;
  busy?: boolean;
  onAction: (action: GroupingAction, targetId?: number) => void;
  onPick: (kind: GroupingCandidateKind) => void;
  onCreateStep?: () => void;
  onRelease: () => void;
  onOpenMain: (id: number) => void;
  onOpenDocument?: (id: number) => void;
}

/** Affichage (sans état) — rendu côté serveur dans les tests. */
export function AgendaGroupingPanel({ view, busy = false, onAction, onPick, onCreateStep, onRelease, onOpenMain, onOpenDocument }: AgendaGroupingPanelProps) {
  // Lot 86D : documents de CET élément — ouvrir, détacher (lien seul), relier.
  const detachButton = (id: number, title: string) => (
    <button type="button" disabled={busy} onClick={() => onAction("detacher-document", id)}
      aria-label={L.detachFromItem(title)} title={L.detach} data-testid={`regroupement-detacher-document-${id}`}
      className="inline-flex size-11 sm:size-8 items-center justify-center rounded-[10px] text-[color:var(--text-muted)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger)] disabled:opacity-40">
      <Unlink className="w-3.5 h-3.5" aria-hidden />
    </button>
  );
  const itemDocuments = () => (
    <div className="space-y-2" data-testid="regroupement-documents-element">
      <h4 className="vb-app-label">{L.linkedDocuments}{view.linkedDocuments.length ? ` (${view.linkedDocuments.length})` : ""}</h4>
      {view.linkedDocuments.length ? (
        <EntityCardList>
          {view.linkedDocuments.map((d) => (
            <EntityCard key={`doc-${d.id}`} kind="document" id={d.id} title={d.title} icon={<FileText className="w-3.5 h-3.5" />}
              meta={d.documentDate ? fmtDate(d.documentDate) : undefined}
              onOpen={onOpenDocument ? () => onOpenDocument(d.id) : undefined}
              actions={detachButton(d.id, d.title)} data-testid={`regroupement-document-element-${d.id}`} />
          ))}
        </EntityCardList>
      ) : <p className="text-xs text-[color:var(--text-muted)]">{L.empty.documents}</p>}
    </div>
  );

  const pickButton = (kind: GroupingCandidateKind) => (
    <Button key={`relier-${kind}`} type="button" variant="secondary" size="sm" className={`${BTN} ${ASSOCIATION_BTN}`} disabled={busy}
      onClick={() => onPick(kind)} data-testid={`regroupement-relier-${kind}`} data-focus-ring="off">
      <Link2 className="w-3.5 h-3.5" aria-hidden />{L.add[kind]}
    </Button>
  );

  if (view.role === "NONE") {
    return (
      <section aria-labelledby={`regroupement-${view.itemId}`} data-testid="agenda-regroupement" data-role="seul" className="space-y-3">
        {itemDocuments()}
        <h3 id={`regroupement-${view.itemId}`} className="vb-app-label">{L.sectionAlone}</h3>
        <div className="flex flex-wrap gap-2">{pickButton("elements")}{pickButton("documents")}</div>
      </section>
    );
  }

  if (view.role === "MEMBER" && view.main) {
    const main = view.main;
    const resume = groupingCountsSummary(view.counts);
    return (
      <section aria-labelledby={`regroupement-${view.itemId}`} data-testid="agenda-regroupement" data-role="rattache" className="space-y-3">
        {itemDocuments()}
        <div className="flex flex-wrap gap-2">{pickButton("documents")}</div>
        <h3 id={`regroupement-${view.itemId}`} className="vb-app-label">{L.partOf}</h3>
        <EntityCardList>
          <EntityCard kind="echeance" id={main.id} title={main.title} icon={<Star className="w-3.5 h-3.5" />}
            meta={[fmtDate(main.startDate), resume].filter(Boolean).join(" · ")} onOpen={() => onOpenMain(main.id)}
            data-testid="regroupement-reference" />
        </EntityCardList>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className={BTN} onClick={() => onOpenMain(main.id)} disabled={busy}>
            {L.openMain}
          </Button>
          <Button type="button" variant="secondary" size="sm" className={BTN} onClick={() => onAction("designer-reference")} disabled={busy}>
            <Star className="w-3.5 h-3.5" aria-hidden />{L.makeMain}
          </Button>
          <Button type="button" variant="destructive" size="sm" className={BTN} onClick={() => onAction("quitter-ensemble")} disabled={busy}>
            <Unlink className="w-3.5 h-3.5" aria-hidden />{L.leave}
          </Button>
        </div>
      </section>
    );
  }

  const removeButton = (kind: GroupingCandidateKind, row: Row) => (
    <button type="button" disabled={busy} onClick={() => onAction(REMOVE_ACTION[kind], row.id)}
      aria-label={kind === "documents" ? L.removeFromEnsemble(row.title) : `${L.remove} « ${row.title} »`}
      className="inline-flex size-11 sm:size-8 items-center justify-center rounded-[10px] text-[color:var(--text-muted)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger)] disabled:opacity-40">
      <X className="w-3.5 h-3.5" aria-hidden />
    </button>
  );

  const card = (kind: GroupingCandidateKind, row: Row) => {
    const Icon = KIND_ICON[kind];
    const ouvrir = kind === "documents" && onOpenDocument ? () => onOpenDocument(row.id) : kind === "elements" ? () => onOpenMain(row.id) : undefined;
    return (
      <EntityCard key={`${kind}-${row.id}`} kind={KIND_CARD[kind]} id={row.id} title={row.title} icon={<Icon className="w-3.5 h-3.5" />}
        meta={row.meta ?? undefined} onOpen={ouvrir}
        badges={row.badge ? <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)]">{row.badge}</span> : undefined}
        actions={kind === "documents" && row.linked
          ? <span className="inline-flex items-center gap-1">{detachButton(row.id, row.title)}{removeButton(kind, row)}</span>
          : removeButton(kind, row)} data-testid={`regroupement-${kind}-${row.id}`} />
    );
  };

  // Élément d'un ensemble SANS événement de référence : les autres éléments seulement.
  if (view.role === "MEMBER") {
    const rows = categoryRows(view, "elements");
    return (
      <section aria-labelledby={`regroupement-${view.itemId}`} data-testid="agenda-regroupement" data-role="ensemble-sans-reference" className="space-y-3">
        {itemDocuments()}
        <h3 id={`regroupement-${view.itemId}`} className="vb-app-label">{L.sectionLinked}</h3>
        {view.mainWithdrawn && <p className="vb-meta text-xs text-[color:var(--text-muted)]">{L.withdrawnNote}</p>}
        {rows.length ? <EntityCardList>{rows.map((r) => card("elements", r))}</EntityCardList>
          : <p className="text-xs text-[color:var(--text-muted)]">{L.empty.elements}</p>}
        <div className="flex flex-wrap gap-2">
          {pickButton("elements")}{pickButton("documents")}
          <Button type="button" variant="secondary" size="sm" className={BTN} onClick={() => onAction("designer-reference")} disabled={busy}>
            <Star className="w-3.5 h-3.5" aria-hidden />{L.makeMain}
          </Button>
          <Button type="button" variant="destructive" size="sm" className={BTN} onClick={() => onAction("quitter-ensemble")} disabled={busy}>
            <Unlink className="w-3.5 h-3.5" aria-hidden />{L.leave}
          </Button>
        </div>
      </section>
    );
  }

  // Événement de référence : les cinq catégories (AC27).
  return (
    <section aria-labelledby={`regroupement-${view.itemId}`} data-testid="agenda-regroupement" data-role="reference" className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 id={`regroupement-${view.itemId}`} className="vb-app-subsection">{L.sectionMain}</h3>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)]">{L.mainBadge}</span>
      </div>
      {MAIN_CATEGORIES.map((kind) => {
        const rows = categoryRows(view, kind);
        return (
          <div key={kind} className="space-y-2" data-testid={`regroupement-categorie-${kind}`}>
            <h4 className="vb-app-label">{L.categories[kind]}{rows.length ? ` (${rows.length})` : ""}</h4>
            {rows.length ? <EntityCardList>{rows.map((r) => card(kind, r))}</EntityCardList>
              : <p className="text-xs text-[color:var(--text-muted)]">{L.empty[kind]}</p>}
            <div className="flex flex-wrap gap-2">
              {pickButton(kind)}
              {kind === "elements" && onCreateStep && (
                <Button type="button" variant="secondary" size="sm" className={BTN} onClick={onCreateStep} disabled={busy} data-testid="regroupement-creer-etape">
                  <Plus className="w-3.5 h-3.5" aria-hidden />{L.createStep}
                </Button>
              )}
            </div>
          </div>
        );
      })}
      <Button type="button" variant="destructive" size="sm" className={BTN} onClick={onRelease} disabled={busy} data-testid="regroupement-retirer-reference">
        {L.releaseMain}
      </Button>
    </section>
  );
}

// ── Choix d'un objet à relier (tiroir empilé) ───────────────────────────────

interface GroupingPickerProps {
  open: boolean;
  title: string;
  load: (q: string) => Promise<GroupingCandidate[]>;
  onPick: (c: GroupingCandidate) => void;
  onClose: () => void;
  /**
   * Lot 89B : action DISTINCTE et explicite de création (« Créer un élément d’agenda »),
   * en pied du choix. Choisir un élément n'en crée jamais ; seule cette action le fait.
   */
  createAction?: { label: string; onCreate: () => void; testId?: string };
}

/** Tiroir de choix : recherche + liste ; même composant desktop et mobile (plein écran). */
export function GroupingPicker({ open, title, load, onPick, onClose, createAction }: GroupingPickerProps) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<GroupingCandidate[] | null>(null);
  const seq = useRef(0);
  // Focus rendu, à la fermeture, au bouton qui a ouvert le choix (tiroir piloté sans
  // déclencheur Radix) : capturé AVANT que le tiroir ne déplace le focus.
  const retour = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && typeof document !== "undefined") retour.current = document.activeElement as HTMLElement | null;
  }, [open]);
  useEffect(() => {
    if (!open) { setQ(""); setItems(null); return; }
    const n = ++seq.current;
    const t = setTimeout(() => {
      load(q).then((r) => { if (n === seq.current) setItems(r); }).catch(() => { if (n === seq.current) setItems([]); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, q, load]);
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-[440px] p-0 flex flex-col" data-testid="regroupement-choix"
        onCloseAutoFocus={(e) => { restoreFocusOnClose(e, retour.current); }}>
        <div className="px-6 pt-6 pb-3 border-b border-[color:var(--border-subtle)]">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">Choisissez l’élément à associer.</SheetDescription>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[color:var(--text-muted)]" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L.search} aria-label={L.search} className="pl-9 h-11 sm:h-9" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {items === null ? (
            <p className="flex items-center gap-2 text-sm text-[color:var(--text-muted)] px-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden />Chargement…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-[color:var(--text-muted)] px-2">{L.noCandidate}</p>
          ) : (
            <ul className="space-y-1.5" role="list">
              {items.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => onPick(c)}
                    className="w-full min-h-11 text-left rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-subtle)] px-3 py-2 hover:border-[color:var(--border-info)] hover:bg-[color:var(--accent-soft)]">
                    <span className="block text-sm font-medium text-[color:var(--text-primary)] truncate">{c.title}</span>
                    {c.meta && <span className="block text-xs text-[color:var(--text-muted)] mt-0.5">{/^\d{4}-\d{2}-\d{2}$/.test(c.meta) ? fmtDate(c.meta) : c.meta}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {createAction && (
          <div className="px-4 py-3 border-t border-[color:var(--border-subtle)]">
            <Button type="button" variant="secondary" size="sm" className={`${BTN} ${ASSOCIATION_BTN} w-full sm:w-auto justify-center`}
              data-focus-ring="off" onClick={createAction.onCreate} data-testid={createAction.testId ?? "regroupement-choix-creer"}>
              <Plus className="w-3.5 h-3.5" aria-hidden />{createAction.label}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
