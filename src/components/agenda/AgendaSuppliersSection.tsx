"use client";
/**
 * Lot 103E — « Fournisseur / intervenant » d'un élément d'Agenda (ticket P1
 * « Agenda / Fournisseurs »). Composant DÉDIÉ (le tiroir Agenda n'en reçoit
 * que l'insertion), desktop et mobile (même tiroir).
 *
 *   · `AgendaSuppliersView`  fiche détaillée : NOMS cliquables vers la fiche
 *     du référentiel ; rubrique MASQUÉE s'il n'y en a aucun ; aucune
 *     coordonnée (la fiche fournisseur reste la source) ;
 *   · `AgendaSuppliersField` création ET modification : sélection multiple,
 *     recherche dans les fournisseurs du compte, ajout / retrait avant
 *     enregistrement, création d'un fournisseur SANS quitter le tiroir — le
 *     nom est vérifié par le rapprochement du référentiel (vérification à
 *     blanc : fiche existante réutilisée, fiche proche à confirmer) et la
 *     fiche n'est créée qu'à l'ENREGISTREMENT de l'élément (abandon : rien
 *     n'est créé, aucun lien orphelin).
 * Jamais affiché dans les cartes, lignes et vues compactes de l'Agenda.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Briefcase, Loader2, Plus, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api-client";
import { supplierHref } from "@/lib/supplier-routes";
import type { AgendaSuppliersPayload } from "@/lib/agenda/agenda-suppliers-rules";

export interface SupplierChip { id: number; name: string }
export interface PendingSupplier { name: string; confirmNew: boolean }
/** Sélection en cours d'édition (null : pas encore chargée — rien n'est envoyé). */
export interface AgendaSuppliersSelection { selected: SupplierChip[]; pending: PendingSupplier[] }

export const EMPTY_SUPPLIERS_SELECTION: AgendaSuppliersSelection = { selected: [], pending: [] };

/** Charge utile des routes `POST /api/agenda` et `PUT /api/agenda/:id` (champ `suppliers`). */
export function suppliersPayload(s: AgendaSuppliersSelection | null): AgendaSuppliersPayload | undefined {
  if (!s) return undefined;
  return { supplierIds: s.selected.map((x) => x.id), newSuppliers: s.pending.map((p) => ({ name: p.name, confirmNew: p.confirmNew })) };
}

const CHIP = "inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)]";
const plural = (n: number) => (n > 1 ? "Fournisseurs / intervenants" : "Fournisseur / intervenant");

/** Fiche détaillée : noms cliquables ; rien du tout quand aucun fournisseur n'est associé. */
export function AgendaSuppliersView({ itemId, refreshKey }: { itemId: number; refreshKey?: unknown }) {
  const [list, setList] = useState<SupplierChip[]>([]);
  useEffect(() => {
    let actif = true;
    apiClient.get<{ suppliers: SupplierChip[] }>(`/api/agenda/${itemId}/fournisseurs`)
      .then((r) => { if (actif) setList(Array.isArray(r?.suppliers) ? r.suppliers : []); })
      .catch(() => { if (actif) setList([]); });
    return () => { actif = false; };
  }, [itemId, refreshKey]);
  if (list.length === 0) return null;
  return (
    <div className="flex items-start gap-3" data-testid="agenda-suppliers-view">
      <div className="w-8 h-8 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0 mt-0.5">
        <Briefcase className="h-4 w-4 text-[color:var(--text-muted)]" aria-hidden />
      </div>
      <div className="flex-1 min-w-0">
        <p className="vb-app-label mb-2">{plural(list.length)}</p>
        <div className="flex flex-wrap gap-2">
          {list.map((s) => (
            <Link
              key={s.id}
              href={supplierHref(s.id)}
              aria-label={`Ouvrir la fiche du fournisseur : ${s.name}`}
              className={`${CHIP} max-w-full hover:border-[color:var(--border-info)] hover:bg-[color:var(--accent-soft)] transition-colors`}
            >
              <span className="truncate">{s.name}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

interface DuplicateCheck { decision: "certain" | "uncertain" | "new"; candidates: SupplierChip[] }

/**
 * Champ multi-sélection (création et modification). `itemId` : élément
 * existant — la sélection actuelle est chargée puis remise à `onChange`
 * (`initial = true`, sans rendre le formulaire « modifié »).
 */
export function AgendaSuppliersField({ itemId, value, onChange, idPrefix = "agenda-fournisseurs" }: {
  itemId?: number | null;
  value: AgendaSuppliersSelection | null;
  onChange: (next: AgendaSuppliersSelection, initial?: boolean) => void;
  idPrefix?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SupplierChip[]>([]);
  const [searching, setSearching] = useState(false);
  const [checking, setChecking] = useState(false);
  const [proche, setProche] = useState<{ name: string; candidates: SupplierChip[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const charge = useRef<number | null>(null);

  // Élément existant : sélection actuelle (une fois par élément).
  useEffect(() => {
    if (!itemId || charge.current === itemId) return;
    charge.current = itemId;
    apiClient.get<{ suppliers: SupplierChip[] }>(`/api/agenda/${itemId}/fournisseurs`)
      .then((r) => onChange({ selected: (r?.suppliers ?? []).map((s) => ({ id: s.id, name: s.name })), pending: [] }, true))
      .catch(() => setError("Les fournisseurs de cet élément n’ont pas pu être chargés."));
  }, [itemId, onChange]);

  // Recherche dans les fournisseurs du compte (référentiel existant).
  useEffect(() => {
    if (!open) return;
    let actif = true;
    const q = query.trim();
    setSearching(true);
    const t = setTimeout(() => {
      apiClient.get<{ suppliers: SupplierChip[] }>(q ? `/api/suppliers?search=${encodeURIComponent(q)}` : "/api/suppliers")
        .then((r) => { if (actif) setResults((r?.suppliers ?? []).map((s) => ({ id: s.id, name: s.name }))); })
        .catch(() => { if (actif) setResults([]); })
        .finally(() => { if (actif) setSearching(false); });
    }, 200);
    return () => { actif = false; clearTimeout(t); };
  }, [query, open]);

  const sel = value ?? EMPTY_SUPPLIERS_SELECTION;
  const choisis = useMemo(() => new Set(sel.selected.map((s) => s.id)), [sel.selected]);
  const visibles = results.filter((r) => !choisis.has(r.id)).sort((a, b) => a.name.localeCompare(b.name, "fr")).slice(0, 20);
  const saisie = query.trim().replace(/\s+/g, " ");
  const egal = (a: string, b: string) => a.localeCompare(b, "fr", { sensitivity: "base" }) === 0;
  const peutCreer = saisie.length > 0 && !results.some((r) => egal(r.name, saisie)) && !sel.pending.some((p) => egal(p.name, saisie));

  const ajouter = (s: SupplierChip) => {
    if (!choisis.has(s.id)) onChange({ ...sel, selected: [...sel.selected, s] });
    setQuery(""); setProche(null); setError(null);
  };
  const retirer = (id: number) => onChange({ ...sel, selected: sel.selected.filter((s) => s.id !== id) });
  const retirerNouveau = (name: string) => onChange({ ...sel, pending: sel.pending.filter((p) => p.name !== name) });
  const ajouterNouveau = (name: string, confirmNew: boolean) => {
    onChange({ ...sel, pending: [...sel.pending.filter((p) => !egal(p.name, name)), { name, confirmNew }] });
    setQuery(""); setProche(null); setError(null);
  };

  /** « Créer » : vérification à blanc par le référentiel (aucune écriture). */
  const creer = async () => {
    if (!saisie) return;
    setChecking(true); setError(null);
    try {
      const r = await apiClient.post<DuplicateCheck>("/api/suppliers", { name: saisie, dryRun: true });
      const candidats = (r?.candidates ?? []).map((c) => ({ id: c.id, name: c.name }));
      if (r?.decision === "certain" && candidats[0]) ajouter(candidats[0]);
      else if (r?.decision === "uncertain" && candidats.length) setProche({ name: saisie, candidates: candidats });
      else ajouterNouveau(saisie, false);
    } catch (e: unknown) {
      const status = (e as { status?: number } | null)?.status;
      if (status !== 403) setError("La vérification du fournisseur n’a pas abouti. Réessayez.");
    } finally {
      setChecking(false);
    }
  };

  const total = sel.selected.length + sel.pending.length;
  return (
    <div className="space-y-1.5" data-testid="agenda-suppliers-field">
      <Label htmlFor={`${idPrefix}-recherche`} className="text-[13px] font-semibold text-[color:var(--text-muted)]">
        Fournisseur / intervenant <span className="font-normal">(facultatif)</span>
      </Label>
      {total > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Fournisseurs sélectionnés">
          {sel.selected.map((s) => (
            <span key={s.id} className={`${CHIP} max-w-full`}>
              <span className="truncate">{s.name}</span>
              <button type="button" onClick={() => retirer(s.id)} aria-label={`Retirer ${s.name}`} className="text-[color:var(--text-muted)] hover:text-[color:var(--danger)]">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {sel.pending.map((p) => (
            <span key={`n-${p.name}`} className={`${CHIP} max-w-full border-dashed`}>
              <span className="truncate">{p.name}</span>
              <span className="text-[color:var(--text-muted)]">· nouveau</span>
              <button type="button" onClick={() => retirerNouveau(p.name)} aria-label={`Retirer ${p.name}`} className="text-[color:var(--text-muted)] hover:text-[color:var(--danger)]">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id={`${idPrefix}-recherche`}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setProche(null); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { setTimeout(() => setOpen(false), 200); }}
          placeholder="Rechercher ou ajouter un fournisseur"
          className="pl-9"
          autoComplete="off"
          maxLength={200}
        />
      </div>
      {open && (
        <div className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-1 max-h-56 overflow-y-auto" role="listbox" aria-label="Fournisseurs du compte">
          {searching && visibles.length === 0 && (
            <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" />Recherche…</p>
          )}
          {!searching && visibles.length === 0 && !peutCreer && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{saisie ? "Aucun autre fournisseur ne correspond." : "Aucun fournisseur enregistré pour le moment."}</p>
          )}
          {visibles.map((r) => (
            <button key={r.id} type="button" role="option" aria-selected={false} onClick={() => ajouter(r)}
              className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-[color:var(--accent-soft)] truncate">
              {r.name}
            </button>
          ))}
          {peutCreer && (
            <button type="button" onClick={() => { void creer(); }} disabled={checking}
              className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded text-sm text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] disabled:opacity-50">
              {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              <span className="truncate">Ajouter « {saisie} » comme nouveau fournisseur</span>
            </button>
          )}
        </div>
      )}
      {proche && (
        <div className="rounded-md border border-[color:var(--attention-edge)] bg-[color:var(--attention-soft)] p-3 space-y-2 text-sm" role="alert">
          <p className="text-[color:var(--attention-on-soft)]">Un fournisseur proche existe déjà dans votre compte. Est-ce le même ?</p>
          <div className="flex flex-wrap gap-2">
            {proche.candidates.map((c) => (
              <button key={c.id} type="button" onClick={() => ajouter(c)} className={`${CHIP} hover:border-[color:var(--border-info)]`}>
                Utiliser « {c.name} »
              </button>
            ))}
            <button type="button" onClick={() => ajouterNouveau(proche.name, true)} className={`${CHIP} border-dashed`}>
              Créer « {proche.name} » quand même
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-[color:var(--danger)]">{error}</p>}
      {sel.pending.length > 0 && (
        <p className="text-xs text-muted-foreground">Les nouveaux fournisseurs seront ajoutés à votre liste à l’enregistrement.</p>
      )}
    </div>
  );
}
