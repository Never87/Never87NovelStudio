import { BookOpen, Bug, DatabaseBackup, HelpCircle, KeyRound, LifeBuoy, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui';
import { ButtonLink } from '@/components/ui';

/**
 * Help & About (Round 1 — System, was PLACEHOLDER).
 *
 * A real orientation surface: what the app does, where your data lives, and
 * working shortcuts into the modules that matter. Every link points at a real
 * route that exists in this build (verified against `config/navigation.ts`), so
 * nothing here is a dead end.
 */

const APP_NAME = 'Never87 Novel Studio';

interface Shortcut {
  title: string;
  description: string;
  to: string;
  icon: ReactNode;
}

const SHORTCUTS: Shortcut[] = [
  {
    title: 'Start a project',
    description: 'Create your novel, set genre, target length and author details.',
    to: '/projects',
    icon: <BookOpen className="size-4" />,
  },
  {
    title: 'Configure AI',
    description: 'Add a provider and models to unlock AI writing assistance.',
    to: '/settings/providers',
    icon: <KeyRound className="size-4" />,
  },
  {
    title: 'Back up your work',
    description: 'Export a project as a portable package, or restore from one.',
    to: '/data/backup-restore',
    icon: <DatabaseBackup className="size-4" />,
  },
  {
    title: 'Ask the AI',
    description: 'Get suggestions and answer questions without touching a draft.',
    to: '/ai/assistance',
    icon: <Sparkles className="size-4" />,
  },
];

export function HelpPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<HelpCircle className="size-4" />}
        eyebrow="System"
        title="Help & About"
        description="What this app does, where your work is stored, and how to get going."
        actions={<Badge tone="neutral" size="md">v0.0.0 · {import.meta.env.MODE}</Badge>}
      />

      <Card padding="md">
        <CardHeader title={`About ${APP_NAME}`} description="A local-first novel writing studio" icon={<LifeBuoy className="size-4" />} />
        <p className="text-muted mt-3 text-sm leading-relaxed">
          {APP_NAME} is an offline-capable writing environment: plan your world, characters, narrative and outline, then
          write chapter and scene prose with autosave and version history. Optional AI tools help you brainstorm, edit
          and analyse your writing — always as suggestions you choose to apply.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="neutral" size="sm">Local-first</Badge>
          <Badge tone="neutral" size="sm">Autosave + versions</Badge>
          <Badge tone="neutral" size="sm">Markdown / DOCX / PDF / EPUB export</Badge>
          <Badge tone="neutral" size="sm">Bring your own AI keys</Badge>
        </div>
      </Card>

      <Card padding="md">
        <CardHeader title="Quick start" description="Jump straight to the essentials" icon={<Sparkles className="size-4" />} />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {SHORTCUTS.map((shortcut) => (
            <ButtonLink
              key={shortcut.to}
              to={shortcut.to}
              variant="secondary"
              size="md"
              className="h-auto justify-start px-3 py-3 text-left"
              iconLeft={shortcut.icon}
            >
              <span className="flex flex-col">
                <span className="text-ink text-sm font-medium">{shortcut.title}</span>
                <span className="text-subtle text-2xs font-normal">{shortcut.description}</span>
              </span>
            </ButtonLink>
          ))}
        </div>
      </Card>

      <Card padding="md">
        <CardHeader title="Your data stays yours" description="Privacy in plain terms" icon={<DatabaseBackup className="size-4" />} />
        <ul className="text-muted mt-3 list-disc space-y-1.5 pl-5 text-sm">
          <li>Novel content is stored in your browser&apos;s IndexedDB on this device.</li>
          <li>Nothing is uploaded anywhere unless you explicitly use an AI provider with your own API key.</li>
          <li>Export a project any time for a complete, portable backup.</li>
          <li>API keys are stored locally and are never included in project exports.</li>
        </ul>
      </Card>

      <Card padding="md">
        <CardHeader title="Something look wrong?" description="Report a problem" icon={<Bug className="size-4" />} />
        <p className="text-muted mt-3 text-sm">
          The most useful bug reports include what you did, what you expected, and what actually happened. Because the app
          is local-first, a project backup (from <span className="text-ink">Backup &amp; Restore</span>) can help reproduce an issue.
        </p>
      </Card>
    </div>
  );
}
