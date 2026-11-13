import { useMemo, useRef, useState } from 'react';
import {
  Copy,
  Download,
  FileClock,
  MessageSquareCode,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type { PromptTemplate } from '@/types';
import { TASK_PROMPTS } from '@/services';
import { usePromptTemplates, useProjects } from '@/hooks';
import { ProjectPicker } from './components/ProjectPicker';
import { TemplateEditorDialog, type TemplateEditorValues } from './components/TemplateEditorDialog';
import { VersionHistoryDialog } from './components/VersionHistoryDialog';

/**
 * Prompt Engineering Center (P6).
 *
 * Manage a project's editable prompt templates: create, edit (which appends a
 * new version), duplicate, delete, browse history and restore, and import/export
 * portable bundles. Everything is per-project; a project picker selects which
 * project's templates are shown.
 */
export function PromptTemplatesPanel() {
  const { projects, initialLoading: projectsLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const prompts = usePromptTemplates(effectiveProjectId);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<PromptTemplate | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, PromptTemplate[]>();
    for (const template of prompts.templates) {
      const key = template.category || 'Uncategorised';
      const list = map.get(key) ?? [];
      list.push(template);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [prompts.templates]);

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (template: PromptTemplate) => {
    setEditing(template);
    setEditorOpen(true);
  };
  const openHistory = (template: PromptTemplate) => {
    setHistoryTarget(template);
    setHistoryOpen(true);
  };

  const submitEditor = async (values: TemplateEditorValues) => {
    if (editing) {
      await prompts.updateTemplate(editing.id, {
        name: values.name,
        description: values.description,
        category: values.category,
        content: values.content,
        variables: values.variables,
        taskKind: values.taskKind,
        enabled: values.enabled,
        versionLabel: values.versionLabel || undefined,
      });
    } else {
      await prompts.createTemplate({
        name: values.name,
        description: values.description,
        category: values.category,
        content: values.content,
        variables: values.variables,
        taskKind: values.taskKind,
        enabled: values.enabled,
      });
    }
  };

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    setActionInfo(null);
    try {
      await action();
    } catch (error) {
      setActionError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportAll = () =>
    runAction('Export', async () => {
      const bundle = await prompts.exportBundle();
      const blob = new Blob([bundle], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'prompt-templates.json';
      anchor.click();
      URL.revokeObjectURL(url);
    });

  const onImportFile = (file: File) =>
    runAction('Import', async () => {
      const text = await file.text();
      const result = await prompts.importBundle(text);
      const parts = [`Imported ${result.imported}`];
      if (result.conflicted > 0) parts.push(`${result.conflicted} as renamed copies (name clash)`);
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
      const summary = `${parts.join(', ')}.`;
      // Prefer the success/info line unless there were genuine skips/invalids.
      const problems = result.details.filter((detail) => detail.status === 'skipped' || detail.status === 'invalid');
      if (problems.length > 0) {
        const reasons = problems.map((detail) => `${detail.name}: ${detail.reason ?? detail.status}`).join('; ');
        setActionInfo(summary);
        setActionError(`Skipped/invalid entries — ${reasons}`);
      } else {
        setActionInfo(summary);
      }
    });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Prompt Engineering Center"
        description="Create, version and reuse prompt templates with variables. Edits append new versions; history is never overwritten."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ProjectPicker projects={projects} value={effectiveProjectId} onChange={setProjectId} />
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Plus className="size-4" />}
              onClick={openCreate}
              disabled={!effectiveProjectId}
            >
              New template
            </Button>
          </div>
        }
      />

      {projectsLoading ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<MessageSquareCode className="size-5" aria-hidden />}
          title="No projects yet"
          description="Prompt templates belong to a project. Create a project first, then build reusable prompts for it."
          hints={['Templates can be bound to an AI task as its default', 'Variables make one template reusable across chapters']}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<RefreshCw className="size-3.5" />}
              onClick={() => void runAction('Seed defaults', () => prompts.ensureBuiltins())}
              disabled={busy || prompts.templates.length > 0}
              title={prompts.templates.length > 0 ? 'Defaults are seeded only into an empty project' : 'Create the built-in templates'}
            >
              Seed built-in templates
            </Button>
            <Button variant="secondary" size="sm" iconLeft={<Download className="size-3.5" />} onClick={() => void exportAll()} disabled={busy || prompts.templates.length === 0}>
              Export
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Upload className="size-3.5" />}
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || !effectiveProjectId}
            >
              Import
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onImportFile(file);
                event.target.value = '';
              }}
            />
            {prompts.status === 'loading' ? (
              <span className="text-subtle text-2xs" role="status">
                Loading templates…
              </span>
            ) : null}
          </div>

          {actionError ? (
            <p className="text-danger text-xs" role="alert">
              {actionError}
            </p>
          ) : null}
          {actionInfo ? (
            <p className="text-muted text-xs" role="status">
              {actionInfo}
            </p>
          ) : null}

          {prompts.status === 'empty' || (prompts.status === 'success' && prompts.templates.length === 0) ? (
            <EmptyState
              icon={<MessageSquareCode className="size-5" aria-hidden />}
              title="No prompt templates"
              description="Seed the built-in templates to start from working defaults, or create your own from scratch."
              action={
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => void runAction('Seed defaults', () => prompts.ensureBuiltins())} disabled={busy}>
                    Seed built-in templates
                  </Button>
                  <Button variant="secondary" size="sm" onClick={openCreate}>
                    New template
                  </Button>
                </div>
              }
            />
          ) : null}

          {grouped.map(([category, templates]) => (
            <div key={category} className="space-y-2">
              <p className="text-subtle text-2xs font-medium uppercase tracking-wide">{category}</p>
              <div className="grid gap-2">
                {templates.map((template) => (
                  <Card key={template.id} padding="sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-ink truncate text-sm font-medium">{template.name}</span>
                          <Badge tone="neutral" size="sm">
                            v{template.version}
                          </Badge>
                          {template.isDefault && template.taskKind ? (
                            <Badge tone="accent" size="sm">
                              Default · {TASK_PROMPTS[template.taskKind]?.label ?? template.taskKind}
                            </Badge>
                          ) : template.taskKind ? (
                            <Badge tone="info" size="sm">
                              {TASK_PROMPTS[template.taskKind]?.label ?? template.taskKind}
                            </Badge>
                          ) : null}
                          {!template.enabled ? (
                            <Badge tone="neutral" size="sm">
                              Disabled
                            </Badge>
                          ) : null}
                        </div>
                        {template.description ? <p className="text-muted mt-0.5 text-xs">{template.description}</p> : null}
                        <p className="text-subtle mt-1 font-mono text-2xs">
                          {template.variables.length} variable{template.variables.length === 1 ? '' : 's'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <IconButton variant="ghost" size="sm" label={`History of ${template.name}`} icon={<FileClock className="size-3.5" aria-hidden />} onClick={() => openHistory(template)} />
                        <IconButton variant="ghost" size="sm" label={`Duplicate ${template.name}`} icon={<Copy className="size-3.5" aria-hidden />} onClick={() => void runAction('Duplicate', () => prompts.duplicateTemplate(template.id).then(() => undefined))} disabled={busy} />
                        <IconButton variant="ghost" size="sm" label={`Edit ${template.name}`} icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => openEdit(template)} />
                        <IconButton
                          variant="ghost"
                          size="sm"
                          label={`Delete ${template.name}`}
                          icon={<Trash2 className="size-3.5" aria-hidden />}
                          onClick={() => {
                            if (window.confirm(`Delete "${template.name}" and its entire version history?`)) {
                              void runAction('Delete', () => prompts.deleteTemplate(template.id));
                            }
                          }}
                          disabled={busy}
                        />
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      <TemplateEditorDialog
        open={editorOpen}
        template={editing}
        onClose={() => setEditorOpen(false)}
        onSubmit={submitEditor}
      />

      <VersionHistoryDialog
        open={historyOpen}
        template={historyTarget}
        loadVersions={prompts.getVersions}
        onRestore={(templateId, versionId) => prompts.restoreVersion(templateId, versionId).then(() => undefined)}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}
