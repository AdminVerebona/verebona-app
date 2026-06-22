"use client";

import React from "react";
import { Ticker } from "@/components/ui/ticker";
import { Logo } from "@/components/Logo";
import { Bell, CheckCircle2, AlertTriangle, Info, Sparkles } from "lucide-react";

export default function TickerDemoPage() {
  const newsItems = [
    {
      id: "1",
      content: "🎉 Nouvelle fonctionnalité : Gestion avancée des deadlines",
      type: "success" as const,
      icon: <CheckCircle2 className="w-4 h-4" />
    },
    {
      id: "2",
      content: "⚠️ Maintenance planifiée le 25 novembre de 2h à 4h",
      type: "warning" as const,
      icon: <AlertTriangle className="w-4 h-4" />
    },
    {
      id: "3",
      content: "📢 Nouveau template de rapport disponible dans la bibliothèque",
      type: "info" as const,
      icon: <Info className="w-4 h-4" />
    },
    {
      id: "4",
      content: "✨ 500+ utilisateurs nous font confiance pour gérer leurs actifs",
      type: "success" as const,
      icon: <Sparkles className="w-4 h-4" />
    },
    {
      id: "5",
      content: "🔔 N'oubliez pas de mettre à jour vos documents avant fin du mois",
      type: "info" as const,
      icon: <Bell className="w-4 h-4" />
    },
  ];

  const urgentItems = [
    {
      id: "u1",
      content: "❗ 3 deadlines approchent cette semaine",
      type: "error" as const,
    },
    {
      id: "u2",
      content: "🚨 Mise à jour de sécurité requise",
      type: "error" as const,
    },
  ];

  const simpleItems = [
    {
      id: "s1",
      content: "Bienvenue sur Verebona - One place. Higher value.",
      type: "info" as const,
    },
    {
      id: "s2",
      content: "Gérez tous vos actifs immobiliers en un seul endroit",
      type: "info" as const,
    },
    {
      id: "s3",
      content: "Suivi des deadlines • Documents centralisés • Événements planifiés",
      type: "info" as const,
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <Logo size={40} withText withBaseline />
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-4 py-8 space-y-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">Composant Ticker</h1>
          <p className="text-muted-foreground">
            Bandeau défilant pour afficher des informations importantes en temps réel
          </p>
        </div>

        {/* Demo Sections */}
        <div className="space-y-12">
          {/* Example 1: News & Updates */}
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold mb-1">Actualités et Mises à jour</h2>
              <p className="text-sm text-muted-foreground">
                Vitesse normale • Pause au survol • Plusieurs types de badges
              </p>
            </div>
            <Ticker items={newsItems} speed={30} pauseOnHover />
          </div>

          {/* Example 2: Urgent Alerts */}
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold mb-1">Alertes Urgentes</h2>
              <p className="text-sm text-muted-foreground">
                Vitesse rapide • Type "error" pour attirer l'attention
              </p>
            </div>
            <Ticker items={urgentItems} speed={15} pauseOnHover />
          </div>

          {/* Example 3: Simple Messages */}
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold mb-1">Messages Simples</h2>
              <p className="text-sm text-muted-foreground">
                Vitesse lente • Idéal pour page d'accueil ou landing page
              </p>
            </div>
            <Ticker items={simpleItems} speed={40} pauseOnHover />
          </div>

          {/* Example 4: No Pause on Hover */}
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold mb-1">Défilement Continu</h2>
              <p className="text-sm text-muted-foreground">
                Sans pause au survol • Pour affichage permanent
              </p>
            </div>
            <Ticker items={simpleItems} speed={25} pauseOnHover={false} />
          </div>
        </div>

        {/* Code Examples */}
        <div className="mt-12 p-6 bg-card rounded-lg border">
          <h2 className="text-xl font-semibold mb-4">Exemples d'utilisation</h2>
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-2">Import</h3>
              <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">
{`import { Ticker } from "@/components/ui/ticker";`}
              </pre>
            </div>
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-2">Usage basique</h3>
              <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">
{`const items = [
  { id: "1", content: "Message 1", type: "info" },
  { id: "2", content: "Message 2", type: "success" },
  { id: "3", content: "Message 3", type: "warning" }
];

<Ticker items={items} speed={30} pauseOnHover />`}
              </pre>
            </div>
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-2">Avec icônes</h3>
              <pre className="bg-muted p-4 rounded text-sm overflow-x-auto">
{`import { Bell } from "lucide-react";

const items = [
  { 
    id: "1", 
    content: "Nouveau message", 
    type: "info",
    icon: <Bell className="w-4 h-4" />
  }
];`}
              </pre>
            </div>
          </div>
        </div>

        {/* Props Documentation */}
        <div className="mt-8 p-6 bg-card rounded-lg border">
          <h2 className="text-xl font-semibold mb-4">Props</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-4">Prop</th>
                  <th className="text-left py-2 px-4">Type</th>
                  <th className="text-left py-2 px-4">Default</th>
                  <th className="text-left py-2 px-4">Description</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                <tr className="border-b">
                  <td className="py-2 px-4 font-mono text-xs">items</td>
                  <td className="py-2 px-4">TickerItem[]</td>
                  <td className="py-2 px-4">-</td>
                  <td className="py-2 px-4">Array d'items à afficher</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-4 font-mono text-xs">speed</td>
                  <td className="py-2 px-4">number</td>
                  <td className="py-2 px-4">30</td>
                  <td className="py-2 px-4">Vitesse en secondes (plus petit = plus rapide)</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 px-4 font-mono text-xs">pauseOnHover</td>
                  <td className="py-2 px-4">boolean</td>
                  <td className="py-2 px-4">true</td>
                  <td className="py-2 px-4">Pause l'animation au survol</td>
                </tr>
                <tr>
                  <td className="py-2 px-4 font-mono text-xs">className</td>
                  <td className="py-2 px-4">string</td>
                  <td className="py-2 px-4">""</td>
                  <td className="py-2 px-4">Classes CSS additionnelles</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Types */}
        <div className="mt-8 p-6 bg-card rounded-lg border">
          <h2 className="text-xl font-semibold mb-4">Types de badges</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 border rounded">
              <div className="font-semibold mb-2">info</div>
              <div className="bg-primary/10 text-primary px-3 py-1 rounded-full text-sm border border-primary/20 inline-block">
                Information
              </div>
            </div>
            <div className="p-4 border rounded">
              <div className="font-semibold mb-2">success</div>
              <div className="bg-success/10 text-success px-3 py-1 rounded-full text-sm border border-success/20 inline-block">
                Succès
              </div>
            </div>
            <div className="p-4 border rounded">
              <div className="font-semibold mb-2">warning</div>
              <div className="bg-warning/10 text-warning px-3 py-1 rounded-full text-sm border border-warning/20 inline-block">
                Avertissement
              </div>
            </div>
            <div className="p-4 border rounded">
              <div className="font-semibold mb-2">error</div>
              <div className="bg-destructive/10 text-destructive px-3 py-1 rounded-full text-sm border border-destructive/20 inline-block">
                Erreur
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
