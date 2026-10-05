'use client';

import { Button } from '@/components/ui/button';
import {
  splitTriggers, selectTrigger, setTriggerActive, removeTrigger, emptyListExplanation, removalEmptiesWarning,
  type ApplicableTrigger, type CatalogTrigger, type TriggerSetting,
} from './triggers-model';

/**
 * Bloc « Déclencheurs » d'un traitement (BO IA, ticket T4).
 *
 * Deux groupes : les déclencheurs disponibles (sélectionner, activer,
 * désactiver, retirer) et les déclencheurs enregistrés incompatibles
 * (consulter le motif, supprimer). Le caractère « master » d'un traitement ne
 * masque jamais ce bloc : seul son caractère synchrone (T2, T5, T6) le fait,
 * et même alors une entrée enregistrée reste visible et supprimable.
 */
export function TriggersEditor({
  treatment, batch, saved, applicable, catalog, defaults, readOnly, onChange,
}: {
  treatment: string;
  batch: boolean;
  saved: TriggerSetting[];
  applicable: ApplicableTrigger[];
  catalog: CatalogTrigger[] | undefined;
  defaults: string[];
  readOnly: boolean;
  onChange: (next: TriggerSetting[]) => void;
}) {
  const { available, incompatible } = splitTriggers({ treatment, batch, saved, applicable, catalog });
  // Supprimer la DERNIÈRE entrée applique les défauts du code : prévenu au
  // moment du geste, pas après l'enregistrement.
  const videLaListe = (code: string) => (readOnly ? null : removalEmptiesWarning(saved, code, defaults, catalog));

  return (
    <div className="space-y-3">
      <span className="text-sm font-medium text-[color:var(--text-primary)]">Déclencheurs</span>

      {batch ? (
        <>
          {saved.length === 0 && (
            <p className="text-xs text-[color:var(--text-muted)]">{emptyListExplanation(defaults, catalog)}</p>
          )}
          <ul className="space-y-2" aria-label="Déclencheurs disponibles">
            {available.map(({ def, setting }) => (
              <li key={def.code} className="rounded-lg border border-[color:var(--border-subtle)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-[color:var(--text-primary)]">
                      {def.label} <span className="font-mono text-xs text-[color:var(--text-muted)]">— {def.code}</span>
                    </span>
                    {def.help && <span className="block text-xs text-[color:var(--text-muted)]">{def.help}</span>}
                  </span>
                  {!setting ? (
                    <Button size="sm" variant="outline" disabled={readOnly}
                      onClick={() => onChange(selectTrigger(saved, def))}>
                      Sélectionner
                    </Button>
                  ) : (
                    <>
                      <label className="flex items-center gap-1.5 text-xs text-[color:var(--text-secondary)]">
                        <input type="checkbox" checked={setting.active} disabled={readOnly}
                          aria-label={`${def.label} : ${setting.active ? 'actif' : 'inactif'}`}
                          onChange={() => onChange(setTriggerActive(saved, def.code, !setting.active))} />
                        {setting.active ? 'Actif' : 'Inactif'}
                      </label>
                      <Button size="sm" variant="ghost" disabled={readOnly}
                        onClick={() => onChange(removeTrigger(saved, def.code))}>
                        Retirer
                      </Button>
                    </>
                  )}
                </div>
                {setting && videLaListe(def.code) && (
                  <p className="mt-2 text-xs text-amber-500">{videLaListe(def.code)}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : incompatible.length === 0 ? (
        <p className="text-sm text-[color:var(--text-muted)]">
          Ce traitement répond aux demandes en direct : il n&apos;a pas de déclencheur.
        </p>
      ) : null}

      {incompatible.length > 0 && (
        <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-sm font-medium text-[color:var(--text-primary)]">Déclencheurs enregistrés incompatibles</p>
          <ul className="space-y-2" aria-label="Déclencheurs enregistrés incompatibles">
            {incompatible.map(({ setting, label, reason }) => (
              <li key={setting.code} className="flex flex-wrap items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-[color:var(--text-primary)]">
                    {label} — <span className="font-mono text-xs">{setting.code}</span>
                    {!setting.active && <span className="ml-1.5 text-xs text-[color:var(--text-muted)]">(inactif)</span>}
                  </span>
                  <span className="block text-xs text-[color:var(--text-muted)]">{reason}</span>
                  {!setting.active && (
                    <span className="block text-xs text-[color:var(--text-muted)]">
                      Le désactiver ne suffit pas : la validation contrôle aussi les déclencheurs inactifs.
                    </span>
                  )}
                  {videLaListe(setting.code) && (
                    <span className="block text-xs text-amber-500">{videLaListe(setting.code)}</span>
                  )}
                </span>
                <Button size="sm" variant="outline" disabled={readOnly}
                  onClick={() => onChange(removeTrigger(saved, setting.code))}>
                  Supprimer de la configuration
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
