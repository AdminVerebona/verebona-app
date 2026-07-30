"use client"

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Mail, Edit, Send, Settings, Code, Eye, RotateCcw, Database } from 'lucide-react';

interface EmailTemplate {
  id: number;
  type: string;
  subject: string;
  body: string;
  placeholders: string | null;
  updatedAt: string;
}

interface EmailSettings {
  id: number;
  emailsEnabled: boolean;
  senderName: string;
  senderEmail: string;
  replyToEmail: string;
  primaryColor: string;
  footerText: string | null;
  logoUrl: string | null;
  logoUrlLight: string | null;
  logoUrlDark: string | null;
}

export default function AdminEmailTemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Edit dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  
  // Test dialog state
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testTemplate, setTestTemplate] = useState<EmailTemplate | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  
  // Form state
  const [formData, setFormData] = useState({
    subject: '',
    body: '',
  });

  // Settings form state
  const [settingsFormData, setSettingsFormData] = useState<Partial<EmailSettings>>({});

  const [previewMode, setPreviewMode] = useState<'code' | 'preview'>('code');

  // Reset loading state per template
  const [resettingId, setResettingId] = useState<number | null>(null);

  // Seed loading state
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    await Promise.all([loadTemplates(), loadSettings()]);
  };

  const loadTemplates = async () => {
    try {
      setIsLoading(true);
      setError(null);


      const response = await fetch('/api/admin/email-templates', {
      credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors du chargement des templates');
      }

      const data = await response.json();
      
        // Filtrer pour ne garder que les templates système MVP + multi-user
        const systemTemplates = data.filter((t: EmailTemplate) =>
          ['EMAIL_VERIFICATION', 'WELCOME', 'PASSWORD_RESET', 'DEADLINE_REMINDER', 'DEADLINE_OVERDUE', 'PREMIUM_CONFIRMATION', 'DUO_INVITATION', 'MEMBER_REMOVED_DUE_TO_DOWNGRADE', 'ACCOUNT_MEMBER_REMOVED', 'ACCOUNT_INVITATION'].includes(t.type)
        );
      
      setTemplates(systemTemplates);
    } catch (err) {
      console.error('Error loading templates:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const response = await fetch('/api/admin/email-settings', {
      credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setSettings(data);
        setSettingsFormData(data);
      }
    } catch (err) {
      console.error('Error loading settings:', err);
    }
  };

  const handleSaveSettings = async () => {
    try {
      setSettingsLoading(true);

      const response = await fetch('/api/admin/email-settings', {
      credentials: 'include',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(settingsFormData),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la mise à jour des paramètres');
      }

      const updated = await response.json();
      setSettings(updated);
      setSettingsFormData(updated);
      toast.success('Paramètres mis à jour avec succès');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleEdit = (template: EmailTemplate) => {
    setEditingTemplate(template);
    setFormData({
      subject: template.subject,
      body: template.body,
    });
    setPreviewMode('code');
    setEditDialogOpen(true);
  };

  const handleSave = async () => {
    if (!editingTemplate) return;

    try {
      setEditLoading(true);

      const response = await fetch(`/api/admin/email-templates/${editingTemplate.id}`, {
      credentials: 'include',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la mise à jour');
      }

      toast.success('Template mis à jour avec succès');
      setEditDialogOpen(false);
      loadTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setEditLoading(false);
    }
  };

  const handleTestOpen = (template: EmailTemplate) => {
    setTestTemplate(template);
    // Pré-remplir avec l'email de l'admin connecté
    try {
      const userData = JSON.parse(localStorage.getItem('user') || '{}');
      setTestEmail(userData.email || '');
    } catch {
      setTestEmail('');
    }
    setTestDialogOpen(true);
  };

  const handleTestSend = async () => {
    if (!testTemplate || !testEmail) return;

    try {
      setTestLoading(true);

      const response = await fetch(`/api/admin/email-templates/${testTemplate.id}/test`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ testEmail }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de l\'envoi du test');
      }

      toast.success('Email de test envoyé avec succès');
      setTestDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de l\'envoi');
    } finally {
      setTestLoading(false);
    }
  };

  // Réinitialiser un template à sa version par défaut (avec logo centré)
  const handleReset = async (template: EmailTemplate) => {
    try {
      setResettingId(template.id);
      const res = await fetch(`/api/admin/email-templates/${template.id}/reset`, {
      credentials: 'include',
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Impossible de réinitialiser');
      }
      toast.success('Template réinitialisé');
      await loadTemplates();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setResettingId(null);
    }
  };

  const handleSeed = async () => {
    try {
      setSeeding(true);

      const res = await fetch('/api/admin/email-templates/seed', {
      credentials: 'include',
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur lors du seed');

      const created = data.created as string[];
      const skipped = data.skipped as string[];
      if (created.length > 0) {
        toast.success(`${created.length} template(s) créé(s) : ${created.join(', ')}`);
      } else {
        toast.success(`Tous les templates sont déjà présents (${skipped.length} ignorés)`);
      }
      await loadTemplates();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setSeeding(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      'EMAIL_VERIFICATION': 'Vérification email',
      'WELCOME': 'Bienvenue',
      'PASSWORD_RESET': 'Réinitialisation mot de passe',
      'DEADLINE_REMINDER': 'Rappel échéance',
      'DEADLINE_OVERDUE': 'Échéance dépassée',
      'PREMIUM_CONFIRMATION': 'Confirmation abonnement Premium',
      'DUO_INVITATION': 'Invitation DUO',
      'MEMBER_REMOVED_DUE_TO_DOWNGRADE': 'Membre retiré (downgrade)',
      'ACCOUNT_MEMBER_REMOVED': 'Membre retiré du compte',
      'ACCOUNT_INVITATION': 'Invitation compte',
    };
    return labels[type] || type;
  };

  const parsePlaceholders = (placeholders: string | null): string[] => {
    if (!placeholders) return [];
    try {
      return JSON.parse(placeholders);
    } catch {
      return [];
    }
  };

  const isHtmlContent = (content: string): boolean => {
    return /<[a-z][\s\S]*>/i.test(content);
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-destructive">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Templates Email</h1>
          <p className="text-muted-foreground mt-1">
            Gestion des emails transactionnels système
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSeed}
          disabled={seeding}
          className="shrink-0 mt-1"
        >
          <Database className="w-4 h-4 mr-2" />
          {seeding ? 'Chargement…' : 'Initialiser les templates'}
        </Button>
      </div>

      {/* Paramètres Généraux */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Paramètres Généraux des Emails
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {settings ? (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <Label>Activer l'envoi d'emails</Label>
                  <p className="text-sm text-muted-foreground">
                    Désactive tous les envois en cas d'incident
                  </p>
                </div>
                <Switch
                  checked={settingsFormData.emailsEnabled ?? true}
                  onCheckedChange={(checked) => 
                    setSettingsFormData({ ...settingsFormData, emailsEnabled: checked })
                  }
                />
              </div>

              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                <div>
                  <Label htmlFor="senderName">Nom expéditeur</Label>
                  <Input
                    id="senderName"
                    value={settingsFormData.senderName || ''}
                    onChange={(e) => 
                      setSettingsFormData({ ...settingsFormData, senderName: e.target.value })
                    }
                    placeholder="Verebona"
                  />
                </div>

                <div>
                  <Label htmlFor="senderEmail">Email expéditeur</Label>
                  <Input
                    id="senderEmail"
                    type="email"
                    value={settingsFormData.senderEmail || ''}
                    onChange={(e) => 
                      setSettingsFormData({ ...settingsFormData, senderEmail: e.target.value })
                    }
                    placeholder="noreply@verebona.com"
                  />
                </div>
              </div>

                <div>
                  <Label htmlFor="replyToEmail">Email de réponse</Label>
                  <Input
                    id="replyToEmail"
                    type="email"
                    value={settingsFormData.replyToEmail || ''}
                    onChange={(e) => 
                      setSettingsFormData({ ...settingsFormData, replyToEmail: e.target.value })
                    }
                    placeholder="support@verebona.com"
                  />
                </div>

                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="logoUrl">URL du logo (Public)</Label>
                    <Input
                      id="logoUrl"
                      value={settingsFormData.logoUrl || ''}
                      onChange={(e) => 
                        setSettingsFormData({ ...settingsFormData, logoUrl: e.target.value })
                      }
                      placeholder="https://example.com/logo.png"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Utilisé si les versions claire/sombre ne sont pas définies.
                    </p>
                  </div>

                  <div>
                    <Label htmlFor="logoUrlLight">URL du logo (Version Claire)</Label>
                    <Input
                      id="logoUrlLight"
                      value={settingsFormData.logoUrlLight || ''}
                      onChange={(e) => 
                        setSettingsFormData({ ...settingsFormData, logoUrlLight: e.target.value })
                      }
                      placeholder="https://example.com/logo-light.png"
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="logoUrlDark">URL du logo (Version Sombre)</Label>
                  <Input
                    id="logoUrlDark"
                    value={settingsFormData.logoUrlDark || ''}
                    onChange={(e) => 
                      setSettingsFormData({ ...settingsFormData, logoUrlDark: e.target.value })
                    }
                    placeholder="https://example.com/logo-dark.png"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Optionnel. Si vide, la version claire ou par défaut sera utilisée.
                  </p>
                </div>

                <div>
                  <Label htmlFor="footerText">Texte du footer</Label>
                <Textarea
                  id="footerText"
                  value={settingsFormData.footerText || ''}
                  onChange={(e) => 
                    setSettingsFormData({ ...settingsFormData, footerText: e.target.value })
                  }
                  placeholder="© 2025 Verebona. Tous droits réservés."
                  rows={2}
                />
              </div>

              <Button 
                onClick={handleSaveSettings} 
                disabled={settingsLoading}
              >
                {settingsLoading ? 'Enregistrement...' : 'Sauvegarder les paramètres'}
              </Button>
            </>
          ) : (
            <Skeleton className="h-64" />
          )}
        </CardContent>
      </Card>

      {/* Templates List */}
      <div>
        <h2 className="text-xl font-semibold mb-4">Templates Système</h2>
        {isLoading ? (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <div className="text-center text-muted-foreground">
                <p className="mb-4">Aucun template système trouvé.</p>
                <p className="text-sm">
                  Exécutez le seeder pour créer les templates par défaut :
                </p>
                <code className="block mt-2 p-2 bg-muted rounded text-xs">
                  bun src/db/seeds/email_templates_system.ts
                </code>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => (
              <Card key={template.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Mail className="w-4 h-4" />
                    {getTypeLabel(template.type)}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Sujet</div>
                    <div className="text-sm font-medium">{template.subject}</div>
                  </div>

                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Corps</div>
                    <div className="text-sm line-clamp-3 bg-muted p-2 rounded">
                      {template.body}
                    </div>
                  </div>

                  {template.placeholders && (
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">Variables disponibles</div>
                      <div className="flex flex-wrap gap-1">
                        {parsePlaceholders(template.placeholders).map((placeholder) => (
                          <Badge key={placeholder} variant="secondary" className="text-xs font-mono">
                            {`{{${placeholder}}}`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="text-xs text-muted-foreground pt-2 border-t">
                    Mis à jour le {formatDate(template.updatedAt)}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleEdit(template)}
                    >
                      <Edit className="h-4 w-4 mr-1" />
                      Modifier
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTestOpen(template)}
                      title="Envoyer un email de test"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReset(template)}
                      disabled={resettingId === template.id}
                      title="Réinitialiser au template par défaut"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Modifier le template email</DialogTitle>
            <DialogDescription>
              {editingTemplate && `Template: ${getTypeLabel(editingTemplate.type)}`}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 overflow-y-auto flex-1">
            <div>
              <Label htmlFor="subject">Sujet</Label>
              <Input
                id="subject"
                value={formData.subject}
                onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                placeholder="Ex: Vérifiez votre adresse email"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <Label htmlFor="body">Corps du message (Texte simple ou HTML)</Label>
                <Tabs value={previewMode} onValueChange={(v) => setPreviewMode(v as 'code' | 'preview')} className="w-auto">
                  <TabsList className="h-8">
                    <TabsTrigger value="code" className="text-xs h-7 px-3">
                      <Code className="h-3 w-3 mr-1" />
                      Code
                    </TabsTrigger>
                    <TabsTrigger value="preview" className="text-xs h-7 px-3">
                      <Eye className="h-3 w-3 mr-1" />
                      Aperçu
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {previewMode === 'code' ? (
                <>
                  <Textarea
                    id="body"
                    value={formData.body}
                    onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                    placeholder="Texte simple :&#10;Bonjour {{firstName}},&#10;&#10;HTML :&#10;<html><body><h1>Bonjour {{firstName}}</h1><p>Votre message ici...</p></body></html>"
                    rows={16}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    💡 Vous pouvez coller du <strong>HTML complet</strong> ou du texte simple. 
                    Utilisez les variables : {`{{firstName}}`}, {`{{verificationUrl}}`}, etc.
                  </p>
                </>
              ) : (
                <div className="border rounded-md p-4 bg-muted min-h-[400px] max-h-[400px] overflow-auto">
                  {isHtmlContent(formData.body) ? (
                    <div 
                      dangerouslySetInnerHTML={{ __html: formData.body }}
                      className="prose prose-sm max-w-none"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap text-sm font-sans">
                      {formData.body}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {editingTemplate && (
              <div className="bg-muted p-3 rounded">
                <div className="text-sm font-medium mb-2">Variables disponibles pour ce template:</div>
                <div className="flex flex-wrap gap-1">
                  {parsePlaceholders(editingTemplate.placeholders).map((placeholder) => (
                    <code key={placeholder} className="bg-background px-2 py-1 rounded text-xs font-mono">
                      {`{{${placeholder}}}`}
                    </code>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(false)}
              disabled={editLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleSave}
              disabled={editLoading}
            >
              {editLoading ? 'Enregistrement...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test Dialog */}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tester l'envoi d'email</DialogTitle>
            <DialogDescription>
              {testTemplate && `Template: ${getTypeLabel(testTemplate.type)}`}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="testEmail">Adresse email de test</Label>
              <Input
                id="testEmail"
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="admin@example.com"
              />
              <p className="text-xs text-muted-foreground mt-1">
                L'email sera envoyé avec des valeurs de test automatiques
              </p>
            </div>

            {testTemplate && (
              <div className="bg-muted p-3 rounded text-sm">
                <div className="font-medium mb-1">Aperçu:</div>
                <div className="space-y-1 text-muted-foreground">
                  <div><strong>Sujet:</strong> {testTemplate.subject}</div>
                  <div><strong>Corps:</strong> {testTemplate.body.substring(0, 100)}...</div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTestDialogOpen(false)}
              disabled={testLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleTestSend}
              disabled={testLoading || !testEmail}
            >
              <Send className="h-4 w-4 mr-2" />
              {testLoading ? 'Envoi...' : 'Envoyer le test'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
