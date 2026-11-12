import { useState } from 'react';
import {
  Compass,
  Flag,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  TriangleAlert,
  Disc3,
} from 'lucide-react';
import { Badge, Button, Card, CardHeader } from '@/components/ui';
import type { NarrativePlan } from '@/types';
import { useNarrative } from '@/hooks';
import type { CreateNarrativeInput, UpdateNarrativeInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import { formatDate } from '@/modules/projects/project-meta';
import { cn } from '@/utils/cn';
import {
  NARRATIVE_STATUS_META,
  NARRATIVE_STRUCTURE_META,
} from './narrative-meta';
import { NarrativeFormDialog } from './components/NarrativeFormDialog';

/**
 * Narrative-planning section of the project detail page.
 *
 * One plan per project. States: loading / error / empty (create CTA) /
 * populated. All data flows through `useNarrative`.
 */
export function NarrativePanel({ projectId }: { projectId: string }) {
  const { plan, status, loading, isEmpty, error, refresh, createPlan, updatePlan, deletePlan } =
    useNarrative(projectId);

  const [formOpen, setFormOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleCreate = async (input: CreateNarrativeInput | UpdateNarrativeInput) => {
    await createPlan(input as CreateNarrativeInput);
  };

  const handleUpdate = async (input: CreateNarrativeInput | UpdateNarrativeInput) => {
    await updatePlan(input as UpdateNarrativeInput);
  };

  if (status === 'loading' && loading) {
    return (
      <Card padding="lg">
        <div
          className="text-subtle flex items-center justify-center gap-2 py-8 text-xs"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading narrative plan…
        </div>
      </Card>
    );
  }

  if (status === 'error') {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : 'Error';
    return (
      <Card padding="lg" className="flex flex-col items-center text-center" role="alert">
        <span className="bg-danger-soft text-danger grid size-10 place-items-center rounded-lg">
          <TriangleAlert className="size-5" aria-hidden />
        </span>
        <h3 className="text-ink mt-3 text-sm font-semibold">Couldn’t load the narrative plan</h3>
        <p className="text-muted mt-1 max-w-md text-xs">
          Something went wrong while reading this project’s plan. Your data has not been changed.
        </p>
        <pre className="bg-surface-muted text-subtle mt-3 max-h-24 w-full max-w-md overflow-auto rounded-md p-2 text-2xs whitespace-pre-wrap break-words">
          {name}: {message}
        </pre>
        <Button
          variant="primary"
          size="sm"
          className="mt-4"
          iconLeft={<RefreshCw className="size-3.5" />}
          onClick={() => void refresh()}
        >
          Retry
        </Button>
      </Card>
    );
  }

  if (isEmpty || !plan) {
    return (
      <Card padding="lg" className="flex flex-col items-center text-center">
        <span className="bg-surface text-subtle mb-3 grid size-11 place-items-center rounded-lg border border-line">
          <Compass className="size-5" aria-hidden />
        </span>
        <h3 className="text-ink text-sm font-semibold">No narrative plan yet</h3>
        <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
          Capture the story you intend to tell — premise, theme, central conflict, stakes and the
          beats that carry the reader from opening to resolution.
        </p>
        <Button
          variant="primary"
          size="sm"
          className="mt-4"
          iconLeft={<Plus className="size-3.5" />}
          onClick={() => setFormOpen(true)}
        >
          Create narrative plan
        </Button>
        <NarrativeFormDialog
          open={formOpen}
          onSubmit={handleCreate}
          onClose={() => setFormOpen(false)}
        />
      </Card>
    );
  }

  const structureMeta = NARRATIVE_STRUCTURE_META[plan.structure];
  const statusMeta = NARRATIVE_STATUS_META[plan.status];

  return (
    <div className="space-y-4">
      <Card padding="md">
        <CardHeader
          icon={<Compass className="size-4" aria-hidden />}
          title={plan.logline || 'Untitled narrative plan'}
          description={`${structureMeta.label} · ${structureMeta.description}`}
          action={
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Pencil className="size-3.5" />}
                onClick={() => setFormOpen(true)}
              >
                Edit
              </Button>
              <Button
                variant="danger"
                size="sm"
                iconLeft={<Trash2 className="size-3.5" />}
                onClick={() => setDeleteOpen(true)}
              >
                Delete
              </Button>
            </div>
          }
        />

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge tone={statusMeta.tone} dot>
            {statusMeta.label}
          </Badge>
          <Badge tone="neutral">{structureMeta.label}</Badge>
          {plan.beats.length > 0 ? (
            <Badge tone="info">
              {plan.beats.length} beat{plan.beats.length === 1 ? '' : 's'}
            </Badge>
          ) : null}
          <span className="text-subtle text-2xs">Updated {formatDate(plan.updatedAt)}</span>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextBlock label="Premise" value={plan.premise} />
          <TextBlock label="Theme" value={plan.theme} />
          <TextBlock label="Central conflict" value={plan.centralConflict} icon={<Target className="size-3.5" aria-hidden />} />
          <TextBlock label="Stakes" value={plan.stakes} icon={<TriangleAlert className="size-3.5" aria-hidden />} />
          <TextBlock label="Ending" value={plan.ending} icon={<Flag className="size-3.5" aria-hidden />} />
          <TextBlock label="Motifs" value={plan.motifs.join(', ')} icon={<Disc3 className="size-3.5" aria-hidden />} />
        </div>
      </Card>

      <BeatTimeline plan={plan} onEdit={() => setFormOpen(true)} />

      <NarrativeFormDialog
        open={formOpen}
        initialPlan={plan}
        onSubmit={handleUpdate}
        onClose={() => setFormOpen(false)}
      />

      <ProjectDialog
        open={deleteOpen}
        title="Delete narrative plan?"
        description="This removes this project's narrative plan and all of its beats."
        tone="danger"
        dismissible
        onClose={() => setDeleteOpen(false)}
        footer={
          <DeletePlanFooter
            onCancel={() => setDeleteOpen(false)}
            onConfirm={deletePlan}
            onDone={() => setDeleteOpen(false)}
          />
        }
      >
        <p className="text-muted text-xs">
          The plan will be permanently removed. This cannot be undone. Your project, world and
          characters are not affected.
        </p>
      </ProjectDialog>
    </div>
  );
}

/** A labelled multi-line text block; renders a muted placeholder when empty. */
function TextBlock({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-subtle flex items-center gap-1 text-2xs font-medium uppercase tracking-wide">
        {icon}
        {label}
      </p>
      {value.trim() ? (
        <p className="text-muted mt-1 text-xs whitespace-pre-line">{value}</p>
      ) : (
        <p className="text-subtle mt-1 text-xs italic">Not set</p>
      )}
    </div>
  );
}

/** Ordered beat list with a proportional position marker. */
function BeatTimeline({ plan, onEdit }: { plan: NarrativePlan; onEdit: () => void }) {
  if (plan.beats.length === 0) {
    return (
      <Card padding="md" className="flex flex-col items-center text-center">
        <h3 className="text-ink text-sm font-semibold">No beats yet</h3>
        <p className="text-muted mt-1 max-w-md text-xs">
          Add plot beats to map the journey from opening to resolution, or apply a structure preset.
        </p>
        <Button variant="secondary" size="sm" className="mt-3" iconLeft={<Plus className="size-3.5" />} onClick={onEdit}>
          Add beats
        </Button>
      </Card>
    );
  }

  return (
    <Card padding="md">
      <h2 className="text-ink mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <Sparkles className="size-4 text-accent" aria-hidden />
        Beat timeline
      </h2>
      <ol className="relative space-y-3">
        {plan.beats.map((beat, index) => (
          <li key={beat.id} className="relative flex gap-3">
            <div className="flex flex-col items-center">
              <span className="bg-accent-soft text-accent-soft-text grid size-6 shrink-0 place-items-center rounded-full text-2xs font-semibold">
                {index + 1}
              </span>
              {index < plan.beats.length - 1 ? (
                <span className="bg-line mt-1 w-px flex-1" aria-hidden />
              ) : null}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-ink text-sm font-medium break-words">{beat.title}</h3>
                <span className="text-subtle text-2xs">{beat.position}%</span>
              </div>
              {beat.description.trim() ? (
                <p className="text-muted mt-0.5 text-xs whitespace-pre-line">{beat.description}</p>
              ) : null}
              <div className="bg-surface-muted mt-1.5 h-1 w-full overflow-hidden rounded-full" aria-hidden>
                <div
                  className={cn('bg-accent h-full rounded-full')}
                  style={{ width: `${beat.position}%` }}
                />
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-subtle border-line mt-3 flex items-center gap-1 border-t pt-2 text-2xs">
        <ShieldCheck className="size-3.5" aria-hidden />
        Positions are relative markers (0–100%), not exact page numbers.
      </p>
    </Card>
  );
}

/** Delete confirmation with its own in-flight / error state. */
function DeletePlanFooter({
  onCancel,
  onConfirm,
  onDone,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
      onDone();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {failure ? (
        <p className="text-danger text-2xs" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" loading={busy} onClick={() => void run()}>
          Delete plan
        </Button>
      </div>
    </div>
  );
}
