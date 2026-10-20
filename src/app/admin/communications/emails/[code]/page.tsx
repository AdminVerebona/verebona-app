"use client";

/**
 * Éditeur d'un modèle d'e-mail transactionnel — BO › Communications ›
 * E-mails transactionnels (lot 70A, décision PO du 19/10).
 *
 * Objet + contenu : gabarit « texte » édité en texte (paragraphes, boutons
 * « Libellé : URL »), gabarit HTML complet édité par ZONES DE TEXTE (structure,
 * styles et liens intouchables). Variables du modèle insérables d'un clic,
 * contrôles en direct puis validation serveur à l'enregistrement. Aperçu dans
 * la mise en page de la charte (clair / sombre) et envoi de test du brouillon
 * AVANT enregistrement. Historique des versions : comparaison, restauration,
 * retour au texte livré. Desktop et mobile (colonnes empilées).
 *
 * Lot 73A (décision PO du 20/10) : même éditeur pour les e-mails des
 * NOTIFICATIONS (`notif_*`) — encadré « E-mail de notification » (événements qui
 * utilisent le modèle, message composé par l'application), choix de l'événement
 * et du contexte (bien, document, échéance) pour l'aperçu et le test. Mêmes
 * composants sur ordinateur et mobile (sélecteurs empilés sous 640 px).
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Eye, History, Loader2, Lock, Moon, RotateCcw, Save, Send, Sun, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { formatDateTime, formatDate, formatMoney } from '@/lib/admin/format';
import { relevantPreviewContexts } from '@/lib/admin/communication-contexts';
import {
  VERSION_SOURCE_LABELS, applyHtmlZones, comparableText, diffLines, validateDraft,
  type DiffOp, type HtmlZone, type RequiredVariableGroup, type TemplateVariable, type ValidationIssue,
} from '@/lib/email/template-editor';

interface VersionSummary {
  id: number; versionNo: number; source: string; subject: string; createdAt: string | null;
  createdByEmail: string | null; restoredFromVersion: number | null; note: string | null; matchesCurrent: boolean;
}
interface EditorState {
  code: string; type: string; label: string; format: 'text' | 'html'; subject: string; body: string;
  kind: 'transactional' | 'notification'; usedBy: Array<{ code: string; label: string; mandatoryEmail: boolean }>;
  zones: HtmlZone[] | null; baseHash: string; variables: TemplateVariable[]; required: RequiredVariableGroup[];
  declaredVariables: boolean; contentLock: string | null; limitedReason: string | null; channelLock: string | null;
  isCustomized: boolean; customizedAt: string | null; updatedAt: string | null; updatedByEmail: string | null;
  shipped: { available: boolean; source: 'base' | 'code' | null; subject: string | null; body: string | null; newerAt: string | null; differsFromCurrent: boolean };
  versions: VersionSummary[];
  limits: { subject: number; textBody: number; htmlBody: number; zone: number; note: number };
}
interface PreviewData {
  subject: string; html: string; issues: ValidationIssue[]; incomplete: boolean; missingCount: number; rejected: string[]; recipient: string; valid: boolean;
}
interface ContextOptions {
  hasAccount: boolean;
  assets?: Array<{ id: number; name: string }>;
  documents?: Array<{ id: number; title: string; assetName: string | null }>;
  deadlines?: Array<{ id: number; title: string; date: string | null }>;
  payments?: Array<{ id: number; amount: number; currency: string; status: string; date: string | null }>;
  withdrawals?: Array<{ id: number; publicReference: string; requestedAt: string | null }>;
}
type Focus = { kind: 'subject' } | { kind: 'body' } | { kind: 'zone'; index: number };
type Compare = { title: string; subject: DiffOp[]; body: DiffOp[] };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.message || `Erreur ${res.status}`) as Error & { issues?: ValidationIssue[]; code?: string };
    err.issues = payload.issues;
    err.code = payload.code;
    throw err;
  }
  return payload as T;
}

const TAG_LABELS: Record<string, string> = { h1: 'Titre', h2: 'Sous-titre', a: 'Bouton / lien', li: 'Liste', strong: 'Gras', td: 'Encadré' };

function DiffView({ ops }: { ops: DiffOp[] }) {
  if (!ops.some((o) => o.op !== 'same')) return <p className="text-xs text-muted-foreground">Identique.</p>;
  return (
    <pre className="text-xs whitespace-pre-wrap break-words rounded-lg border p-2 max-h-[40vh] overflow-auto">
      {ops.map((o, i) => (
        <span
          key={i}
          className={`block ${o.op === 'add' ? 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]' : o.op === 'del' ? 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] line-through' : 'text-muted-foreground'}`}
        >
          {o.op === 'add' ? '+ ' : o.op === 'del' ? '− ' : '  '}{o.text || ' '}
        </span>
      ))}
    </pre>
  );
}

export default function EmailTemplateEditorPage() {
  const params = useParams<{ code: string }>();
  const code = decodeURIComponent(String(params?.code ?? '')).toUpperCase();

  const [state, setState] = useState<EditorState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [zones, setZones] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [dark, setDark] = useState(false);
  const [ctx, setCtx] = useState<ContextOptions | null>(null);
  const [paymentId, setPaymentId] = useState('');
  const [withdrawalId, setWithdrawalId] = useState('');
  // Lot 73A : e-mail de notification — événement illustré et contexte (bien, document, échéance).
  const [eventCode, setEventCode] = useState('');
  const [assetId, setAssetId] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [deadlineId, setDeadlineId] = useState('');
  useEffect(() => {
    try {
      const ev = new URLSearchParams(window.location.search).get('evenement');
      if (ev && /^[A-Z0-9_]{2,80}$/.test(ev)) setEventCode(ev);
    } catch { /* lien sans paramètre */ }
  }, []);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'restore'; version: VersionSummary } | { kind: 'reset' } | null>(null);
  const [busy, setBusy] = useState(false);
  const focus = useRef<Focus>({ kind: 'body' });
  const fieldRefs = useRef<Map<string, HTMLInputElement | HTMLTextAreaElement>>(new Map());

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await call<{ state: EditorState }>(`/api/admin/communications/templates/${encodeURIComponent(code)}`);
      setState(r.state);
      setSubject(r.state.subject);
      setBody(r.state.body);
      setZones((r.state.zones ?? []).map((z) => z.text));
      setNote('');
      setServerIssues([]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  }, [code]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    call<ContextOptions>('/api/admin/communications/preview-context').then(setCtx).catch(() => setCtx(null));
  }, []);

  const locked = !!state?.contentLock;
  const isNotification = state?.kind === 'notification';
  const rel = relevantPreviewContexts(`email:${code}`, code);

  /** Brouillon tel qu'envoyé au serveur. */
  const draft = useMemo(() => (state?.format === 'html' ? { subject, zones } : { subject, body }), [state?.format, subject, zones, body]);
  const dirty = !!state && (subject !== state.subject || (state.format === 'html'
    ? zones.some((z, i) => z !== (state.zones?.[i]?.text ?? ''))
    : body !== state.body));

  /** Contrôles en direct (mêmes règles que le serveur, qui revalide). */
  const liveIssues = useMemo<ValidationIssue[]>(() => {
    if (!state || locked) return [];
    const spec = { variables: state.variables, required: state.required, declared: state.declaredVariables };
    const specWithSystem = { ...spec, variables: [...spec.variables, { name: 'logoUrl', label: 'logo', kind: 'url' as const, system: true }] };
    if (state.format === 'html') {
      const applied = applyHtmlZones(state.body, zones, specWithSystem);
      if (!applied.ok) return applied.issues;
      return validateDraft({ code: state.code, subject, body: applied.body, format: 'html', spec: specWithSystem, htmlVariablesAllowed: true });
    }
    return validateDraft({ code: state.code, subject, body, format: 'text', spec });
  }, [state, locked, subject, body, zones]);
  const issues = serverIssues.length ? serverIssues : liveIssues;

  const selection = useMemo(() => ({
    ...(rel.payment && paymentId ? { paymentId: Number(paymentId) } : {}),
    ...(rel.withdrawal && withdrawalId ? { withdrawalId: Number(withdrawalId) } : {}),
    ...(isNotification && assetId ? { assetId: Number(assetId) } : {}),
    ...(isNotification && documentId ? { documentId: Number(documentId) } : {}),
    ...(isNotification && deadlineId ? { deadlineId: Number(deadlineId) } : {}),
    ...(isNotification && eventCode ? { eventCode } : {}),
  }), [rel.payment, rel.withdrawal, paymentId, withdrawalId, isNotification, assetId, documentId, deadlineId, eventCode]);

  // Aperçu : rendu serveur du brouillon (même chemin que l'envoi), différé.
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(async () => {
      setPreviewing(true);
      try {
        setPreview(await call<PreviewData>(`/api/admin/communications/templates/${encodeURIComponent(code)}/preview`, {
          method: 'POST', body: JSON.stringify({ ...draft, selection }),
        }));
      } catch (e) {
        setPreview(null);
        toast.error(e instanceof Error ? e.message : 'Aperçu impossible');
      } finally {
        setPreviewing(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [state, code, draft, selection]);

  const remember = (key: string) => (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (el) fieldRefs.current.set(key, el); else fieldRefs.current.delete(key);
  };

  const insertVariable = (name: string) => {
    if (locked) return;
    const token = `{{${name}}}`;
    const f = focus.current;
    const key = f.kind === 'zone' ? `zone-${f.index}` : f.kind;
    const el = fieldRefs.current.get(key);
    const current = f.kind === 'subject' ? subject : f.kind === 'body' ? body : zones[f.index] ?? '';
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    if (f.kind === 'subject') setSubject(next);
    else if (f.kind === 'body') setBody(next);
    else setZones((zs) => zs.map((z, i) => (i === f.index ? next : z)));
    setServerIssues([]);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    if (!state) return;
    setSaving(true);
    try {
      const r = await call<{ changed: boolean; versionNo: number | null }>(`/api/admin/communications/templates/${encodeURIComponent(code)}`, {
        method: 'PUT', body: JSON.stringify({ ...draft, baseHash: state.baseHash, note }),
      });
      toast.success(r.changed ? `Modèle enregistré (version ${r.versionNo}). Il sera utilisé dès le prochain envoi.` : 'Aucune modification à enregistrer.');
      await load();
    } catch (e) {
      const err = e as Error & { issues?: ValidationIssue[] };
      setServerIssues(err.issues ?? []);
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await call<{ to: string; incomplete: boolean }>(`/api/admin/communications/templates/${encodeURIComponent(code)}/test`, {
        method: 'POST', body: JSON.stringify({ ...draft, selection }),
      });
      toast.success(`E-mail de test (version en cours d’édition) envoyé à ${r.to}${r.incomplete ? ' — certaines données sont indisponibles dans votre compte' : ''}.`);
    } catch (e) {
      const err = e as Error & { issues?: ValidationIssue[] };
      if (err.issues?.length) setServerIssues(err.issues);
      toast.error(err.message);
    } finally {
      setTesting(false);
    }
  };

  const currentBodyForCompare = (): string => {
    if (!state) return '';
    if (state.format === 'html') {
      const applied = applyHtmlZones(state.body, zones);
      return applied.ok ? applied.body : state.body;
    }
    return body;
  };

  const openCompare = async (v: VersionSummary) => {
    try {
      const r = await call<{ version: { subject: string; body: string } }>(`/api/admin/communications/templates/${encodeURIComponent(code)}/versions/${v.id}`);
      setCompare({
        title: `Version ${v.versionNo} → texte en cours d’édition`,
        subject: diffLines(r.version.subject, subject),
        body: diffLines(comparableText(r.version.body), comparableText(currentBodyForCompare())),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Comparaison impossible');
    }
  };

  const compareShipped = () => {
    if (!state?.shipped.body) return;
    setCompare({
      title: 'Texte livré avec l’application → texte en cours d’édition',
      subject: diffLines(state.shipped.subject ?? '', subject),
      body: diffLines(comparableText(state.shipped.body), comparableText(currentBodyForCompare())),
    });
  };

  const applyConfirm = async () => {
    if (!state || !confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'restore') {
        const r = await call<{ versionNo: number }>(`/api/admin/communications/templates/${encodeURIComponent(code)}/restore`, {
          method: 'POST', body: JSON.stringify({ versionId: confirm.version.id, baseHash: state.baseHash }),
        });
        toast.success(`Version ${confirm.version.versionNo} restaurée (nouvelle version ${r.versionNo}).`);
      } else {
        await call(`/api/admin/communications/templates/${encodeURIComponent(code)}/reset`, {
          method: 'POST', body: JSON.stringify({ baseHash: state.baseHash }),
        });
        toast.success('Texte livré avec l’application rétabli : le modèle n’est plus personnalisé.');
      }
      setConfirm(null);
      await load();
    } catch (e) {
      const err = e as Error & { issues?: ValidationIssue[] };
      if (err.issues?.length) setServerIssues(err.issues);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-4">
        <Link href="/admin/communications" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="h-4 w-4" /> Communications</Link>
        <EcranEnErreur titre="Impossible d’ouvrir le modèle" message={loadError} onRetry={() => load()} />
      </div>
    );
  }
  if (!state) {
    return <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>;
  }

  const previewHtml = preview?.html ? (dark ? preview.html.replace(/<html\b/i, '<html data-ogsc="1"') : preview.html) : '';
  const insertable = state.variables.filter((x) => x.kind !== 'html');
  const requiredNames = new Set(state.required.flatMap((g) => g.anyOf));

  return (
    <div className="space-y-6" data-testid="email-template-editor">
      <div className="space-y-2">
        <Link href="/admin/communications" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="h-4 w-4" /> Communications › {isNotification ? 'E-mails de notification' : 'E-mails transactionnels'}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="vb-app-title break-words">{state.label}</h1>
            <p className="text-xs text-muted-foreground mt-0.5 break-all">
              Modèle <span className="font-mono">{state.type}</span> · {state.format === 'html' ? 'gabarit HTML complet (édition par zones de texte)' : 'gabarit texte (mise en page de la charte appliquée à l’envoi)'}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {state.isCustomized ? <Badge variant="attention">Personnalisé{state.customizedAt ? ` le ${formatDate(state.customizedAt)}` : ''}</Badge> : <Badge variant="neutral">Texte livré</Badge>}
            {state.channelLock ? <Badge variant="outline"><Lock /> Non désactivable</Badge> : null}
            {locked ? <Badge variant="destructive"><Lock /> Contenu verrouillé</Badge> : null}
          </div>
        </div>
      </div>

      {locked && (
        <p className="text-sm rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] px-4 py-3 text-[color:var(--text-warning-soft)]" data-testid="content-lock">
          <strong>Modification impossible depuis le back-office.</strong> {state.contentLock}
        </p>
      )}
      {!locked && state.limitedReason && (
        <p className="text-sm rounded-xl border border-[color:var(--border-info)] bg-[color:var(--bg-info)] px-4 py-3 text-[color:var(--text-info)]">
          <strong>Édition limitée.</strong> {state.limitedReason}
        </p>
      )}
      {isNotification && (
        <div className="text-sm rounded-xl border border-[color:var(--border-info)] bg-[color:var(--bg-info)] px-4 py-3 text-[color:var(--text-info)] space-y-1.5" data-testid="notification-template-info">
          <p>
            <strong>E-mail de notification.</strong> <span className="font-mono text-xs">{'{{title}}'}</span> et <span className="font-mono text-xs">{'{{body}}'}</span> sont
            le titre et le message de la notification, composés par l’application pour chaque événement (les mêmes que dans la cloche) : ils ne se
            modifient pas ici, pas plus que le texte des push et de la cloche. Vous modifiez l’objet et l’habillage de l’e-mail.
          </p>
          <p className="break-words">
            {state.usedBy.length
              ? <>Utilisé par {state.usedBy.length > 1 ? `${state.usedBy.length} événements` : 'l’événement'} : {state.usedBy.map((u) => u.label).join(', ')}.{state.usedBy.length > 1 ? ' Une modification s’applique à chacun.' : ''}</>
              : 'Aucune notification n’envoie actuellement ce modèle par e-mail.'}
          </p>
        </div>
      )}
      {state.channelLock && (
        <p className="text-xs text-muted-foreground">
          <Lock className="inline h-3 w-3 mr-1" />Envoi non désactivable : {state.channelLock} Ce verrou porte sur l’envoi, pas sur le texte{locked ? '' : ', qui reste modifiable'}.
        </p>
      )}
      {state.shipped.newerAt && (
        <div className="rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] px-4 py-3 space-y-2" data-testid="shipped-newer">
          <p className="text-sm text-[color:var(--text-warning-soft)]">
            <strong>Un texte livré plus récent existe</strong> (reçu le {formatDateTime(state.shipped.newerAt)}). Il n’a pas été appliqué car ce modèle est personnalisé.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={compareShipped}>Comparer</Button>
            <Button size="sm" variant="outline" onClick={() => setConfirm({ kind: 'reset' })}><Undo2 className="h-3.5 w-3.5 mr-1.5" /> Revenir au texte livré</Button>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Édition ── */}
        <section className="space-y-4 min-w-0">
          <div className="rounded-xl border bg-card p-4 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="tpl-subject" className="vb-app-label">Objet</label>
              <Input
                id="tpl-subject"
                ref={remember('subject')}
                value={subject}
                maxLength={state.limits.subject}
                readOnly={locked}
                onFocus={() => { focus.current = { kind: 'subject' }; }}
                onChange={(e) => { setSubject(e.target.value.replace(/[\r\n]+/g, ' ')); setServerIssues([]); }}
              />
              <p className="text-[11px] text-muted-foreground text-right tabular-nums">{subject.length}/{state.limits.subject}</p>
            </div>

            {!locked && (
              <div className="space-y-1.5">
                <p className="vb-app-label">Variables disponibles</p>
                <p className="text-[11px] text-muted-foreground">Cliquez pour insérer à l’emplacement du curseur (objet, contenu ou zone). <span className="font-semibold">*</span> obligatoire.</p>
                <div className="flex flex-wrap gap-1.5" data-testid="template-variables">
                  {insertable.map((x) => (
                    <button
                      key={x.name}
                      type="button"
                      title={x.label}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertVariable(x.name)}
                      className="rounded-full border px-2.5 py-1 text-xs font-mono hover:bg-[color:var(--accent-soft)] focus-visible:outline-2"
                    >
                      {`{{${x.name}}}`}{requiredNames.has(x.name) ? ' *' : ''}
                    </button>
                  ))}
                </div>
                {state.required.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    Obligatoires : {state.required.map((g) => `${g.label} (${g.anyOf.map((n) => `{{${n}}}`).join(' ou ')})`).join(' ; ')}.
                  </p>
                )}
                {!state.declaredVariables && (
                  <p className="text-[11px] text-[color:var(--text-warning-soft)]">Modèle ancien : seules les variables qu’il emploie déjà sont admises.</p>
                )}
              </div>
            )}

            {state.format === 'text' ? (
              <div className="space-y-1.5">
                <label htmlFor="tpl-body" className="vb-app-label">Contenu</label>
                <p className="text-[11px] text-muted-foreground">
                  Un paragraphe par ligne. Bouton : une ligne « Libellé : {'{{lien}}'} ». Mise en forme admise : &lt;strong&gt;, &lt;em&gt;, &lt;br&gt; (sans attribut).
                </p>
                <Textarea
                  id="tpl-body"
                  ref={remember('body')}
                  value={body}
                  readOnly={locked}
                  rows={16}
                  className="font-mono text-xs min-h-[320px]"
                  onFocus={() => { focus.current = { kind: 'body' }; }}
                  onChange={(e) => { setBody(e.target.value); setServerIssues([]); }}
                />
                <p className="text-[11px] text-muted-foreground text-right tabular-nums">{body.length}/{state.limits.textBody}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="vb-app-label">Zones de texte</p>
                <p className="text-[11px] text-muted-foreground">Seuls les textes visibles sont modifiables ; la mise en page, les couleurs et les liens des boutons restent ceux de la charte.</p>
                <div className="space-y-2 max-h-[60vh] overflow-auto pr-1" data-testid="template-zones">
                  {(state.zones ?? []).map((z, i) => (
                    <div key={z.index} className="space-y-1">
                      <label htmlFor={`zone-${i}`} className="text-[11px] text-muted-foreground">
                        Zone {i + 1}{TAG_LABELS[z.tag] ? ` · ${TAG_LABELS[z.tag]}` : ''}{z.locked ? ' · produite par le code' : ''}
                      </label>
                      <Textarea
                        id={`zone-${i}`}
                        ref={remember(`zone-${i}`)}
                        value={zones[i] ?? ''}
                        readOnly={locked || z.locked}
                        maxLength={state.limits.zone}
                        rows={Math.min(6, Math.max(1, Math.ceil((zones[i]?.length ?? 0) / 70)))}
                        className="text-sm min-h-0"
                        onFocus={() => { focus.current = { kind: 'zone', index: i }; }}
                        onChange={(e) => { const val = e.target.value; setZones((zs) => zs.map((x, j) => (j === i ? val : x))); setServerIssues([]); }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!locked && (
              <div className="space-y-1.5">
                <label htmlFor="tpl-note" className="vb-app-label">Note de version (facultative)</label>
                <Input id="tpl-note" value={note} maxLength={state.limits.note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. reformulation demandée par le support" />
              </div>
            )}

            {issues.length > 0 && !locked && (
              <ul className="text-xs rounded-lg border border-[color:var(--border-danger)] bg-[color:var(--bg-danger)] px-3 py-2 space-y-1 text-[color:var(--text-danger)]" data-testid="template-issues">
                {issues.map((i, k) => <li key={k}>{i.message}</li>)}
              </ul>
            )}

            <div className="flex flex-wrap gap-2">
              {!locked && (
                <Button onClick={() => void save()} disabled={saving || !dirty || issues.length > 0} data-testid="template-save">
                  {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />} Enregistrer
                </Button>
              )}
              <Button variant="outline" onClick={() => void sendTest()} disabled={testing || issues.length > 0} title="Envoi uniquement vers votre adresse e-mail d’administrateur">
                {testing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />} Envoyer un test{dirty ? ' (version en cours)' : ''}
              </Button>
              {!locked && dirty && (
                <Button variant="ghost" onClick={() => { setSubject(state.subject); setBody(state.body); setZones((state.zones ?? []).map((z) => z.text)); setServerIssues([]); }}>
                  <RotateCcw className="h-4 w-4 mr-1.5" /> Annuler les modifications
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Enregistrement journalisé (avant / après) et ajouté à l’historique. Un modèle personnalisé n’est jamais écrasé par une livraison.
            </p>
          </div>
        </section>

        {/* ── Aperçu ── */}
        <section className="space-y-3 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="vb-app-section flex items-center gap-2"><Eye className="h-4 w-4" /> Aperçu {previewing ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}</h2>
            <div className="inline-flex rounded-full border p-0.5" role="group" aria-label="Thème de l’aperçu">
              <button type="button" aria-pressed={!dark} onClick={() => setDark(false)} className={`rounded-full px-3 py-1 text-xs inline-flex items-center gap-1 ${!dark ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)] font-semibold' : 'text-muted-foreground'}`}><Sun className="h-3.5 w-3.5" /> Clair</button>
              <button type="button" aria-pressed={dark} onClick={() => setDark(true)} className={`rounded-full px-3 py-1 text-xs inline-flex items-center gap-1 ${dark ? 'bg-[color:var(--accent-soft)] text-[color:var(--accent)] font-semibold' : 'text-muted-foreground'}`}><Moon className="h-3.5 w-3.5" /> Sombre</button>
            </div>
          </div>
          {isNotification && (state.usedBy.length > 1 || ctx?.hasAccount) && (
            <div className="grid gap-2 sm:grid-cols-2" data-testid="notification-preview-context">
              {state.usedBy.length > 1 && (
                <select aria-label="Événement illustré" className="rounded-md border bg-background px-2 py-1.5 text-xs min-w-0" value={eventCode || state.usedBy[0].code} onChange={(e) => setEventCode(e.target.value)}>
                  {state.usedBy.map((u) => <option key={u.code} value={u.code}>Événement : {u.label}</option>)}
                </select>
              )}
              {ctx?.hasAccount && (
                <>
                  <select aria-label="Bien" className="rounded-md border bg-background px-2 py-1.5 text-xs min-w-0" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                    <option value="">{ctx.assets?.length ? 'Bien de votre compte : aucun' : 'Aucun bien dans votre compte'}</option>
                    {(ctx.assets ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <select aria-label="Document" className="rounded-md border bg-background px-2 py-1.5 text-xs min-w-0" value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
                    <option value="">{ctx.documents?.length ? 'Document de votre compte : aucun' : 'Aucun document dans votre compte'}</option>
                    {(ctx.documents ?? []).map((d) => <option key={d.id} value={d.id}>{d.title}{d.assetName ? ` — ${d.assetName}` : ''}</option>)}
                  </select>
                  <select aria-label="Échéance" className="rounded-md border bg-background px-2 py-1.5 text-xs min-w-0" value={deadlineId} onChange={(e) => setDeadlineId(e.target.value)}>
                    <option value="">{ctx.deadlines?.length ? 'Échéance de votre compte : aucune' : 'Aucune échéance dans votre compte'}</option>
                    {(ctx.deadlines ?? []).map((d) => <option key={d.id} value={d.id}>{d.title}{d.date ? ` — ${formatDate(d.date)}` : ''}</option>)}
                  </select>
                </>
              )}
            </div>
          )}
          {ctx?.hasAccount && (rel.payment || rel.withdrawal) && (
            <div className="grid gap-2 sm:grid-cols-2">
              {rel.payment && (
                <select aria-label="Paiement" className="rounded-md border bg-background px-2 py-1.5 text-xs" value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
                  <option value="">{ctx.payments?.length ? 'Paiement de votre compte : aucun' : 'Aucun paiement dans votre compte'}</option>
                  {(ctx.payments ?? []).map((p) => <option key={p.id} value={p.id}>{formatMoney(p.amount, p.currency)} — {p.date ? formatDate(p.date) : 'date inconnue'}</option>)}
                </select>
              )}
              {rel.withdrawal && (
                <select aria-label="Rétractation" className="rounded-md border bg-background px-2 py-1.5 text-xs" value={withdrawalId} onChange={(e) => setWithdrawalId(e.target.value)}>
                  <option value="">{ctx.withdrawals?.length ? 'Rétractation : aucune' : 'Aucune rétractation dans votre compte'}</option>
                  {(ctx.withdrawals ?? []).map((w) => <option key={w.id} value={w.id}>{w.publicReference}</option>)}
                </select>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Rendu identique à l’envoi, avec les données de votre propre compte{preview?.recipient ? ` (${preview.recipient})` : ''}.</p>
          {preview?.incomplete && (
            <p className="text-xs rounded border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] px-3 py-2 text-[color:var(--text-warning-soft)]">
              Aperçu incomplet : {preview.missingCount} donnée(s) absente(s) de votre compte, signalée(s) « [donnée indisponible] ».
            </p>
          )}
          {preview ? (
            <div className="space-y-2">
              <p className="text-sm break-words"><span className="text-muted-foreground">Objet :</span> {preview.subject}</p>
              <iframe
                title="Aperçu de l’e-mail"
                sandbox=""
                srcDoc={previewHtml}
                data-testid="template-preview"
                className="w-full h-[70vh] rounded-xl border bg-card"
              />
            </div>
          ) : (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          )}
        </section>
      </div>

      {/* ── Historique ── */}
      <section className="space-y-3" data-testid="template-versions">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="vb-app-section flex items-center gap-2"><History className="h-4 w-4" /> Historique des versions</h2>
          {state.shipped.available && (state.isCustomized || state.shipped.differsFromCurrent) && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={compareShipped}>Comparer avec le texte livré</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirm({ kind: 'reset' })} data-testid="template-reset">
                <Undo2 className="h-3.5 w-3.5 mr-1.5" /> Revenir au texte livré avec l’application
              </Button>
            </div>
          )}
        </div>
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">N°</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Auteur</th>
                <th className="px-3 py-2 font-medium">Origine</th>
                <th className="px-3 py-2 font-medium">Objet</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {state.versions.length === 0 ? (
                <tr className="border-t"><td colSpan={6} className="px-3 py-3 text-xs text-muted-foreground">Aucune version enregistrée.</td></tr>
              ) : state.versions.map((v) => (
                <tr key={v.id} className="border-t align-top">
                  <td className="px-3 py-2 tabular-nums">{v.versionNo}{v.matchesCurrent ? <Badge variant="neutral" className="ml-1.5">actuelle</Badge> : null}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{v.createdAt ? formatDateTime(v.createdAt) : '—'}</td>
                  <td className="px-3 py-2 text-xs break-all">{v.createdByEmail ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {VERSION_SOURCE_LABELS[v.source] ?? v.source}{v.restoredFromVersion ? ` (version ${v.restoredFromVersion})` : ''}
                    {v.note ? <span className="block text-muted-foreground break-words">{v.note}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-xs break-words min-w-[12rem]">{v.subject}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => void openCompare(v)}>Comparer</Button>
                    {!locked && !v.matchesCurrent && (
                      <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'restore', version: v })}>Restaurer</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={!!compare} onOpenChange={(open) => { if (!open) setCompare(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Comparaison</DialogTitle>
            <DialogDescription>{compare?.title} — lignes retirées en rouge barré, ajoutées en vert.</DialogDescription>
          </DialogHeader>
          {compare && (
            <div className="space-y-3">
              <div><p className="vb-app-label mb-1">Objet</p><DiffView ops={compare.subject} /></div>
              <div><p className="vb-app-label mb-1">{state.format === 'html' ? 'Textes des zones' : 'Contenu'}</p><DiffView ops={compare.body} /></div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}>
        <AlertDialogContent>
          {confirm && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirm.kind === 'restore' ? `Restaurer la version ${confirm.version.versionNo} ?` : 'Revenir au texte livré avec l’application ?'}</AlertDialogTitle>
                <AlertDialogDescription>
                  {confirm.kind === 'restore'
                    ? 'Cette version remplacera le texte actuel dès le prochain envoi. Le texte actuel reste dans l’historique.'
                    : 'Le texte livré remplacera le texte actuel dès le prochain envoi, et le modèle ne sera plus personnalisé : les livraisons futures pourront le mettre à jour.'}
                  {dirty ? ' Les modifications non enregistrées seront perdues.' : ''} Action journalisée.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
                <AlertDialogAction onClick={(e) => { e.preventDefault(); void applyConfirm(); }} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
                  {confirm.kind === 'restore' ? 'Restaurer' : 'Revenir au texte livré'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
