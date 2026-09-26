'use client';

/** Recherche serveur de la personne concernée (CDC BO GDP-010). */
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Loader2, Search, X } from 'lucide-react';
import type { Subject } from './types';

export function SubjectPicker({ value, onChange }: { value: Subject | null; onChange: (s: Subject | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (value || q.trim().length < 2) { setResults([]); return; }
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/gdpr/subjects?q=${encodeURIComponent(q.trim())}`, { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message);
        setResults(data.subjects ?? []);
      } catch (e) {
        setError((e as Error).message || 'Recherche impossible.');
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [q, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <div>
          <div className="font-medium">{value.email}</div>
          <div className="text-xs text-muted-foreground">
            {value.name || 'Sans nom'} · {value.accountName ? `${value.accountName} (#${value.accountId})` : 'aucun compte actif'}
          </div>
        </div>
        <button type="button" onClick={() => onChange(null)} className="text-muted-foreground hover:text-foreground" aria-label="Changer">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="E-mail, nom, compte ou identifiant…"
          className="pl-9"
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {results.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border divide-y text-sm">
          {results.map((s) => (
            <li key={s.userId}>
              <button type="button" className="w-full text-left px-3 py-2 hover:bg-muted" onClick={() => { onChange(s); setQ(''); }}>
                <div>{s.email}</div>
                <div className="text-xs text-muted-foreground">
                  {s.name || 'Sans nom'} · {s.accountName ?? 'aucun compte actif'}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && !error && q.trim().length >= 2 && results.length === 0 && (
        <p className="text-xs text-muted-foreground">Aucun utilisateur ne correspond.</p>
      )}
    </div>
  );
}
