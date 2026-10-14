"use client"

/**
 * Rubrique « Sinistres » de la fiche bien — vues PRÉSENTATIONNELLES (lot 44,
 * O5 ; CDC Opérations V1 ch. 15.2, B14 ; décisions PO Q2, Q3, Q11).
 *
 *   · `ClaimsListView` : sinistres du bien (plusieurs par bien), ancienne
 *     saisie non reprise, ajout ;
 *   · `ClaimFormView`  : formulaire d'un sinistre — mêmes champs que l'ancien
 *     formulaire (type, dates, références, avancement du dossier, textes,
 *     dommages, actions, échanges, montants), biens concernés (un sinistre
 *     peut concerner plusieurs biens), événement de l'agenda lié.
 *
 * Mêmes composants et jetons que le reste de la fiche ; une seule mise en
 * page responsive (une colonne sur mobile, grille sur bureau). Aucun terme
 * technique : le mot « Opération » n'apparaît jamais (P09). Fonctions pures
 * de leurs props (rendu statique testable, captures).
 */
import { AlertCircle, ArrowLeft, FileText, Info, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  CLAIM_STATUS_OPTIONS, fieldsFor, formatCentsForInput, listFormState,
  type AdditionalInfoFieldDef, type AdditionalInfoReferencesDto, type ListItem,
} from '@/lib/assets/additional-infos';
import type { AutosaveState } from '@/lib/assets/additional-infos-autosave';
import type { ExportFamily } from '@/services/exports/catalog';
import { AdditionalInfoFieldInput, NONE_VALUE, SaveIndicator } from '../additional-infos/AdditionalInfoFieldInput';
import { AdditionalInfosListField } from '../additional-infos/AdditionalInfosListField';

// ── Types partagés avec le conteneur (réponses de `/api/assets/[id]/claims*`) ──

export interface ClaimSummary {
  id: number;
  label: string;
  claimType: string | null;
  occurredOn: string | null;
  status: string | null;
  insurerClaimRef: string | null;
  estimatedDamageCents: number | null;
  compensationCents: number | null;
  otherAssets: Array<{ id: number; name: string }>;
  documented: boolean;
  closed: boolean;
}

export interface LegacyClaim {
  claim: Record<string, unknown>;
  label: string;
  reason: 'BELOW_THRESHOLD' | 'HOLD_AMBIGUOUS' | 'PENDING';
}

export interface ClaimCostsView { grossCents: number; indemnityCents: number; netCents: number }

const euros = (cents: number | null | undefined) => (cents == null ? null : `${formatCentsForInput(cents)} €`);
const statusLabel = (v: string | null) => CLAIM_STATUS_OPTIONS.find((o) => o.value === v)?.label ?? null;

// ── Liste ───────────────────────────────────────────────────────────────────

export function ClaimsListView({
  claims, legacy, readOnly, busy, onAdd, onOpen, onResumeLegacy,
}: {
  claims: ClaimSummary[];
  legacy: LegacyClaim | null;
  readOnly: boolean;
  busy?: boolean;
  onAdd: () => void;
  onOpen: (id: number) => void;
  onResumeLegacy: () => void;
}) {
  return (
    <div className="space-y-3" data-claims-list>
      {legacy && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-2" role="status">
          <p className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <span className="font-semibold">Saisie précédente : {legacy.label}.</span>{' '}
              {legacy.reason === 'HOLD_AMBIGUOUS'
                ? 'Elle pourrait correspondre à plusieurs sinistres de ce bien : reprenez-la pour en faire un sinistre distinct, ou complétez le bon sinistre ci-dessous.'
                : 'Elle reste utilisée par vos dossiers tant que vous ne l’avez pas reprise en sinistre.'}
            </span>
          </p>
          {!readOnly && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onResumeLegacy}>Reprendre en sinistre</Button>
          )}
        </div>
      )}
      {claims.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun sinistre enregistré pour ce bien. Dégât des eaux, vol, accident… : notez-le ici pour suivre votre dossier avec l’assureur.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {claims.map((c) => {
            const meta = [statusLabel(c.status), c.insurerClaimRef ? `Réf. ${c.insurerClaimRef}` : null,
              c.compensationCents != null ? `Indemnité ${euros(c.compensationCents)}` : c.estimatedDamageCents != null ? `Estimé ${euros(c.estimatedDamageCents)}` : null]
              .filter(Boolean).join(' · ');
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  className="w-full flex items-start gap-3 px-3 py-3 text-left hover:bg-muted/40 focus-visible:bg-muted/40 outline-none"
                  data-claim-id={c.id}
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium break-words sm:truncate">{c.label}</span>
                    {meta && <span className="block text-xs text-muted-foreground break-words sm:truncate">{meta}</span>}
                    {c.otherAssets.length > 0 && (
                      <span className="block text-[11px] text-muted-foreground break-words sm:truncate">Concerne aussi : {c.otherAssets.map((a) => a.name).join(', ')}</span>
                    )}
                  </span>
                  <span className="shrink-0 flex flex-col items-end gap-1">
                    {c.closed && <span className="text-[10px] font-medium text-muted-foreground bg-muted rounded-full px-1.5 py-0.5">Clos</span>}
                    {c.documented && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground" title="Établi aussi par vos documents">
                        <FileText className="w-3 h-3" aria-hidden /><span className="hidden sm:inline">Documents</span>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && (
        <Button type="button" size="sm" variant="outline" onClick={onAdd} disabled={busy} className="w-full sm:w-auto">
          <Plus className="w-3.5 h-3.5 mr-1" />Ajouter un sinistre
        </Button>
      )}
    </div>
  );
}

// ── Formulaire ──────────────────────────────────────────────────────────────

const frDate = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

export interface ClaimFormViewProps {
  /** null : brouillon pas encore enregistré (lot 53, D10). */
  claimId: number | null;
  /** Lot 53 (D10) : brouillon — rien n'existe en base avant la première saisie effective. */
  draft?: boolean;
  idPrefix: string;
  family: ExportFamily | null;
  title: string;
  inputs: Record<string, string>;
  errors: Record<string, string>;
  lists: Record<string, ListItem[]>;
  listLocalErrors: Record<string, boolean>;
  references: AdditionalInfoReferencesDto | null;
  readOnly: boolean;
  saveState: AutosaveState;
  notice: string | null;
  /** Biens du compte et biens concernés (au moins un). */
  assetOptions: Array<{ id: number; name: string }>;
  assetIds: number[];
  currentAssetId: number;
  costs: ClaimCostsView | null;
  contractLabel: string | null;
  documented: boolean;
  /** Variante intégrée (écran de préparation d'un dossier) : une colonne, sans bouton retour. */
  compact?: boolean;
  onBack?: () => void;
  onChange: (def: AdditionalInfoFieldDef, raw: string) => void;
  onBlur: (def: AdditionalInfoFieldDef) => void;
  onListChange: (def: AdditionalInfoFieldDef, items: ListItem[], opts?: { localError?: boolean }) => void;
  onEventChange: (def: AdditionalInfoFieldDef, key: string) => void;
  onToggleAsset: (assetId: number, checked: boolean) => void;
  onRetry: () => void;
  onDismissNotice: () => void;
  onDelete?: () => void;
}

export function ClaimFormView(p: ClaimFormViewProps) {
  const defs = fieldsFor('claim', p.family);
  const grid = defs.filter((d) => d.type !== 'list' && d.type !== 'eventRef');
  const eventDef = defs.find((d) => d.type === 'eventRef');
  const listDefs = defs.filter((d) => d.type === 'list');
  const events = p.references?.claimEvents ?? [];
  const eventValue = p.inputs['claim.claimEventKey'] ?? '';
  const knownEvent = !eventValue || events.some((e) => e.key === eventValue);
  const autres = p.assetOptions.filter((a) => a.id !== p.currentAssetId);

  return (
    <div className="space-y-5" data-claim-form={p.claimId ?? 'draft'} data-claim-draft={p.draft ? 'true' : undefined}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {p.onBack && !p.compact && (
            <Button type="button" variant="ghost" size="sm" onClick={p.onBack} aria-label="Retour à la liste des sinistres">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          )}
          <p className="text-sm font-semibold truncate">{p.title}</p>
        </div>
        <SaveIndicator state={p.saveState} onRetry={p.onRetry} />
      </div>

      {p.notice && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{p.notice}</span>
          <button type="button" onClick={p.onDismissNotice} className="underline underline-offset-2 hover:text-foreground">Compris</button>
        </div>
      )}
      {p.draft && (
        <p className="text-[11px] text-muted-foreground leading-snug" data-claim-draft-hint>
          Brouillon : ce sinistre sera enregistré dès votre première saisie. Si vous revenez en arrière sans rien saisir, rien n’est conservé.
        </p>
      )}
      {p.documented && (
        <p className="text-[11px] text-muted-foreground leading-snug">
          Certaines informations proviennent de vos documents (constat, déclaration, courriers de l’assureur) ; ce que vous saisissez ici prime.
        </p>
      )}

      <fieldset disabled={p.readOnly} className="space-y-5">
        {autres.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground font-medium">Biens concernés</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {p.assetOptions.map((a) => {
                const checked = p.assetIds.includes(a.id);
                const seul = checked && p.assetIds.length === 1;
                const id = `${p.idPrefix}-asset-${a.id}`;
                return (
                  <label key={a.id} htmlFor={id} className="inline-flex items-center gap-2 text-sm">
                    <Checkbox id={id} checked={checked} disabled={p.readOnly || seul} onCheckedChange={(v) => p.onToggleAsset(a.id, v === true)} />
                    <span className={a.id === p.currentAssetId ? 'font-medium' : undefined}>{a.name}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground/80 leading-snug">Un même sinistre peut toucher plusieurs biens (ex. un dégât des eaux sur la maison et le mobilier).</p>
          </div>
        )}

        {eventDef && (
          <div className="space-y-1.5">
            <Label htmlFor={`${p.idPrefix}-event`} className="text-xs text-muted-foreground font-medium">{eventDef.label}</Label>
            <Select value={eventValue || NONE_VALUE} disabled={p.readOnly || !p.references} onValueChange={(v) => p.onEventChange(eventDef, v === NONE_VALUE ? '' : v)}>
              <SelectTrigger id={`${p.idPrefix}-event`} className="w-full text-sm" aria-invalid={!!p.errors['claim.claimEventKey']}>
                <SelectValue placeholder={p.references ? 'Aucun' : 'Chargement…'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>Aucun</SelectItem>
                {!knownEvent && <SelectItem value={eventValue}>Événement supprimé ou annulé</SelectItem>}
                {events.map((e) => <SelectItem key={e.key} value={e.key}>{[frDate(e.date), e.title].filter(Boolean).join(' · ')}</SelectItem>)}
              </SelectContent>
            </Select>
            {p.errors['claim.claimEventKey']
              ? <p className="text-[11px] text-red-400">{p.errors['claim.claimEventKey']}</p>
              : <p className="text-[11px] text-muted-foreground/80 leading-snug">Facultatif : relie ce sinistre à l’événement déjà présent dans votre agenda, sans le dupliquer.</p>}
          </div>
        )}

        <div className={`grid grid-cols-1 gap-4 ${p.compact ? '' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
          {grid.map((def) => {
            const path = `claim.${def.key}`;
            return (
              <AdditionalInfoFieldInput
                key={path}
                def={def.key === 'policyReference' && p.contractLabel ? { ...def, help: `Contrat reconnu : ${p.contractLabel}.` } : def}
                inputId={`${p.idPrefix}-${def.key}`}
                value={p.inputs[path] ?? ''}
                error={p.errors[path]}
                readOnly={p.readOnly}
                wide={!p.compact}
                onChange={(raw) => p.onChange(def, raw)}
                onBlur={() => p.onBlur(def)}
              />
            );
          })}
        </div>

        {p.costs && (p.costs.grossCents > 0 || p.costs.indemnityCents > 0) && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs" data-claim-costs>
            <div><p className="text-muted-foreground">Coût des réparations</p><p className="font-semibold">{euros(p.costs.grossCents)}</p></div>
            <div><p className="text-muted-foreground">Indemnité reçue</p><p className="font-semibold">{euros(p.costs.indemnityCents)}</p></div>
            <div><p className="text-muted-foreground">Reste à votre charge</p><p className="font-semibold">{euros(p.costs.netCents)}</p></div>
          </div>
        )}

        {listDefs.map((def) => {
          const path = `claim.${def.key}`;
          const items = p.lists[path] ?? [];
          const state = listFormState(def, items);
          return (
            <div key={path} className="pt-1">
              <AdditionalInfosListField
                def={def}
                items={items}
                onChange={(next, opts) => p.onListChange(def, next, opts)}
                rowErrors={state.rowErrors}
                listError={state.listError ?? p.errors[path] ?? (p.listLocalErrors[path] ? 'Corrigez la saisie signalée : la liste sera enregistrée ensuite.' : null)}
                references={p.references}
                readOnly={p.readOnly}
                idPrefix={`${p.idPrefix}-${def.key}`}
                compact={p.compact}
              />
            </div>
          );
        })}
      </fieldset>

      {p.onDelete && !p.readOnly && (
        <div className="pt-2 border-t border-border">
          <Button type="button" variant="ghost" size="sm" onClick={p.onDelete} className="text-red-400 hover:text-red-500">
            <Trash2 className="w-3.5 h-3.5 mr-1" />{p.draft ? 'Abandonner ce brouillon' : 'Supprimer ce sinistre'}
          </Button>
        </div>
      )}
    </div>
  );
}
