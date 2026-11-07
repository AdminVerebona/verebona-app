"use client"

/**
 * Lot 113X (#722) — « Renseigner les dates » : interface contextuelle du coût
 * de possession (même mécanisme `Sheet` que « Dépenses retenues », à droite ;
 * pleine largeur sur mobile). Elle s'ouvre SEULE : jamais par-dessus un autre
 * tiroir latéral, et un lien vers un justificatif ou un événement de
 * référence la ferme avant d'ouvrir la fiche correspondante (les saisies en
 * cours sont conservées pour la réouverture).
 *
 * Liste immédiate : TOUTES et UNIQUEMENT les dépenses retenues sans date
 * fiable, telles que calculées par le serveur (`undatedExpenses` du DTO :
 * libellé, montant retenu, provenance, justificatifs, événement de
 * référence, date actuelle, champ métier de saisie). Aucune règle ici :
 *   · « Date effective de la dépense » (sélecteur de date) seulement quand le
 *     serveur a établi le champ métier où elle s'écrit ; sinon, l'explication
 *     et les liens vers la source à corriger ;
 *   · « Enregistrer » ligne par ligne, ou « Enregistrer les dates (N) » ;
 *     chaque saisie est indépendante (une date refusée n'empêche pas les
 *     autres) ; une date contradictoire avec la période de possession est
 *     signalée et enregistrée seulement après « Confirmer cette date » ;
 *   · laisser une dépense sans date et fermer : toujours possible, aucune
 *     date exigée ; #712 : « Conserver dans le TCO sans date » / « Annuler mon
 *     choix » (gestes du serveur, même route que les décisions du TCO).
 * Après enregistrement, le TCO recalculé rendu par le serveur remplace les
 * données affichées (ventilation, alerte, compteurs) sans rechargement.
 * Lecture seule : aucune saisie (le déclencheur n'est pas proposé).
 * Accessibilité : champs étiquetés, messages reliés (`aria-describedby`,
 * `role="alert"`), cibles de 44 px sur mobile ; charte Sérénité (jetons CSS).
 */
import { useEffect, useId, useState } from 'react';
import { CalendarDays, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { apiClient } from '@/lib/api-client';
import { drawerHref, openDrawer, type DrawerTarget } from '@/lib/drawers';
import type { TcoDto } from '@/services/business-operations/tco/dto';
import { TCO_UNDATED_TEXTS, type TcoUndatedExpense } from '@/services/business-operations/tco/undated-expenses';
import { TCO_UNDATED_LABELS } from '@/services/business-operations/tco/user-decisions';
import { TcoDecisionActions, type TcoArbitrate } from './tco-decision-actions';
import { openTcoJustificatif } from './tco-justificatif';

type Result = { lineId: string; outcome: string; message: string | null };
type Etat = { outcome: string; message: string | null };

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  assetId: number;
  tco: TcoDto;
  canEdit: boolean;
  arbitrate?: TcoArbitrate;
  onSaved: (tco: TcoDto) => void;
  onOwnWrite: (v: boolean) => void;
  /** Déclencheur (« Renseigner les dates ») : reprend le focus à la fermeture et après l'ouverture d'une fiche. */
  trigger?: HTMLElement | null;
}

const eur = (cents: number) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const jj = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const ENREGISTRE = new Set(['SAVED', 'UNCHANGED']);

export function TcoUndatedDatesSheet({ open, onOpenChange, assetId, tco, canEdit, arbitrate, onSaved, onOwnWrite, trigger }: Props) {
  const u = tco.undatedExpenses;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [etats, setEtats] = useState<Record<string, Etat>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [agenda, setAgenda] = useState<Record<number, number>>({});
  const baseId = useId();
  const today = tco.annual?.referenceDate ?? undefined;

  // Événements de référence ouvrables (élément d'agenda) : lus à l'ouverture, compte de la session.
  useEffect(() => {
    if (!open || !u.items.some((i) => i.operationId != null)) return;
    let actif = true;
    apiClient.get<{ undated: { items: Array<{ operationId: number | null; agendaItemId: number | null }> } }>(`/api/assets/${assetId}/tco/dates`)
      .then((r) => {
        if (!actif) return;
        const m: Record<number, number> = {};
        for (const i of r.undated.items) if (i.operationId != null && i.agendaItemId != null) m[i.operationId] = i.agendaItemId;
        setAgenda(m);
      })
      .catch(() => { /* liens vers l'événement de référence absents : la saisie reste possible */ });
    return () => { actif = false; };
  }, [open, assetId, u.items]);

  // Plus aucune dépense sans date : l'interface se ferme (aucun état positif compensatoire).
  useEffect(() => { if (open && u.count === 0) onOpenChange(false); }, [open, u.count, onOpenChange]);

  const saisissables = u.items.filter((i) => i.target.kind !== 'NONE');
  const remplies = saisissables.filter((i) => (drafts[i.lineId] ?? '').trim());

  const enregistrer = async (items: readonly TcoUndatedExpense[], confirm = false) => {
    const entries = items.filter((i) => (drafts[i.lineId] ?? '').trim())
      .map((i) => ({ lineId: i.lineId, lineKey: i.lineKey, date: drafts[i.lineId].trim(), ...(confirm ? { confirm: true } : {}) }));
    if (!entries.length) return;
    setBusy(items.length === 1 ? items[0].lineId : 'ALL');
    onOwnWrite(true);
    try {
      const r = await apiClient.post<{ results: Result[]; tco: TcoDto }>(`/api/assets/${assetId}/tco/dates`, { entries });
      onSaved(r.tco);
      const ok = r.results.filter((x) => ENREGISTRE.has(x.outcome) || x.outcome === 'SAVED_STILL_UNDATED');
      setDrafts((d) => { const n = { ...d }; for (const x of ok) delete n[x.lineId]; return n; });
      setEtats((s) => {
        const n = { ...s };
        for (const x of r.results) { if (ENREGISTRE.has(x.outcome)) delete n[x.lineId]; else n[x.lineId] = { outcome: x.outcome, message: x.message }; }
        return n;
      });
      const faites = r.results.filter((x) => x.outcome === 'SAVED').length;
      if (faites) toast.success(faites === 1 ? TCO_UNDATED_TEXTS.savedOne : TCO_UNDATED_TEXTS.savedMany(faites));
      // Fiche du bien affichée ailleurs sur la page (date d'achat) : relue par son mécanisme existant.
      if (faites && items.some((i) => i.target.kind === 'ASSET_FIELD')) window.dispatchEvent(new CustomEvent('asset-details-updated', { detail: { assetId } }));
    } catch (e) {
      toast.error((e as { serverMessage?: string }).serverMessage ?? 'Les dates n’ont pas pu être enregistrées. Réessayez.');
    } finally {
      onOwnWrite(false);
      setBusy(null);
    }
  };

  /** Lien vers une fiche : l'interface se ferme d'abord (jamais deux tiroirs empilés). */
  const ouvrir = (t: DrawerTarget) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpenChange(false);
    setTimeout(() => {
      if (t.kind === 'document') void openTcoJustificatif({ currentTarget: trigger ?? null, preventDefault: () => {} }, t.id);
      else openDrawer(t);
    }, 0);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right" id="tco-undated-drawer" className="w-full sm:max-w-lg flex flex-col gap-0 p-0" data-tco-undated-drawer
        onCloseAutoFocus={(e) => { if (trigger && trigger.isConnected) { e.preventDefault(); trigger.focus(); } }}
      >
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
          <SheetTitle>{`${TCO_UNDATED_TEXTS.panelTitle} (${u.count})`}</SheetTitle>
          <SheetDescription>{TCO_UNDATED_TEXTS.panelDescription}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-3">
          <ul className="divide-y divide-border" aria-label={TCO_UNDATED_TEXTS.panelTitle}>
            {u.items.map((i) => {
              const idChamp = `${baseId}-${i.lineId}`;
              const idMsg = `${idChamp}-msg`;
              const etat = etats[i.lineId];
              const saisie = canEdit && i.target.kind !== 'NONE';
              const occupe = busy === i.lineId || busy === 'ALL';
              return (
                <li key={i.lineId} className="py-3 space-y-2" data-tco-undated-item={i.lineId} data-tco-undated-target={i.target.kind}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[color:var(--text-primary)] break-words" data-tco-undated-label>{i.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {TCO_UNDATED_TEXTS.origins[i.origin]}
                        {i.category ? ` · ${tco.categoryLabels[i.category]}` : ''}
                        {i.operationLabel && i.origin !== 'OPERATION' ? ` · ${i.operationLabel}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums text-[color:var(--text-primary)]" data-tco-undated-amount={i.amountCents}>{eur(i.amountCents)}</span>
                  </div>
                  {/* Références cliquables : justificatifs et événement de référence (s'ils existent). */}
                  {(i.documents.length > 0 || (i.operationId != null && agenda[i.operationId] != null)) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {i.documents.map((d, n) => (
                        <a
                          key={d.fileId}
                          href={drawerHref({ kind: 'document', id: d.fileId }, '/documents')}
                          onClick={ouvrir({ kind: 'document', id: d.fileId })}
                          className="inline-flex min-h-[44px] md:min-h-0 items-center text-xs text-primary hover:underline"
                          data-tco-undated-doc={d.fileId}
                        >
                          {d.title ? `Justificatif : ${d.title}` : i.documents.length > 1 ? `Justificatif ${n + 1}` : 'Justificatif'}
                        </a>
                      ))}
                      {i.operationId != null && agenda[i.operationId] != null && (
                        <a
                          href={drawerHref({ kind: 'echeance', id: agenda[i.operationId] }, '/agenda')}
                          onClick={ouvrir({ kind: 'echeance', id: agenda[i.operationId] })}
                          className="inline-flex min-h-[44px] md:min-h-0 items-center text-xs text-primary hover:underline"
                          data-tco-undated-reference={agenda[i.operationId]}
                        >
                          {TCO_UNDATED_TEXTS.reference}{i.operationLabel ? ` : ${i.operationLabel}` : ''}
                        </a>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground" data-tco-undated-current>
                    {TCO_UNDATED_TEXTS.currentDate} : {i.currentDate ? jj(i.currentDate) : TCO_UNDATED_TEXTS.noDate}
                  </p>
                  {i.confirmedUndated && <p className="text-xs text-muted-foreground" data-tco-undated-confirmed>{TCO_UNDATED_LABELS.decided}</p>}
                  {saisie ? (
                    <div className="space-y-1.5">
                      <label htmlFor={idChamp} className="text-xs font-medium text-[color:var(--text-primary)] flex items-center gap-1.5">
                        <CalendarDays className="w-3.5 h-3.5 text-muted-foreground" aria-hidden /> {TCO_UNDATED_TEXTS.field}
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          id={idChamp} type="date" max={today} value={drafts[i.lineId] ?? ''}
                          onChange={(e) => { const v = e.target.value; setDrafts((d) => ({ ...d, [i.lineId]: v })); setEtats((s) => { const n = { ...s }; delete n[i.lineId]; return n; }); }}
                          aria-describedby={idMsg} aria-invalid={etat ? true : undefined}
                          className="min-h-[44px] md:min-h-[36px] rounded-md border border-border bg-background px-2 text-sm text-[color:var(--text-primary)]"
                          data-tco-undated-input={i.lineId}
                        />
                        <Button
                          type="button" size="sm" variant="outline" className="min-h-[44px] md:min-h-0"
                          disabled={!(drafts[i.lineId] ?? '').trim() || !!busy}
                          onClick={() => void enregistrer([i])} data-tco-undated-save={i.lineId}
                        >
                          {busy === i.lineId && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden />}{TCO_UNDATED_TEXTS.saveOne}
                        </Button>
                      </div>
                      <p id={idMsg} className="text-xs text-muted-foreground">{TCO_UNDATED_TEXTS.targets[i.target.kind as keyof typeof TCO_UNDATED_TEXTS.targets]}</p>
                    </div>
                  ) : (
                    <p id={idMsg} className="text-xs text-muted-foreground" data-tco-undated-no-field>{i.target.kind === 'NONE' ? TCO_UNDATED_TEXTS.noField : null}{i.note && i.target.kind === 'NONE' ? ` ${i.note}` : ''}</p>
                  )}
                  {etat?.message && (
                    <div className="space-y-1">
                      <p className="text-xs text-[color:var(--attention-on-soft)]" role="alert" data-tco-undated-error={etat.outcome}>{etat.message}</p>
                      {etat.outcome === 'NEEDS_CONFIRMATION' && canEdit && (
                        <Button type="button" size="sm" variant="outline" className="min-h-[44px] md:min-h-0" disabled={occupe || !!busy}
                          onClick={() => void enregistrer([i], true)} data-tco-undated-confirm={i.lineId}>
                          {TCO_UNDATED_TEXTS.confirmDate}
                        </Button>
                      )}
                    </div>
                  )}
                  {/* #712 : conserver sans date (ou annuler ce choix) — gestes du serveur, jamais exigés. */}
                  {canEdit && arbitrate && i.options.length > 0 && (
                    <TcoDecisionActions lineId={i.lineId} lineKey={i.lineKey} options={i.options} onDecide={arbitrate} />
                  )}
                </li>
              );
            })}
          </ul>
          {u.truncated && (
            <p className="text-xs text-muted-foreground pt-2" data-tco-undated-truncated>{`Liste abrégée : ${u.items.length} dépense(s) présentée(s) sur ${u.count}.`}</p>
          )}
        </div>
        <div className="border-t border-border px-5 py-3 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-[44px] md:min-h-0" onClick={() => onOpenChange(false)} data-tco-undated-close>{TCO_UNDATED_TEXTS.close}</Button>
          {canEdit && saisissables.length > 1 && (
            <Button type="button" className="min-h-[44px] md:min-h-0" disabled={remplies.length === 0 || !!busy} onClick={() => void enregistrer(remplies)} data-tco-undated-save-all>
              {busy === 'ALL' && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden />}{TCO_UNDATED_TEXTS.saveAll(remplies.length)}
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
