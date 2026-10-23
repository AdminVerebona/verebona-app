"use client";

/**
 * Rendu d'un dossier d'entité (lot 75N) — composant PUR (props → rendu).
 *
 * Chaque champ, cellule de relation et ligne de table a une action « Copier »
 * accessible au clavier, qui copie la valeur COMPLÈTE (jamais la version
 * tronquée de l'écran). Les états absent / NULL / masqué / non chargé sont
 * affichés explicitement.
 *
 * Lot 81C — CONSULTATION PAGINÉE PAR LE SERVEUR : une section tabulaire ou
 * de relations affiche une page (50 lignes) et son total RÉEL en base ;
 * navigation jusqu'à la dernière page et recherche sur TOUTES les lignes
 * (serveur) ; jamais de chargement massif dans le navigateur. La copie et le
 * CSV d'une section sont générés par le SERVEUR (export intégral), jamais
 * depuis la page affichée.
 */
import { useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, Download, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  CELL_STATE_LABELS, DOSSIER_PAGE_SIZE, ENTITY_LABELS, cellState, fieldCopyText, rawText, sectionToCsv,
  type DossierField, type DossierRelation, type DossierSection, type DossierTable, type DossierWindow, type EntityType, type ExportFormat,
} from '@/services/admin/account-data/model';
import { copyText } from '@/app/admin/ai-executions/_components/CopyJson';

/** Taille de page de la consultation (pagination serveur). */
export const SCREEN_ROWS = DOSSIER_PAGE_SIZE;

/** Entier lisible (« 17 938 »). */
export const fmtInt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Actions serveur d'une section (tiroir) : page / recherche, export intégral, copie intégrale. */
export interface SectionActions {
  loadPage: (sectionId: string, offset: number, q: string | null) => Promise<void>;
  exportUrl: (sectionId: string, format: ExportFormat) => string;
  copySection: (s: DossierSection) => Promise<void>;
}

/** Vrai si la section affichée ne contient pas tous ses éléments (fenêtre ou recherche). */
export function isPartialView(s: DossierSection): boolean {
  const w = s.window;
  if (!w) return false;
  const shown = s.table?.rows.length ?? s.relations?.length ?? 0;
  return w.query ? true : (w.total ?? 0) > shown;
}

/** Copie avec confirmation discrète ; le tiroir reste ouvert. */
export async function copyWithFeedback(text: string, what: string): Promise<boolean> {
  const ok = await copyText(text);
  if (ok) toast.success(`Copié : ${what}.`, { duration: 1500 });
  else toast.error('Copie impossible dans ce navigateur : utilisez « Télécharger ».');
  return ok;
}

export function CopyButton({ text, label, className = '' }: { text: string | (() => string); label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copier ${label}`}
      title={`Copier ${label}`}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyWithFeedback(typeof text === 'function' ? text() : text, label)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      className={`inline-flex h-7 w-7 sm:h-6 sm:w-6 shrink-0 items-center justify-center rounded text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--accent)] ${className}`}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

const STATE_CLS: Record<string, string> = {
  null: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)]',
  absent: 'border border-dashed border-[color:var(--border)] text-[color:var(--text-muted)]',
  masked: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)]',
  not_loaded: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)]',
};

export function StateBadge({ state, note }: { state: DossierField['state']; note?: string | null }) {
  if (state === 'value') return null;
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${STATE_CLS[state] ?? ''}`} title={note ?? undefined} data-cell-state={state}>
      {CELL_STATE_LABELS[state]}{note ? ` — ${note}` : ''}
    </span>
  );
}

function ValueText({ f }: { f: DossierField }) {
  if (f.state !== 'value') return <StateBadge state={f.state} note={f.note} />;
  const raw = rawText(f.raw);
  const isJson = typeof f.raw === 'object' && f.raw !== null;
  if (isJson) {
    return (
      <details className="min-w-0">
        <summary className="cursor-pointer text-xs text-muted-foreground">JSON ({raw.length} caractères) — déplier</summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded bg-muted/40 p-2 text-[11px] whitespace-pre-wrap break-all">{JSON.stringify(f.raw, null, 2)}</pre>
      </details>
    );
  }
  return (
    <span className="break-words">
      {f.display ?? raw}
      {f.display !== undefined && f.display !== raw && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">brut : {raw}</span>}
    </span>
  );
}

export function FieldsList({ fields }: { fields: DossierField[] }) {
  if (!fields.length) return <p className="text-xs text-muted-foreground italic">Aucun champ.</p>;
  return (
    <dl className="divide-y">
      {fields.map((f, i) => (
        <div key={`${f.table}.${f.column}.${f.path ?? ''}.${i}`} className="flex items-start gap-2 py-1.5">
          <div className="min-w-0 flex-1 grid grid-cols-1 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            <dt className="text-xs text-muted-foreground min-w-0">
              <span className="text-foreground/80">{f.label}</span>
              <span className="block font-mono text-[10px] break-all">{f.table}.{f.column}{f.path ? ` › ${f.path}` : ''}</span>
            </dt>
            <dd className="text-xs min-w-0">
              <ValueText f={f} />
              {(f.unit || f.origin || f.updatedAt || (f.note && f.state === 'value')) && (
                <span className="block text-[11px] text-muted-foreground">
                  {[f.unit ? `unité : ${f.unit}` : null, f.origin ? `origine : ${f.originLabel ?? f.origin}` : null, f.updatedAt ? `modifié : ${f.updatedAt}` : null, f.state === 'value' ? f.note : null].filter(Boolean).join(' · ')}
                </span>
              )}
            </dd>
          </div>
          <CopyButton text={() => fieldCopyText(f)} label={f.label} />
        </div>
      ))}
    </dl>
  );
}

export function RelationsList({ relations, onNavigate, window: w, onPage, busy = false }: {
  relations: DossierRelation[]; onNavigate: (type: EntityType, id: number) => void;
  window?: DossierWindow; onPage?: (offset: number, q: string | null) => void; busy?: boolean;
}) {
  if (!relations.length && !w?.query) return <p className="text-xs text-muted-foreground italic">Aucune relation.</p>;
  return (
    <div className="space-y-2">
    {w && onPage && <Pager w={w} shown={relations.length} onPage={onPage} busy={busy} unit="relation(s)" />}
    <ul className="divide-y">
      {relations.map((r, i) => (
        <li key={`${r.type}-${r.id}-${i}`} className="flex items-start gap-2 py-1.5">
          <button
            type="button"
            onClick={() => onNavigate(r.type, r.id)}
            className="min-w-0 flex-1 text-left rounded px-1 -mx-1 hover:bg-[color:var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]"
          >
            <span className="text-xs font-medium underline-offset-2 hover:underline">{ENTITY_LABELS[r.type]} #{r.id} — {r.label}</span>
            <span className="block text-[11px] text-muted-foreground">{[r.nature, r.status ? `statut : ${r.status}` : null, r.origin ? `origine : ${r.origin}` : null, `via ${r.via}`].filter(Boolean).join(' · ')}</span>
          </button>
          <CopyButton text={String(r.id)} label={`l’identifiant ${r.id}`} />
        </li>
      ))}
    </ul>
    </div>
  );
}

/**
 * Pagination SERVEUR d'une section : total réel, page courante, première /
 * précédente / suivante / dernière, recherche sur toutes les lignes.
 * Desktop : une ligne ; mobile : boutons d'au moins 32 px qui passent à la ligne.
 */
export function Pager({ w, shown, onPage, busy, unit = 'ligne(s)' }: { w: DossierWindow; shown: number; onPage: (offset: number, q: string | null) => void; busy: boolean; unit?: string }) {
  const [q, setQ] = useState(w.query ?? '');
  const size = w.size ?? DOSSIER_PAGE_SIZE;
  const count = w.query ? (w.matched ?? 0) : (w.total ?? 0);
  const pages = Math.max(1, Math.ceil(count / size));
  const page = Math.floor(w.offset / size) + 1;
  const go = (p: number) => onPage(Math.max(0, Math.min(pages - 1, p - 1)) * size, w.query ?? null);
  const btn = 'inline-flex h-8 w-8 sm:h-7 sm:w-7 items-center justify-center rounded border text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground" data-pager>
      <span>
        {count ? `${unit === 'ligne(s)' ? 'Lignes' : 'Éléments'} ${fmtInt(w.offset + 1)}–${fmtInt(w.offset + shown)} sur ${fmtInt(count)}` : 'Aucun résultat'}
        {w.query ? ` correspondant à « ${w.query} » (${fmtInt(w.total ?? 0)} en base)` : ` ${unit} en base`}
      </span>
      {pages > 1 && (
        <span className="inline-flex items-center gap-1" role="group" aria-label="Pagination">
          <button type="button" className={btn} disabled={busy || page <= 1} onClick={() => go(1)} aria-label="Première page"><ChevronsLeft className="h-3.5 w-3.5" /></button>
          <button type="button" className={btn} disabled={busy || page <= 1} onClick={() => go(page - 1)} aria-label="Page précédente"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <span className="tabular-nums px-1">Page {fmtInt(page)} / {fmtInt(pages)}</span>
          <button type="button" className={btn} disabled={busy || page >= pages} onClick={() => go(page + 1)} aria-label="Page suivante"><ChevronRight className="h-3.5 w-3.5" /></button>
          <button type="button" className={btn} disabled={busy || page >= pages} onClick={() => go(pages)} aria-label="Dernière page"><ChevronsRight className="h-3.5 w-3.5" /></button>
        </span>
      )}
      {((w.total ?? 0) > size || w.query) && (
        <form className="inline-flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); onPage(0, q.trim() || null); }} role="search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher dans toutes les lignes" aria-label="Rechercher dans toutes les lignes de la section"
            className="h-8 sm:h-7 w-44 sm:w-56 rounded border bg-background px-2 text-[11px] text-foreground" maxLength={200} />
          <button type="submit" className={btn} disabled={busy} aria-label="Rechercher"><Search className="h-3.5 w-3.5" /></button>
          {w.query && <button type="button" className="underline" disabled={busy} onClick={() => { setQ(''); onPage(0, null); }}>Effacer</button>}
        </form>
      )}
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="Chargement" />}
    </div>
  );
}

function Cell({ v }: { v: unknown }) {
  const st = cellState(v);
  if (st !== 'value') return <StateBadge state={st} note={st === 'masked' || st === 'not_loaded' ? undefined : null} />;
  const t = rawText(v);
  return <span className="block max-w-[22rem] truncate" title={t.length > 2000 ? `${t.slice(0, 2000)}… (copier la ligne pour la valeur complète)` : t}>{t}</span>;
}

export function TableView({ table, window: w, onPage, busy = false }: {
  table: DossierTable; window?: DossierWindow; onPage?: (offset: number, q: string | null) => void; busy?: boolean;
}) {
  if (!table.rows.length && !w?.query) return <p className="text-xs text-muted-foreground italic">Aucune ligne en base ({table.table}).</p>;
  const off = w?.offset ?? 0;
  return (
    <div className="space-y-2">
      {w && onPage && <Pager w={w} shown={table.rows.length} onPage={onPage} busy={busy} />}
      {table.rows.length > 0 && (
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="px-1 py-1 w-7"><span className="sr-only">Copier</span></th>
                {table.columns.map((c) => <th key={c} className="px-2 py-1 font-mono font-medium whitespace-nowrap">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={off + i} className="border-b last:border-b-0 align-top">
                  <td className="px-1 py-1"><CopyButton text={() => JSON.stringify(r, null, 2)} label={`la ligne ${off + i + 1} (JSON)`} /></td>
                  {table.columns.map((c) => <td key={c} className="px-2 py-1"><Cell v={r[c]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!w && (
        <p className="text-[11px] text-muted-foreground">
          {fmtInt(table.rows.length)} ligne(s){table.total !== null ? ` sur ${fmtInt(table.total)} en base` : ''}
          {!table.complete && <span className="text-[color:var(--text-danger)] font-medium"> — lecture incomplète</span>}
        </p>
      )}
    </div>
  );
}

function downloadText(text: string, fileName: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SectionCard({ s, onNavigate, csvName, extra, actions }: {
  s: DossierSection;
  onNavigate: (type: EntityType, id: number) => void;
  /** Nom du CSV de section (même convention que l'export serveur). */
  csvName: (sectionId: string) => string;
  extra?: ReactNode;
  /** Lot 81C : pagination, export et copie INTÉGRAUX par le serveur (tiroir). */
  actions?: SectionActions;
}) {
  const [busy, setBusy] = useState(false);
  const partial = isPartialView(s);
  const onPage = actions ? (offset: number, q: string | null) => {
    setBusy(true);
    actions.loadPage(s.id, offset, q).catch((e) => toast.error(`Chargement impossible : ${e instanceof Error ? e.message : 'erreur'}`)).finally(() => setBusy(false));
  } : undefined;
  const copyJson = async () => {
    if (actions && (partial || s.window)) {
      setBusy(true);
      try { await actions.copySection(s); } finally { setBusy(false); }
      return;
    }
    await copyWithFeedback(JSON.stringify(s, null, 2), `la section « ${s.title} » (JSON)`);
  };
  const dlCls = 'inline-flex h-7 w-7 sm:h-6 sm:w-6 items-center justify-center rounded text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]';
  return (
    <section className="rounded-xl border bg-card" data-section={s.id}>
      <div className="flex items-start justify-between gap-2 px-4 py-2.5 border-b">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold break-words">{s.title}</h3>
          {s.description && <p className="text-[11px] text-muted-foreground">{s.description}</p>}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button type="button" aria-label={`Copier la section « ${s.title} » (JSON${s.window ? ', intégrale' : ''})`} title={s.window ? 'Copier la section entière (générée par le serveur)' : 'Copier la section (JSON)'}
            onClick={(e) => { e.stopPropagation(); void copyJson(); }} className={dlCls} disabled={busy}>
            <Copy className="h-3.5 w-3.5" />
          </button>
          {!s.error && (actions ? (
            <a href={actions.exportUrl(s.id, 'csv')} download aria-label={`Télécharger la section « ${s.title} » en CSV`} title="Télécharger la section entière (CSV généré par le serveur)" className={dlCls}>
              <Download className="h-3.5 w-3.5" />
            </a>
          ) : (
            <button
              type="button"
              aria-label={`Télécharger la section « ${s.title} » en CSV`}
              title={partial ? 'Export intégral : depuis le tiroir (serveur)' : 'Télécharger cette section (CSV)'}
              disabled={partial}
              onClick={() => { const t = sectionToCsv(s); if (t) downloadText(t, csvName(s.id), 'text/csv;charset=utf-8'); }}
              className={dlCls}
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </div>
      <div className="px-4 py-2.5 space-y-2">
        {s.error && <StateBadge state="not_loaded" note={s.error} />}
        {extra}
        {s.fields && <FieldsList fields={s.fields} />}
        {s.relations && <RelationsList relations={s.relations} onNavigate={onNavigate} window={s.window} onPage={onPage} busy={busy} />}
        {s.table && <TableView table={s.table} window={s.window} onPage={onPage} busy={busy} />}
      </div>
    </section>
  );
}
