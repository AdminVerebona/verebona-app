"use client";

/**
 * Lot 116C (carte #806 §4, AC73) — BO › Opérations › « Graphe » : diagnostic
 * LECTURE SEULE du graphe des opérations d'un compte. Deux informations
 * distinctes, jamais confondues :
 *   · l'ÉTAT DU CONTRÔLE de cohérence (fondé sur la preuve : un compte sans
 *     preuve est « jamais contrôlé », jamais « vérifié ») ;
 *   · les ÉCARTS recalculés à l'instant, avec leur libellé, leur gravité et la
 *     conduite à tenir.
 * Aucune action : aucune réparation n'est faite ni proposée. Jetons de la
 * charte ; une colonne sur mobile.
 */
import type { OperationGraphDiagnostic } from '@/services/business-operations/graph/audit-read';

export type GraphDiagnosticResponse = OperationGraphDiagnostic;

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function GraphDiagnosticView({ data }: { data: GraphDiagnosticResponse }) {
  const { control, live, volumes } = data;
  const verifie = control.state === 'CONSISTENT';
  return (
    <div className="space-y-3 text-sm" data-bo-graph={control.state}>
      <div className="rounded-lg border p-3 space-y-1">
        <p className="font-medium" data-bo-graph-state>
          Contrôle de cohérence du graphe : <span className={verifie ? '' : 'text-[color:var(--text-warning-soft)]'}>{control.stateLabel}</span>
        </p>
        {control.proof ? (
          <p className="text-xs text-muted-foreground break-words">
            Dernier contrôle : {date(control.proof.completedAt)} · règles v{control.proof.rulesVersion} (en vigueur : v{data.rulesVersion})
            {control.proof.trigger ? ` · déclencheur ${control.proof.trigger}` : ''}{control.proof.error ? ` · erreur : ${control.proof.error}` : ''}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Aucune preuve de contrôle pour ce compte : il n’a pas encore été examiné par la campagne de cohérence ({data.checkId}).</p>
        )}
        <p className="text-xs text-muted-foreground">
          {volumes.operations} opération(s) active(s) · {volumes.relations} relation(s) · {volumes.agendaLinks} lien(s) d’Agenda · {volumes.splitPairs} paire(s) scindée(s) par l’utilisateur
        </p>
      </div>

      <div className="rounded-lg border p-3 space-y-2">
        <p className="font-medium">Écarts recalculés à l’instant ({date(live.computedAt)})</p>
        {live.clean ? (
          <p className="text-xs text-muted-foreground" data-bo-graph-clean>
            Aucun écart à cet instant.{verifie ? '' : ' Ce calcul à la demande ne remplace pas le contrôle de cohérence : l’état ci-dessus reste celui de la dernière preuve.'}
          </p>
        ) : (
          <ul className="space-y-2" data-bo-graph-findings={live.findings.length}>
            {live.findings.map((f) => (
              <li key={f.code} className="rounded border p-2 space-y-0.5 break-words" data-bo-graph-finding={f.code}>
                <p className="font-medium">
                  {f.severity === 'BLOCKING' ? 'Bloquant' : 'À corriger'} · {f.familyLabel} · {f.count} {f.objectLabel}{f.count > 1 ? ' (au total)' : ''}
                </p>
                <p>{f.label}</p>
                <p className="text-xs text-muted-foreground">{f.action}</p>
                <p className="text-xs text-muted-foreground break-all">Code {f.code} · identifiants : {f.sample.join(', ')}{f.count > f.sample.length ? ' …' : ''}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
