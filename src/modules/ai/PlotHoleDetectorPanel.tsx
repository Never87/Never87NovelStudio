import { useMemo, useState } from 'react';
import { Bug, Play, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type { AnalysisCategory, AnalysisFinding, AnalysisSeverity, AnalysisStatus } from '@/types';
import { ANALYSIS_STATUSES } from '@/types';
import { useAnalysis, useOutline, useProjects } from '@/hooks';
import { Select } from './components/fields';
import { ProjectPicker } from './components/ProjectPicker';

const CATEGORY_LABELS: Record<AnalysisCategory, string> = {
  timeline: 'Timeline',
  continuity: 'Continuity',
  character: 'Character',
  'world-rule': 'World rule',
  foreshadowing: 'Foreshadowing',
  logic: 'Logic',
};

const STATUS_LABELS: Record<AnalysisStatus, string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
};

const SEVERITY_TONE: Record<AnalysisSeverity, 'danger' | 'warning' | 'info'> = {
  error: 'danger',
  warning: 'warning',
  info: 'info',
};

/**
 * Plot Hole Detector (P7).
 *
 * Runs DETERMINISTIC analysis over continuity facts + knowledge entries on demand
 * (user-clicked; there are no background scans). Every finding carries at least
 * one evidence location — the schema rejects an evidence-less finding, so the UI
 * cannot surface an unsupported conclusion. Findings are review data only: acting
 * on one never edits the manuscript. The user marks them confirmed/dismissed/
 * resolved or deletes them.
 */
export function PlotHoleDetectorPanel() {
  const { projects, initialLoading: projectsLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const analysis = useAnalysis(effectiveProjectId);
  const outline = useOutline(effectiveProjectId);
  const chapters = useMemo(() => outline.outline.flatMap((volume) => volume.chapters), [outline.outline]);

  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<AnalysisStatus | ''>('');

  const filtered = useMemo(
    () => analysis.findings.filter((finding) => (statusFilter ? finding.status === statusFilter : true)),
    [analysis.findings, statusFilter],
  );

  const chapterTitle = (id: string | null) => (id ? chapters.find((c) => c.id === id)?.title ?? id : null);

  const run = async () => {
    setRunMessage(null);
    setActionError(null);
    try {
      const result = await analysis.runAnalysis();
      setRunMessage(
        `Analysis complete: ${result.created.length} finding(s) created` +
          (result.skippedNoEvidence > 0 ? `, ${result.skippedNoEvidence} skipped (no evidence).` : '.'),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const setStatus = async (finding: AnalysisFinding, status: AnalysisStatus) => {
    setActionError(null);
    try {
      await analysis.updateFinding(finding.id, { status });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (finding: AnalysisFinding) => {
    setActionError(null);
    try {
      await analysis.deleteFinding(finding.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Plot Hole Detector"
        description="Detect timeline conflicts, logic gaps, world-rule violations and unresolved foreshadowing. Every finding cites a manuscript location — no unsupported conclusions."
        actions={<ProjectPicker projects={projects} value={effectiveProjectId} onChange={setProjectId} />}
      />

      {projectsLoading ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Bug className="size-5" aria-hidden />}
          title="No projects yet"
          description="Analysis runs per project. Create a project first."
        />
      ) : (
        <div className="space-y-4">
          <Card padding="md" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" iconLeft={<Play className="size-3.5" />} onClick={() => void run()} loading={analysis.running}>
                Run analysis
              </Button>
              <Select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as AnalysisStatus | '')}
                aria-label="Filter by status"
                className="min-w-36"
              >
                <option value="">All statuses</option>
                {ANALYSIS_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-subtle text-2xs">
              Analysis is deterministic and runs only when you click. Continuity contradictions, actions after death and
              unresolved foreshadowing are checked against your stored facts and entries.
            </p>
            {runMessage ? (
              <p className="text-success text-2xs" role="status">
                {runMessage}
              </p>
            ) : null}
            {actionError ? (
              <p className="text-danger text-2xs" role="alert">
                {actionError}
              </p>
            ) : null}
          </Card>

          {analysis.loading && analysis.findings.length === 0 ? (
            <Card padding="lg">
              <p className="text-subtle text-xs" role="status">
                Loading findings…
              </p>
            </Card>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Bug className="size-5" aria-hidden />}
              title={analysis.findings.length === 0 ? 'No issues detected' : 'No matching findings'}
              description={
                analysis.findings.length === 0
                  ? 'Run analysis to scan your continuity facts and knowledge entries for issues.'
                  : 'Try a different status filter.'
              }
            />
          ) : (
            <ul className="space-y-2">
              {filtered.map((finding) => (
                <li key={finding.id}>
                  <Card padding="md" className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={SEVERITY_TONE[finding.severity]} size="sm">
                            {finding.severity}
                          </Badge>
                          <Badge tone="neutral" size="sm">
                            {CATEGORY_LABELS[finding.category]}
                          </Badge>
                          <Badge tone="accent" size="sm">
                            {STATUS_LABELS[finding.status]}
                          </Badge>
                          <Badge tone="info" size="sm">
                            {finding.origin}
                          </Badge>
                        </div>
                        <h3 className="text-ink mt-1 text-sm font-semibold">{finding.title}</h3>
                      </div>
                      <IconButton variant="ghost" size="sm" label={`Delete ${finding.title}`} icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => void remove(finding)} />
                    </div>

                    <p className="text-muted text-xs">{finding.description}</p>

                    <div>
                      <p className="text-subtle text-2xs font-medium uppercase tracking-wide">Evidence</p>
                      <ul className="mt-0.5 space-y-0.5">
                        {finding.evidence.map((ev, index) => (
                          <li key={index} className="text-subtle text-2xs">
                            📍 {chapterTitle(ev.chapterId) ?? ev.chapterId}
                            {ev.sceneId ? ` / scene ${ev.sceneId}` : ''}
                            {ev.quote ? `: “${ev.quote}”` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {(['confirmed', 'dismissed', 'resolved', 'open'] as AnalysisStatus[]).map((status) => (
                        <Button
                          key={status}
                          variant={finding.status === status ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => void setStatus(finding, status)}
                          disabled={finding.status === status}
                        >
                          {STATUS_LABELS[status]}
                        </Button>
                      ))}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
