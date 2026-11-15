/**
 * Portfolio page (P9 Batch E) — `/publishing/portfolio`.
 *
 * A curated overview of the author's body of work. It shows every project as a
 * catalog card (title, author, cover, blurb, genre, tags, status, word target…)
 * and lets the author CURATE the presentation of any one project via a display
 * profile without ever overwriting the project's internal description or the
 * Blurb Generator output.
 *
 * ## Where the data comes from (no duplication)
 *
 *   - title / genre / tags / status / target / blurb → the PROJECT row (live);
 *   - cover → the Book Covers module (`ProjectCoverThumb` resolves it live);
 *   - display overrides (title/pen-name/tagline/category/featured/order/links)
 *     → the optional `PortfolioProfile` (the ONLY thing this page writes).
 *
 * The "display preview" panel shows exactly what a reader would see, clearly
 * marking which fields are curated overrides vs. values falling back to the
 * project, so nothing is ever misrepresented as the source of truth.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Briefcase, Check, Eye, Info, Link2, Loader2, Pin, Save, Star, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { usePortfolio } from '@/hooks';
import { PROJECT_STATUS_META } from '@/modules/projects/project-meta';
import { ProjectCoverThumb } from '@/modules/dashboard/components/ProjectCoverThumb';
import { formatRelative } from '@/utils/date';
import type { PortfolioEntry, UpdatePortfolioProfileInput } from '@/schemas/portfolio-profile';
import { cn } from '@/utils/cn';

/** The editable form state for the selected project's display profile. */
interface ProfileFormState {
  displayTitle: string;
  penName: string;
  tagline: string;
  category: string;
  featured: boolean;
  displayOrder: string;
  links: Array<{ label: string; url: string }>;
}

function formFromEntry(entry: PortfolioEntry, rawProfile: {
  displayTitle?: string;
  penName?: string;
  tagline?: string;
  category?: string;
  featured: boolean;
  displayOrder: number;
  links: Array<{ label: string; url: string }>;
} | null): ProfileFormState {
  return {
    displayTitle: rawProfile?.displayTitle ?? '',
    penName: rawProfile?.penName ?? '',
    tagline: rawProfile?.tagline ?? '',
    category: rawProfile?.category ?? '',
    featured: rawProfile?.featured ?? entry.featured,
    displayOrder: String(rawProfile?.displayOrder ?? entry.displayOrder ?? 0),
    links: rawProfile?.links ?? [],
  };
}

/** Formats a number as "1,200 words". */
function formatWords(n: number): string {
  return `${n.toLocaleString()} words`;
}

export function PortfolioPage() {
  const portfolio = usePortfolio();
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<ProfileFormState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const effectiveId = selectedId || portfolio.entries[0]?.projectId || '';
  const selectedEntry = useMemo(
    () => portfolio.entries.find((e) => e.projectId === effectiveId) ?? null,
    [portfolio.entries, effectiveId],
  );

  // Load the RAW profile for the selected project (to seed the editor). The
  // resolved entry already carries the merged view for display.
  useEffect(() => {
    let cancelled = false;
    setMessage(null);
    setActionError(null);
    if (!effectiveId) {
      setForm(null);
      return;
    }
    void (async () => {
      try {
        const raw = await portfolio.getProfile(effectiveId);
        if (cancelled) return;
        const entry = portfolio.entries.find((e) => e.projectId === effectiveId);
        if (entry) setForm(formFromEntry(entry, raw));
      } catch {
        if (!cancelled) setForm(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `portfolio.entries` changes after every save (refresh) — re-seeding on each
    // change keeps the editor in sync with the persisted state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveId, portfolio.entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return portfolio.entries;
    return portfolio.entries.filter((e) =>
      [e.title, e.author ?? '', e.tagline ?? '', e.category ?? '', e.blurb ?? '', ...e.genre, ...e.tags]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [portfolio.entries, query]);

  const updateForm = useCallback(<K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const setLink = useCallback((index: number, patch: Partial<{ label: string; url: string }>) => {
    setForm((prev) => {
      if (!prev) return prev;
      const links = prev.links.map((l, i) => (i === index ? { ...l, ...patch } : l));
      return { ...prev, links };
    });
  }, []);

  const addLink = useCallback(() => {
    setForm((prev) => (prev ? { ...prev, links: [...prev.links, { label: '', url: '' }] } : prev));
  }, []);

  const removeLink = useCallback((index: number) => {
    setForm((prev) => (prev ? { ...prev, links: prev.links.filter((_, i) => i !== index) } : prev));
  }, []);

  const handleSave = useCallback(async () => {
    if (!form || !effectiveId || saving) return;
    setSaving(true);
    setMessage(null);
    setActionError(null);
    try {
      const order = Number.parseInt(form.displayOrder, 10);
      const input: UpdatePortfolioProfileInput = {
        // `''` clears the override → falls back to the project value.
        displayTitle: form.displayTitle.trim() === '' ? null : form.displayTitle,
        penName: form.penName.trim() === '' ? null : form.penName,
        tagline: form.tagline.trim() === '' ? null : form.tagline,
        category: form.category.trim() === '' ? null : form.category,
        featured: form.featured,
        displayOrder: Number.isFinite(order) ? order : 0,
        links: form.links
          .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
          .filter((l) => l.label !== '' && l.url !== ''),
      };
      await portfolio.saveProfile(effectiveId, input);
      setMessage('Portfolio display saved.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The portfolio display could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [form, effectiveId, saving, portfolio]);

  const handleReset = useCallback(async () => {
    if (!effectiveId || saving) return;
    setSaving(true);
    setMessage(null);
    setActionError(null);
    try {
      await portfolio.deleteProfile(effectiveId);
      setMessage('Display profile removed — reverted to the project values.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The display profile could not be removed.');
    } finally {
      setSaving(false);
    }
  }, [effectiveId, saving, portfolio]);

  /* ------------------------------- render ------------------------------- */

  if (portfolio.initialLoading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Portfolio"
          description="A curated overview of your finished works."
          icon={<Briefcase className="size-4" aria-hidden />}
        />
        <Card padding="lg">
          <p className="text-subtle flex items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading your portfolio…
          </p>
        </Card>
      </div>
    );
  }

  if (portfolio.error && portfolio.entries.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader title="Portfolio" icon={<Briefcase className="size-4" aria-hidden />} />
        <Card padding="md">
          <p className="text-danger flex items-center gap-1.5 text-xs" role="alert">
            <AlertTriangle className="size-3.5" aria-hidden />
            The portfolio could not be loaded.{' '}
            {portfolio.error instanceof Error ? portfolio.error.message : ''}
          </p>
        </Card>
      </div>
    );
  }

  if (portfolio.entries.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Portfolio"
          description="A curated overview of your finished works, series and publishing status."
          icon={<Briefcase className="size-4" aria-hidden />}
        />
        <EmptyState
          icon={<Briefcase className="size-5" aria-hidden />}
          title="Your portfolio is empty"
          description="Create a project first. Once you have works, they appear here as your catalog."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Portfolio"
        description="Your body of work. Curate how each title is presented without changing the project's own summary or blurb."
        icon={<Briefcase className="size-4" aria-hidden />}
        toolbar={
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, author, genre, tag…"
            className="border-line bg-surface text-ink w-full max-w-xs rounded-md border px-2.5 py-1.5 text-xs"
            data-testid="portfolio-search"
            aria-label="Search portfolio"
          />
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        {/* ----------------------- Catalog ----------------------- */}
        <section aria-label="Your works" className="space-y-3" data-testid="portfolio-catalog">
          {filtered.length === 0 ? (
            <EmptyState
              icon={<Briefcase className="size-5" aria-hidden />}
              title="No works match your search"
              description="Try a different title, author, genre or tag."
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {filtered.map((entry) => {
                const statusMeta = PROJECT_STATUS_META[entry.status as keyof typeof PROJECT_STATUS_META] ?? {
                  label: entry.status,
                  tone: 'neutral' as const,
                };
                const active = entry.projectId === effectiveId;
                return (
                  <li key={entry.projectId}>
                    <Card
                      padding="md"
                      interactive
                      className={cn('h-full space-y-3', active && 'border-accent-ring ring-1 ring-accent-ring/40')}
                      data-testid={`portfolio-card-${entry.projectId}`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedId(entry.projectId)}
                        className="flex w-full items-start gap-3 text-left"
                        aria-pressed={active}
                        data-testid={`portfolio-select-${entry.projectId}`}
                      >
                        <ProjectCoverThumb projectId={entry.projectId} title={entry.title} size={56} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            {entry.featured ? (
                              <Star className="size-3.5 shrink-0 text-warning" aria-label="Featured" />
                            ) : null}
                            <h3 className="text-ink truncate text-sm font-semibold">{entry.title}</h3>
                          </div>
                          <p className="text-muted truncate text-2xs">
                            {entry.author ? entry.author : 'Author not set'}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            <Badge tone={statusMeta.tone} size="sm">
                              {statusMeta.label}
                            </Badge>
                            {entry.category ? (
                              <Badge tone="neutral" size="sm">
                                {entry.category}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                      </button>

                      {entry.tagline ? (
                        <p className="text-muted line-clamp-2 text-2xs italic">{entry.tagline}</p>
                      ) : entry.blurb ? (
                        <p className="text-subtle line-clamp-2 text-2xs">{entry.blurb}</p>
                      ) : (
                        <p className="text-subtle text-2xs italic">No blurb or tagline yet.</p>
                      )}

                      {entry.genre.length > 0 || entry.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {entry.genre.slice(0, 3).map((g) => (
                            <span key={`g-${g}`} className="bg-surface-muted text-subtle rounded px-1.5 py-0.5 text-2xs">
                              {g}
                            </span>
                          ))}
                          {entry.tags.slice(0, 3).map((t) => (
                            <span key={`t-${t}`} className="text-subtle text-2xs">
                              #{t}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      <div className="text-subtle flex items-center justify-between text-2xs">
                        <span>{entry.targetWordCount !== null ? formatWords(entry.targetWordCount) : 'No word target'}</span>
                        <span>Updated {formatRelative(entry.updatedAt)}</span>
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ------------------- Editor + preview ------------------- */}
        <section aria-label="Curate the selected work" className="space-y-4" data-testid="portfolio-editor">
          {!selectedEntry || !form ? (
            <Card padding="md">
              <p className="text-subtle text-xs">Select a work to curate its display.</p>
            </Card>
          ) : (
            <>
              {/* Display preview — exactly what a reader sees, with provenance. */}
              <Card padding="md" className="space-y-3" data-testid="portfolio-preview">
                <div className="flex items-center gap-1.5">
                  <Eye className="text-accent size-3.5" aria-hidden />
                  <p className="text-ink text-sm font-medium">Display preview</p>
                </div>
                <div className="bg-surface-muted/50 rounded-md border border-line p-3">
                  <div className="flex items-start gap-3">
                    <ProjectCoverThumb
                      projectId={selectedEntry.projectId}
                      title={form.displayTitle.trim() || selectedEntry.title}
                      size={72}
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-ink text-sm font-semibold" data-testid="preview-title">
                        {form.displayTitle.trim() || selectedEntry.title}
                      </h3>
                      <p className="text-muted text-2xs" data-testid="preview-author">
                        {form.penName.trim() || selectedEntry.author || 'Author not set'}
                      </p>
                      {form.category.trim() ? (
                        <Badge tone="neutral" size="sm" className="mt-1">
                          {form.category.trim()}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {form.tagline.trim() ? (
                    <p className="text-muted mt-2 text-2xs italic">{form.tagline.trim()}</p>
                  ) : null}
                  <p className="text-subtle mt-2 line-clamp-3 text-2xs" data-testid="preview-blurb">
                    {selectedEntry.blurb ?? 'No public blurb yet — add one in the Blurb Generator.'}
                  </p>
                </div>
                <p className="text-subtle flex items-start gap-1.5 text-2xs leading-relaxed">
                  <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                  Curated fields override the project only for the Portfolio. The project's summary and public
                  blurb are never changed here.
                </p>
              </Card>

              {/* Editor form. */}
              <Card padding="md" className="space-y-3" data-testid="portfolio-form">
                <p className="text-ink text-sm font-medium">Curate display</p>

                <label className="block space-y-1">
                  <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Display title</span>
                  <input
                    type="text"
                    value={form.displayTitle}
                    onChange={(e) => updateForm('displayTitle', e.target.value)}
                    placeholder={`Override (project: “${selectedEntry.title}”)`}
                    className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1.5 text-xs"
                    data-testid="portfolio-title-input"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Pen name</span>
                  <input
                    type="text"
                    value={form.penName}
                    onChange={(e) => updateForm('penName', e.target.value)}
                    placeholder={selectedEntry.author ? `Override (project: “${selectedEntry.author}”)` : 'Pen name (project: not set)'}
                    className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1.5 text-xs"
                    data-testid="portfolio-penname-input"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Tagline</span>
                  <input
                    type="text"
                    value={form.tagline}
                    onChange={(e) => updateForm('tagline', e.target.value)}
                    maxLength={280}
                    placeholder="A short catalog tagline (distinct from the blurb)"
                    className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1.5 text-xs"
                    data-testid="portfolio-tagline-input"
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1">
                    <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Category</span>
                    <input
                      type="text"
                      value={form.category}
                      onChange={(e) => updateForm('category', e.target.value)}
                      maxLength={60}
                      placeholder="e.g. Space Opera"
                      className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1.5 text-xs"
                      data-testid="portfolio-category-input"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Order</span>
                    <input
                      type="number"
                      min={0}
                      value={form.displayOrder}
                      onChange={(e) => updateForm('displayOrder', e.target.value)}
                      className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1.5 text-xs"
                      data-testid="portfolio-order-input"
                    />
                  </label>
                </div>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.featured}
                    onChange={(e) => updateForm('featured', e.target.checked)}
                    className="accent-accent size-3.5"
                    data-testid="portfolio-featured-input"
                  />
                  <span className="text-muted flex items-center gap-1 text-2xs">
                    <Pin className="size-3" aria-hidden />
                    Feature this work (pinned to the top of the catalog)
                  </span>
                </label>

                {/* Links. */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Links</span>
                    <button
                      type="button"
                      onClick={addLink}
                      className="text-accent flex items-center gap-1 text-2xs font-medium"
                      data-testid="portfolio-add-link"
                    >
                      <Link2 className="size-3" aria-hidden />
                      Add link
                    </button>
                  </div>
                  {form.links.length === 0 ? (
                    <p className="text-subtle text-2xs">No links. Add a store page or reviews URL.</p>
                  ) : (
                    form.links.map((link, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={link.label}
                          onChange={(e) => setLink(i, { label: e.target.value })}
                          placeholder="Label"
                          className="border-line bg-surface text-ink w-24 rounded-md border px-2 py-1 text-2xs"
                          data-testid={`portfolio-link-label-${i}`}
                        />
                        <input
                          type="url"
                          value={link.url}
                          onChange={(e) => setLink(i, { url: e.target.value })}
                          placeholder="https://…"
                          className="border-line bg-surface text-ink min-w-0 flex-1 rounded-md border px-2 py-1 text-2xs"
                          data-testid={`portfolio-link-url-${i}`}
                        />
                        <button
                          type="button"
                          onClick={() => removeLink(i)}
                          className="text-subtle hover:text-danger"
                          aria-label="Remove link"
                          data-testid={`portfolio-link-remove-${i}`}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {message ? (
                  <p className="text-success flex items-center gap-1.5 text-2xs" role="status" data-testid="portfolio-message">
                    <Check className="size-3.5 shrink-0" aria-hidden />
                    {message}
                  </p>
                ) : null}
                {actionError ? (
                  <p className="text-danger flex items-start gap-1.5 text-2xs" role="alert" data-testid="portfolio-error">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {actionError}
                  </p>
                ) : null}

                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    iconLeft={<Save className="size-3.5" />}
                    onClick={() => void handleSave()}
                    loading={saving}
                    disabled={saving}
                    data-testid="portfolio-save"
                  >
                    Save display
                  </Button>
                  {selectedEntry.hasProfile ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconLeft={<Trash2 className="size-3.5" />}
                      onClick={() => void handleReset()}
                      disabled={saving}
                      data-testid="portfolio-reset"
                    >
                      Reset to project
                    </Button>
                  ) : null}
                </div>
              </Card>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
