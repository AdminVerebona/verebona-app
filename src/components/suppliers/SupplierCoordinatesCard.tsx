'use client';

/**
 * Lot 109B — identité et coordonnées de la fiche fournisseur : consultation
 * ET modification sur la fiche même (plus de tiroir fournisseur).
 *
 *   · champs renseignés affichés tels quels, champs absents « Non renseigné » :
 *     aucun jugement global (« vérifié / non vérifié » supprimé) ;
 *   · téléphone, e-mail, site web actionnables ;
 *   · IBAN masqué par défaut ; « Afficher » le lit à la demande
 *     (`GET /api/suppliers/[id]/iban`) ; en modification, l'IBAN n'est envoyé
 *     que s'il est ressaisi ou effacé explicitement ;
 *   · modification gardée (compte en lecture seule : fenêtre habituelle),
 *     validations du serveur affichées sur le champ, saisie protégée
 *     (`dirty` remonté à la page, qui confirme avant de partir).
 */
import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Globe, Loader2, Mail, MapPin, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { openExternalUrl } from '@/lib/native/open-external';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { SUPPLIER_FIELD_LABELS } from '@/lib/suppliers/supplier-fiche-config';
import { phoneHref, validateSupplierPatch, websiteHref } from '@/services/suppliers/supplier-validation';
import type { SupplierDetail } from '@/services/suppliers/supplier-detail.service';

type Supplier = SupplierDetail['supplier'];
const TEXT_FIELDS = [
  'name', 'email', 'phone', 'website', 'addressLine1', 'addressLine2', 'postalCode', 'city', 'country',
  'siren', 'siret', 'vatNumber', 'ibanHolderName',
] as const;
type TextField = (typeof TEXT_FIELDS)[number];
type Form = Record<TextField, string> & { iban: string; clearIban: boolean };

const initialForm = (s: Supplier): Form => ({
  ...(Object.fromEntries(TEXT_FIELDS.map((f) => [f, (s[f] as string | null) ?? ''])) as Record<TextField, string>),
  iban: '', clearIban: false,
});

/** Champs modifiés par rapport à la fiche (pur, testé) — l'IBAN seulement s'il est ressaisi ou effacé. */
export function supplierFormChanges(s: Supplier, f: Form): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of TEXT_FIELDS) {
    const before = ((s[k] as string | null) ?? '').trim();
    const after = f[k].trim();
    if (before !== after) out[k] = after || null;
  }
  if (f.clearIban) out.iban = null;
  else if (f.iban.trim()) out.iban = f.iban.trim();
  return out;
}

const Missing = () => <span className="text-muted-foreground">Non renseigné</span>;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-medium">{children}</dd>
    </div>
  );
}

export function SupplierCoordinatesCard({ supplier, editing, onEditingChange, onDirtyChange, onSaved }: {
  supplier: Supplier;
  editing: boolean;
  onEditingChange: (v: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const { garder } = useWriteGuard();
  const [form, setForm] = useState<Form>(() => initialForm(supplier));
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string | null; message: string } | null>(null);
  const [iban, setIban] = useState<{ value: string | null; holder: string | null } | null>(null);
  const [ibanLoading, setIbanLoading] = useState(false);

  useEffect(() => { if (!editing) { setForm(initialForm(supplier)); setFieldError(null); } }, [editing, supplier]);
  // IBAN affiché : remasqué dès que la fiche change (enregistrement, autre fiche).
  useEffect(() => { setIban(null); }, [supplier]);

  const changes = useMemo(() => supplierFormChanges(supplier, form), [supplier, form]);
  const dirty = editing && Object.keys(changes).length > 0;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const set = (k: keyof Form, v: string | boolean) => { setForm((f) => ({ ...f, [k]: v })); setFieldError(null); };

  const save = () => garder(() => {
    const v = validateSupplierPatch(changes);
    if (!v.ok) { setFieldError({ field: v.field, message: messageFor(v.field) }); return; }
    if (Object.keys(changes).length === 0) { onEditingChange(false); return; }
    void (async () => {
      setSaving(true);
      try {
        await apiClient.patch(`/api/suppliers/${supplier.id}`, changes);
        toast.success('Fournisseur enregistré');
        onDirtyChange(false);
        // La page quitte le mode modification (sans confirmation : rien n'est perdu).
        onSaved();
      } catch (e: unknown) {
        const field = (e as { details?: { field?: string } } | null)?.details?.field ?? null;
        if (field) setFieldError({ field, message: messageFor(field) });
        else toast.error('L’enregistrement n’a pas abouti. Réessayez.');
      } finally {
        setSaving(false);
      }
    })();
  });

  const reveal = async () => {
    setIbanLoading(true);
    try {
      const r = await apiClient.get<{ iban: string | null; ibanHolderName: string | null }>(`/api/suppliers/${supplier.id}/iban`);
      setIban({ value: r.iban, holder: r.ibanHolderName });
    } catch {
      toast.error('L’IBAN n’a pas pu être affiché.');
    } finally {
      setIbanLoading(false);
    }
  };

  if (editing) {
    const input = (k: TextField, opts: { type?: string; placeholder?: string; maxLength?: number; inputMode?: 'numeric' | 'tel' | 'email' | 'url' } = {}) => (
      <div className="space-y-1.5">
        <Label htmlFor={`sup-${k}`} className="text-xs">{SUPPLIER_FIELD_LABELS[k]}{k === 'name' ? ' *' : ''}</Label>
        <Input
          id={`sup-${k}`}
          value={form[k]}
          onChange={(e) => set(k, e.target.value)}
          type={opts.type}
          inputMode={opts.inputMode}
          placeholder={opts.placeholder}
          maxLength={opts.maxLength ?? (k === 'name' ? 200 : 300)}
          aria-invalid={fieldError?.field === k || undefined}
        />
        {fieldError?.field === k && <p className="text-xs text-[color:var(--danger)]">{fieldError.message}</p>}
      </div>
    );
    return (
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }} data-testid="supplier-edit-form">
        {input('name')}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {input('email', { type: 'email', inputMode: 'email' })}
          {input('phone', { type: 'tel', inputMode: 'tel' })}
        </div>
        {input('website', { inputMode: 'url', maxLength: 500 })}
        {input('addressLine1')}
        {input('addressLine2')}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {input('postalCode')}
          {input('city')}
          {input('country')}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {input('siren', { inputMode: 'numeric', placeholder: '9 chiffres', maxLength: 11 })}
          {input('siret', { inputMode: 'numeric', placeholder: '14 chiffres', maxLength: 17 })}
          {input('vatNumber')}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sup-iban" className="text-xs">{SUPPLIER_FIELD_LABELS.iban}</Label>
            <Input
              id="sup-iban"
              value={form.iban}
              onChange={(e) => { set('iban', e.target.value); set('clearIban', false); }}
              placeholder={supplier.ibanMasked ? `Actuel : ${supplier.ibanMasked} — saisir pour remplacer` : 'Non renseigné'}
              autoComplete="off"
              maxLength={42}
              disabled={form.clearIban}
              aria-invalid={fieldError?.field === 'iban' || undefined}
            />
            {fieldError?.field === 'iban' && <p className="text-xs text-[color:var(--danger)]">{fieldError.message}</p>}
            {supplier.hasIban && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={form.clearIban} onChange={(e) => { set('clearIban', e.target.checked); if (e.target.checked) set('iban', ''); }} />
                Effacer l’IBAN enregistré
              </label>
            )}
          </div>
          {input('ibanHolderName')}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onEditingChange(false)} disabled={saving}>Annuler</Button>
          <Button type="submit" disabled={saving || !form.name.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </div>
      </form>
    );
  }

  const s = supplier;
  const web = websiteHref(s.website);
  const tel = phoneHref(s.phone);
  const ville = [s.postalCode, s.city].filter(Boolean).join(' ');
  return (
    <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2" data-testid="supplier-coordinates">
      <Field label={SUPPLIER_FIELD_LABELS.email}>
        {s.email ? <a className="inline-flex items-center gap-1.5 text-[color:var(--accent)] hover:underline" href={`mailto:${s.email}`}><Mail className="h-3.5 w-3.5" aria-hidden />{s.email}</a> : <Missing />}
      </Field>
      <Field label={SUPPLIER_FIELD_LABELS.phone}>
        {s.phone ? (tel ? <a className="inline-flex items-center gap-1.5 text-[color:var(--accent)] hover:underline" href={tel}><Phone className="h-3.5 w-3.5" aria-hidden />{s.phone}</a> : s.phone) : <Missing />}
      </Field>
      <Field label={SUPPLIER_FIELD_LABELS.website}>
        {s.website ? (web
          ? <a className="inline-flex items-center gap-1.5 text-[color:var(--accent)] hover:underline [overflow-wrap:anywhere]" href={web} target="_blank" rel="noopener noreferrer"
            // Navigateur système sur l'application mobile (lot 108H), nouvel onglet sur le Web.
            onClick={(e) => { e.preventDefault(); void openExternalUrl(web); }}><Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />{s.website}</a>
          : s.website) : <Missing />}
      </Field>
      <Field label={SUPPLIER_FIELD_LABELS.addressLine1}>
        {s.addressLine1 || s.addressLine2 || ville || s.country ? (
          <span className="inline-flex items-start gap-1.5"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span>{[s.addressLine1, s.addressLine2, ville, s.country].filter(Boolean).map((l, i) => <span key={i} className="block">{l}</span>)}</span>
          </span>
        ) : <Missing />}
      </Field>
      <Field label={SUPPLIER_FIELD_LABELS.siren}>{s.siren ? <span className="font-mono">{s.siren}</span> : <Missing />}</Field>
      <Field label={SUPPLIER_FIELD_LABELS.siret}>{s.siret ? <span className="font-mono">{s.siret}</span> : <Missing />}</Field>
      <Field label={SUPPLIER_FIELD_LABELS.vatNumber}>{s.vatNumber ? <span className="font-mono">{s.vatNumber}</span> : <Missing />}</Field>
      <Field label={SUPPLIER_FIELD_LABELS.iban}>
        {s.hasIban ? (
          <span className="flex flex-wrap items-center gap-2" data-testid="supplier-iban">
            <span className="font-mono">{iban?.value ?? s.ibanMasked}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-[color:var(--accent)] hover:underline"
              onClick={() => { if (iban) setIban(null); else void reveal(); }}
              aria-label={iban ? 'Masquer l’IBAN' : 'Afficher l’IBAN'}
              disabled={ibanLoading}
            >
              {ibanLoading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : iban ? <EyeOff className="h-3 w-3" aria-hidden /> : <Eye className="h-3 w-3" aria-hidden />}
              {iban ? 'Masquer' : 'Afficher'}
            </button>
          </span>
        ) : <Missing />}
      </Field>
      <Field label={SUPPLIER_FIELD_LABELS.ibanHolderName}>{s.ibanHolderName ?? <Missing />}</Field>
    </dl>
  );
}

function messageFor(field: string | null): string {
  switch (field) {
    case 'name': return 'Le nom est obligatoire.';
    case 'siren': return 'Le SIREN comporte 9 chiffres.';
    case 'siret': return 'Le SIRET comporte 14 chiffres.';
    case 'email': return 'Adresse e-mail invalide.';
    case 'iban': return 'IBAN invalide (2 lettres, 2 chiffres, puis le numéro de compte).';
    default: return 'Valeur invalide ou trop longue.';
  }
}
