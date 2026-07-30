'use client';

/**
 * Modification du classement depuis le drawer — CDC 5 §5.1, §5.2, §5.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS COMPORTEMENTS QUE LE §5.1 IMPOSE, ET QUI SURPRENNENT
 *
 * 1. L'ENREGISTREMENT PARTIEL EST AUTORISÉ. « Une modification partielle peut
 *    être enregistrée ; le document reste alors "À classer". » On ne bloque
 *    donc pas l'utilisateur tant qu'il n'a pas rempli les deux champs : il
 *    sait peut-être la catégorie sans connaître le type exact.
 *
 * 2. LE DRAWER RESTE OUVERT après enregistrement, « et les pages se mettent à
 *    jour sans rechargement ». D'où les deltas de compteurs renvoyés par
 *    l'API : recharger fermerait les accordéons et ferait perdre la position
 *    de lecture, pour un changement qui ne concerne qu'une ligne.
 *
 * 3. LES CHOIX SE CONTRAIGNENT MUTUELLEMENT. « Le choix de catégorie limite
 *    les types compatibles ; le choix d'un type détermine ou limite les
 *    catégories possibles. » Le serveur reste seul juge : ce composant
 *    n'anticipe pas les règles du §4.3, il affiche ce qu'elles ont décidé.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Check, Loader2, Lock } from 'lucide-react';

interface CategoryOption {
  code: string;
  label: string;
  types: Array<{ code: string; label: string }>;
}

export interface ClassificationResult {
  categoryCode: string | null;
  categoryLabel: string | null;
  documentTypeCode: string | null;
  classificationState: 'CLASSIFIED' | 'TO_CLASSIFY';
  changes: string[];
  rejected: string[];
  counterDeltas: Record<string, number>;
}

export function DocumentClassificationSection({
  documentId,
  initialCategoryCode,
  initialTypeCode,
  onSaved,
}: {
  documentId: number;
  initialCategoryCode: string | null;
  initialTypeCode: string | null;
  onSaved: (result: ClassificationResult) => void;
}) {
  const [options, setOptions] = useState<CategoryOption[]>([]);
  const [category, setCategory] = useState<string | null>(initialCategoryCode);
  const [type, setType] = useState<string | null>(initialTypeCode);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ClassificationResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents/${documentId}/classification`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setOptions(data?.categories ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [documentId]);

  // §5.1 : « la liste des types est limitée aux types pertinents ». Sans
  // catégorie choisie, on propose l'union — le serveur attribuera la
  // catégorie automatiquement si le type n'en admet qu'une (§4.3).
  const typesForCategory = category
    ? options.find((o) => o.code === category)?.types ?? []
    : [...new Map(options.flatMap((o) => o.types).map((t) => [t.code, t])).values()]
        .sort((a, b) => a.label.localeCompare(b.label, 'fr'));

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/documents/${documentId}/classification`, {
      credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Les deux champs sont transmis explicitement, `null` compris : c'est
        // une modification voulue, pas une omission.
        body: JSON.stringify({ categoryCode: category, documentTypeCode: type }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? 'Enregistrement impossible.'); return; }

      // Le serveur a pu retirer une valeur devenue incompatible (§4.3) :
      // l'état affiché suit sa décision, jamais la saisie initiale.
      setCategory(data.categoryCode);
      setType(data.documentTypeCode);
      setFeedback(data);
      onSaved(data);
    } catch {
      setError('Enregistrement impossible.');
    } finally {
      setSaving(false);
    }
  }, [documentId, category, type, onSaved]);

  const dirty = category !== initialCategoryCode || type !== initialTypeCode;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)] py-4">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
        Chargement du classement…
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Classement</h3>
        {feedback && (
          <Badge
            variant="outline"
            className={
              feedback.classificationState === 'CLASSIFIED'
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
            }
          >
            {feedback.classificationState === 'CLASSIFIED' ? 'Classé' : 'À classer'}
          </Badge>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="doc-category">Catégorie</Label>
        <select
          id="doc-category"
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value || null)}
          className="w-full rounded-md border border-[color:var(--border-subtle)]
                     bg-[color:var(--bg-page)] px-3 py-2 text-sm
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">— Non renseignée —</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="doc-type">Type de document</Label>
        <select
          id="doc-type"
          value={type ?? ''}
          onChange={(e) => setType(e.target.value || null)}
          className="w-full rounded-md border border-[color:var(--border-subtle)]
                     bg-[color:var(--bg-page)] px-3 py-2 text-sm
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">— Non renseigné —</option>
          {typesForCategory.map((t) => (
            <option key={t.code} value={t.code}>{t.label}</option>
          ))}
        </select>
        {!category && (
          <p className="text-xs text-[color:var(--text-muted)]">
            Si ce type n’appartient qu’à une seule catégorie, elle sera renseignée
            automatiquement.
          </p>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive flex items-start gap-1.5">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {/* §5.3 : l'historique indique ce qui a changé. Le montrer aussitôt
          évite que l'utilisateur ne croie à un bug quand le serveur a retiré
          une valeur devenue incompatible. */}
      {feedback && feedback.changes.length > 0 && (
        <ul className="text-xs text-[color:var(--text-muted)] space-y-0.5">
          {feedback.changes.map((change, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <Check className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" aria-hidden />
              {change}
            </li>
          ))}
        </ul>
      )}

      {feedback && feedback.rejected.length > 0 && (
        <ul className="text-xs text-amber-300 space-y-0.5">
          {feedback.rejected.map((reason, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
              {reason}
            </li>
          ))}
        </ul>
      )}

      <Button size="sm" onClick={save} disabled={saving || !dirty}>
        {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" aria-hidden /> : null}
        Enregistrer le classement
      </Button>

      {/* §5.1 : « une modification partielle peut être enregistrée ». */}
      {(!category || !type) && (
        <p className="text-xs text-[color:var(--text-muted)]">
          Vous pouvez enregistrer un seul des deux champs : le document restera
          « À classer » jusqu’à ce que l’autre soit renseigné.
        </p>
      )}
    </section>
  );
}
