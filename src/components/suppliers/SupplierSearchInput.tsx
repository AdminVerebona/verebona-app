"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Building2, Plus, Loader2, Check, X } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';

interface SupplierOption {
  id: number;
  publicId: string;
  name: string;
  email: string | null;
  city: string | null;
}

interface Props {
  documentId?: number;
  value: { id: number; name: string } | null;
  onChange: (supplier: { id: number; name: string } | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function SupplierSearchInput({ documentId, value, onChange, placeholder = 'Rechercher un fournisseur…', disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const data = await apiClient.get<{ suppliers: SupplierOption[] }>(
        `/api/suppliers${q.trim() ? `?search=${encodeURIComponent(q.trim())}` : ''}`
      );
      setResults(data.suppliers ?? []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, open, search]);

  useEffect(() => {
    if (open && results.length === 0 && !query) {
      search('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSelect = useCallback(async (supplier: SupplierOption) => {
    onChange({ id: supplier.id, name: supplier.name });
    if (documentId) {
      try {
        await apiClient.put(`/api/documents/${documentId}/supplier`, { supplierId: supplier.id });
      } catch {
        toast.error('Impossible d\'associer le fournisseur');
      }
    }
    setOpen(false);
    setQuery('');
  }, [onChange, documentId]);

  const handleCreate = useCallback(async () => {
    const name = query.trim();
    if (!name) return;
    setCreating(true);
    try {
      const data = await apiClient.post<{ supplier: { id: number; name: string } }>(
        '/api/suppliers',
        { name, source: 'manual' }
      );
      const newSupplier = data.supplier;
      onChange({ id: newSupplier.id, name: newSupplier.name });
      if (documentId) {
        await apiClient.put(`/api/documents/${documentId}/supplier`, { supplierId: newSupplier.id });
      }
      setOpen(false);
      setQuery('');
    } catch {
      toast.error('Impossible de créer le fournisseur');
    } finally {
      setCreating(false);
    }
  }, [query, onChange, documentId]);

  const handleClear = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
    if (documentId && value && value.id > 0) {
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
        await fetch(`/api/documents/${documentId}/supplier`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ supplierId: value.id }),
        });
      } catch {
        // silent
      }
    }
  }, [onChange, documentId, value]);

  const showCreateOption = query.trim().length > 0 && !results.some(r => r.name.toLowerCase() === query.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          disabled={disabled}
          className={`w-full justify-between h-9 text-sm font-normal ${!value ? 'text-[color:var(--text-muted)]' : ''}`}
        >
          <span className="flex items-center gap-2 truncate">
            <Building2 className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" />
            <span className="truncate">{value ? value.name : placeholder}</span>
          </span>
          {value && (
            <span
              role="button"
              className="ml-1 shrink-0 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] p-0.5 rounded"
              onClick={handleClear}
            >
              <X className="w-3.5 h-3.5" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <div className="flex items-center border-b border-[color:var(--border-subtle)] px-3">
            <Building2 className="w-3.5 h-3.5 text-[color:var(--text-muted)] mr-2 shrink-0" />
            <Input
              placeholder="Rechercher…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="h-9 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-sm px-0"
              autoFocus
            />
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[color:var(--text-muted)] shrink-0 ml-2" />}
          </div>
          <CommandList>
            {!loading && results.length === 0 && !showCreateOption && (
              <CommandEmpty className="py-4 text-center text-sm text-[color:var(--text-muted)]">
                Aucun fournisseur trouvé
              </CommandEmpty>
            )}
            {results.length > 0 && (
              <CommandGroup>
                {results.map(s => (
                  <CommandItem
                    key={s.id}
                    value={s.name}
                    onSelect={() => handleSelect(s)}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    {value?.id === s.id && <Check className="w-3.5 h-3.5 text-[#3b82f6] shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{s.name}</p>
                      {(s.email || s.city) && (
                        <p className="text-[11px] text-[color:var(--text-muted)] truncate">
                          {[s.city, s.email].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {showCreateOption && (
              <CommandGroup heading="Créer">
                <CommandItem
                  value={`create-${query}`}
                  onSelect={handleCreate}
                  disabled={creating}
                  className="flex items-center gap-2 cursor-pointer text-[#3b82f6]"
                >
                  {creating
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    : <Plus className="w-3.5 h-3.5 shrink-0" />}
                  <span className="text-sm">Créer « {query} »</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
