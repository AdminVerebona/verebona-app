"use client";

/**
 * Carte #744, travaux D (CDC « Opérations / Agenda V2.0 » §14 ; AC01, AC22,
 * AC41) — CONTENU de la page entière d'un événement de référence (desktop et
 * mobile : même composant, une colonne sur mobile, deux sur grand écran ;
 * charte Sérénité, jetons de couleur seulement ; cibles tactiles de 44 px).
 *
 * Présentation pure : la page (`/agenda/evenements-reference/[id]`) lit la
 * fiche, fournit les ouvertures et, quand l'écriture est possible, les gestes
 * (`actions` — travaux D « écriture » : corriger, supprimer, rattacher /
 * détacher, associer / dissocier, déplacer un document). Sans `actions`, la
 * page est consultée sans rien proposer. Ni tiroir, ni onglets, ni état (« en
 * cours », « réalisé », « annulé »), ni progression. Une rubrique n'est
 * affichée que si elle contient quelque chose. Sans date propre : « Sans
 * date » — aucune date n'est inventée, aucune comparaison avec la date du
 * jour. Le mot « Opération » n'apparaît jamais.
 */
import Link from "next/link";
import { Building2, CalendarDays, ChevronRight, FileText, Gauge, Home, Layers, MessageSquareText, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { COVERAGE_HISTORY_EMPTY, COVERAGE_HISTORY_TITLE } from "@/lib/documents/business-periods";
import { REFERENCE_EVENT_DOCUMENTS_TITLE, REFERENCE_EVENT_TITLE } from "@/lib/documents/business-period-surfaces";
import {
  REFERENCE_EVENT_PAGE_LABELS as L, referenceEventDay, referenceEventHref, referenceEventRelationLabel,
} from "@/lib/reference-events/reference-event-page";
import { REFERENCE_EVENT_WRITE_LABELS as W } from "@/lib/reference-events/reference-event-write";
import {
  REFERENCE_EVENT_NOTES_LABELS as N, REFERENCE_EVENT_SUMMARY_LABELS as S, referenceEventSummaryEntries,
} from "@/lib/reference-events/reference-event-summary";
import { supplierHref } from "@/lib/supplier-routes";
import type { ReferenceEventPageView } from "@/services/business-operations/graph/reference-event-page";
import { CoverageHistoryList } from "@/components/documents/BusinessPeriods";
import type { ReferenceEventPageActions } from "./ReferenceEventWrite";

export interface ReferenceEventPageOpeners {
  openDocument: (fileId: number) => void;
  openAgendaItem: (id: number) => void;
  openEquipment: (id: number) => void;
  /** Une période a été corrigée (même fait que le document) : la fiche est relue. */
  onPeriodsSaved: () => void;
}

const ROW = "flex min-h-[44px] w-full min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-muted/40";
const BTN = "h-11 md:h-9";

/**
 * Ligne d'une rubrique, avec ses gestes propres à droite s'il y en a
 * (« Détacher », « Retirer », « Déplacer », « Dissocier ») : l'ouverture de
 * l'objet reste le geste principal de la ligne.
 */
function Row({ children, gestes }: { children: React.ReactNode; gestes?: React.ReactNode }) {
  if (!gestes) return <li>{children}</li>;
  return <li className="flex items-center gap-1">{children}{gestes}</li>;
}

function RowAction({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="h-11 shrink-0 px-2 text-xs md:h-9" onClick={onClick} data-testid={testId}>
      {label}
    </Button>
  );
}

function Section({ icon: Icon, title, count, testId, children }: {
  icon: React.ElementType; title: string; count?: number; testId: string; children: React.ReactNode;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          {title}
          {count !== undefined && <span className="text-sm font-normal text-muted-foreground">({count})</span>}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function RowBody({ title, subtitle, aside }: { title: string; subtitle?: string | null; aside?: string | null }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[color:var(--text-primary)]">{title}</span>
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      {aside && <span className="shrink-0 text-xs text-muted-foreground">{aside}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </>
  );
}

export function ReferenceEventPageContent({ fiche, openers, actions }: {
  fiche: ReferenceEventPageView; openers: ReferenceEventPageOpeners;
  /** Gestes d'écriture ; absents : page consultée sans rien proposer (aperçu, test). */
  actions?: ReferenceEventPageActions;
}) {
  // Carte #744, travaux D — contenu : repères factuels (aucun montant inventé ; une rubrique vide n'apparaît pas).
  const reperes = referenceEventSummaryEntries(fiche.summary);
  const note = fiche.notes ?? null;
  const vide = fiche.declarations.length === 0 && fiche.assets.length === 0 && fiche.equipments.length === 0
    && fiche.suppliers.length === 0 && fiche.coverages.length === 0 && fiche.documents.length === 0
    && fiche.agendaItems.length === 0 && fiche.relations.length === 0 && reperes.length === 0 && note === null;
  const couverture = fiche.coverages.length > 0 || fiche.typeCode === "CONTRACT";
  // « Votre déclaration » réunit ce que l'utilisateur a dit : ses déclarations et sa note libre. Sans écriture
  // possible (lecture seule, aperçu) et sans rien à montrer, la rubrique n'apparaît pas.
  const parole = fiche.declarations.length > 0 || note !== null || actions !== undefined;
  return (
    <div className="space-y-6" data-testid="reference-event-page" data-reference-event-id={fiche.id}>
      <Card>
        <CardContent className="pt-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[color:var(--accent-soft)]">
              <Layers className="h-5 w-5 text-[color:var(--accent)]" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-muted-foreground">{REFERENCE_EVENT_TITLE}</p>
              <h1 className="vb-app-title [overflow-wrap:anywhere]" data-testid="reference-event-page-title">{fiche.title}</h1>
              {fiche.undated ? (
                <p className="mt-2 text-sm text-muted-foreground" data-testid="reference-event-page-undated">{L.undated}</p>
              ) : (
                <dl className="mt-2 flex flex-col gap-x-6 gap-y-1 text-sm sm:flex-row sm:flex-wrap" aria-label={L.datesTitle} data-testid="reference-event-page-dates">
                  {fiche.dates.map((d) => (
                    <div key={d.role} className="flex gap-1.5" data-date-role={d.role}>
                      <dt className="text-muted-foreground">{L.dateRoles[d.role]}</dt>
                      <dd className="font-medium text-[color:var(--text-primary)]">{referenceEventDay(d.date)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {/* Carte #744, point F : repère de présentation quand il ne vient pas d'une date propre (premier devis, première couverture connue). */}
              {fiche.presentation?.date && fiche.presentation.label && <p className="mt-1 text-sm text-muted-foreground" data-testid="reference-event-page-presentation">{fiche.presentation.label} : <span className="text-[color:var(--text-primary)]">{referenceEventDay(fiche.presentation.date)}</span></p>}
              {fiche.provider && (
                <p className="mt-1 text-sm text-muted-foreground" data-testid="reference-event-page-provider">
                  {L.providerTitle} : <span className="text-[color:var(--text-primary)]">{fiche.provider}</span>
                </p>
              )}
            </div>
          </div>
          {actions && (
            <div
              className="mt-4 flex flex-wrap items-center gap-2 border-t border-[color:var(--border-subtle)] pt-4"
              aria-label={W.addTitle} data-testid="reference-event-page-actions"
            >
              <Button type="button" size="sm" className={BTN} onClick={actions.correct} data-testid="reference-event-action-correct">{W.correct}</Button>
              <Button type="button" size="sm" variant="outline" className={BTN} onClick={actions.linkAgenda} data-testid="reference-event-action-link-agenda">{W.linkAgenda}</Button>
              <Button type="button" size="sm" variant="outline" className={BTN} onClick={actions.linkDocument} data-testid="reference-event-action-link-document">{W.linkDocument}</Button>
              <Button type="button" size="sm" variant="outline" className={BTN} onClick={actions.linkSupplier} data-testid="reference-event-action-link-supplier">{W.linkSupplier}</Button>
              <Button type="button" size="sm" variant="outline" className={BTN} onClick={actions.associate} data-testid="reference-event-action-associate">{W.associate}</Button>
              {/* Scinder (CDC §7, §14 ; AC46) : proposé seulement quand la fiche porte un fait déplaçable. */}
              {actions.split && (
                <Button type="button" size="sm" variant="outline" className={BTN} onClick={actions.split} data-testid="reference-event-action-split">{W.split}</Button>
              )}
              <Button
                type="button" size="sm" variant="ghost" className={`${BTN} text-[color:var(--danger)]`}
                onClick={actions.remove} data-testid="reference-event-action-delete"
              >
                {W.delete}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {vide && <p className="text-sm text-muted-foreground" data-testid="reference-event-page-empty">{L.empty}</p>}

      {/* Synthèse FACTUELLE (CDC §14, §18) : chiffres lus dans ce qui est déjà enregistré, aucun appel IA. */}
      {reperes.length > 0 && (
        <Section icon={Gauge} title={S.title} testId="reference-event-page-summary">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {reperes.map((r) => (
              <div key={r.key} className="min-w-0" data-summary-key={r.key}>
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="vb-tabular text-sm font-medium text-[color:var(--text-primary)] [overflow-wrap:anywhere]">{r.value}</dd>
                {r.hint && <p className="mt-0.5 text-xs text-muted-foreground">{r.hint}</p>}
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">{S.note}</p>
        </Section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {parole && (
          <Section icon={MessageSquareText} title={L.declarationsTitle} testId="reference-event-page-declarations">
            {fiche.declarations.length > 0 && (
              <ul className="space-y-3">
                {fiche.declarations.map((d) => (
                  <li key={d.id}>
                    <p className="whitespace-pre-wrap text-sm text-[color:var(--text-primary)] [overflow-wrap:anywhere]">{d.text}</p>
                    {referenceEventDay(d.declaredOn) && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{L.declaredOn} {referenceEventDay(d.declaredOn)}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {/* « Notes / Description » : le texte libre de l'utilisateur, jamais réécrit, jamais compté. */}
            {(note !== null || actions) && (
              <div className={fiche.declarations.length > 0 ? "mt-4 border-t border-[color:var(--border-subtle)] pt-4" : ""} data-testid="reference-event-page-notes">
                <p className="text-xs font-semibold text-muted-foreground">{N.field}</p>
                {note ? (
                  <>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-[color:var(--text-primary)] [overflow-wrap:anywhere]" data-testid="reference-event-page-notes-text">{note.text}</p>
                    {referenceEventDay(note.updatedOn) && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{N.updatedOn} {referenceEventDay(note.updatedOn)}</p>
                    )}
                  </>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">{N.empty}</p>
                )}
                {actions?.editNotes && (
                  <Button
                    type="button" size="sm" variant="outline" className={`${BTN} mt-2`}
                    onClick={actions.editNotes} data-testid="reference-event-action-notes"
                  >
                    {note ? N.edit : N.add}
                  </Button>
                )}
              </div>
            )}
          </Section>
        )}

        {fiche.assets.length > 0 && (
          <Section icon={Home} title={L.assetsTitle} count={fiche.assets.length} testId="reference-event-page-assets">
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {fiche.assets.map((a) => (
                <li key={a.id}><Link href={`/assets/${a.id}`} className={ROW}><RowBody title={a.name} /></Link></li>
              ))}
            </ul>
          </Section>
        )}

        {fiche.equipments.length > 0 && (
          <Section icon={Settings} title={L.equipmentsTitle} count={fiche.equipments.length} testId="reference-event-page-equipments">
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {fiche.equipments.map((e) => (
                <li key={e.id}>
                  <button type="button" className={ROW} onClick={() => openers.openEquipment(e.id)}><RowBody title={e.name} subtitle={e.assetName} /></button>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {fiche.suppliers.length > 0 && (
          <Section icon={Building2} title={L.suppliersTitle} count={fiche.suppliers.length} testId="reference-event-page-suppliers">
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {fiche.suppliers.map((s) => (
                <Row
                  key={s.id}
                  gestes={actions && <RowAction label={W.unlinkSupplier} onClick={() => actions.unlinkSupplier(s.id, s.name)} testId={`reference-event-unlink-supplier-${s.id}`} />}
                >
                  <Link href={supplierHref(s.id)} className={ROW}><RowBody title={s.name} /></Link>
                </Row>
              ))}
            </ul>
          </Section>
        )}

        {couverture && (
          <Card data-testid="reference-event-page-coverages">
            <CardContent className="pt-6">
              {fiche.coverages.length > 0
                ? <CoverageHistoryList coverages={fiche.coverages} onOpenDocument={openers.openDocument} onSaved={openers.onPeriodsSaved} />
                : (
                  <div className="space-y-1" data-testid="coverage-history-empty">
                    <p className="text-xs font-semibold text-muted-foreground">{COVERAGE_HISTORY_TITLE}</p>
                    <p className="text-sm text-muted-foreground">{COVERAGE_HISTORY_EMPTY}</p>
                  </div>
                )}
            </CardContent>
          </Card>
        )}

        {fiche.documents.length > 0 && (
          <Section icon={FileText} title={REFERENCE_EVENT_DOCUMENTS_TITLE} count={fiche.documents.length} testId="reference-event-page-documents">
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {fiche.documents.map((d) => (
                <Row
                  key={d.fileId}
                  gestes={actions && (
                    <>
                      <RowAction label={W.moveDocument} onClick={() => actions.moveDocument(d.fileId, d.title)} testId={`reference-event-move-document-${d.fileId}`} />
                      <RowAction label={W.unlinkDocument} onClick={() => actions.unlinkDocument(d.fileId, d.title)} testId={`reference-event-unlink-document-${d.fileId}`} />
                    </>
                  )}
                >
                  <button type="button" className={ROW} onClick={() => openers.openDocument(d.fileId)} aria-label={`Ouvrir le document : ${d.title}`}>
                    <RowBody title={d.title} aside={referenceEventDay(d.date)} />
                  </button>
                </Row>
              ))}
            </ul>
          </Section>
        )}

        {fiche.agendaItems.length > 0 && (
          <Section icon={CalendarDays} title={L.eventsTitle} count={fiche.agendaItems.length} testId="reference-event-page-events">
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {fiche.agendaItems.map((a) => (
                <Row
                  key={a.id}
                  gestes={actions && <RowAction label={W.unlinkAgenda} onClick={() => actions.unlinkAgenda(a.id, a.title)} testId={`reference-event-unlink-agenda-${a.id}`} />}
                >
                  <button type="button" className={ROW} onClick={() => openers.openAgendaItem(a.id)} data-reference-event-agenda-item={a.id}>
                    <RowBody title={a.title} subtitle={a.shared ? L.shared : null} aside={referenceEventDay(a.date) ?? L.undated} />
                  </button>
                </Row>
              ))}
            </ul>
          </Section>
        )}

        {fiche.relations.length > 0 && (
          <Section icon={Layers} title={L.relationsTitle} count={fiche.relations.length} testId="reference-event-page-relations">
            <ul className="divide-y divide-[color:var(--border-subtle)]">
              {fiche.relations.map((r) => (
                <Row
                  key={`${r.nature}-${r.direction}-${r.operationId}`}
                  gestes={actions && <RowAction label={W.dissociate} onClick={() => actions.dissociate(r.operationId, r.label)} testId={`reference-event-dissociate-${r.operationId}`} />}
                >
                  <Link href={referenceEventHref(r.operationId)} className={ROW} data-reference-event-relation={r.operationId}>
                    <RowBody title={r.label} subtitle={referenceEventRelationLabel(r.nature, r.direction)} />
                  </Link>
                </Row>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
