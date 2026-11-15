/**
 * Project cover thumbnail (P9 Batch D).
 *
 * A small, self-contained badge that shows a project's CURRENT cover in list
 * surfaces (Dashboard, future cards). It resolves through the shared
 * `coverService` (the single source of cover truth) rather than reading the DB,
 * and falls back to the project's initials when there is no cover, the cover is
 * external-and-broken, or the referenced asset is missing on this device (e.g.
 * after an import — covers are device-local).
 *
 * It creates at most ONE object URL per thumbnail and revokes it on unmount, so
 * rendering a list of projects cannot leak blobs.
 */

import { useEffect, useRef, useState } from 'react';
import { coverService } from '@/services';
import { projectInitials } from '@/modules/projects/project-meta';

export interface ProjectCoverThumbProps {
  projectId: string;
  /** The project title (for initials fallback + alt text). */
  title: string;
  /** Square edge length in pixels (default 32). */
  size?: number;
  className?: string;
}

export function ProjectCoverThumb({ projectId, title, size = 32, className }: ProjectCoverThumbProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let createdUrl: string | null = null;
    setFailed(false);
    setUrl(null);

    void (async () => {
      try {
        // Only asset rings resolve to a displayable URL; external/none are
        // handled by the fallback branch below.
        const current = await coverService.getCurrentCover(projectId);
        if (!mountedRef.current) {
          // Unmounted mid-flight: revoke anything we just created.
          if (current.displayUrl && typeof URL !== 'undefined') URL.revokeObjectURL(current.displayUrl);
          return;
        }
        if (current.resolution.kind === 'asset' && current.displayUrl) {
          createdUrl = current.displayUrl;
          setUrl(current.displayUrl);
        }
      } catch {
        if (mountedRef.current) setFailed(true);
      }
    })();

    return () => {
      mountedRef.current = false;
      if (createdUrl && typeof URL !== 'undefined') URL.revokeObjectURL(createdUrl);
    };
  }, [projectId]);

  const dimension = { width: size, height: size } as const;

  if (url && !failed) {
    return (
      <img
        src={url}
        alt={`Cover of ${title}`}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-md border border-line object-cover ${className ?? ''}`}
        style={dimension}
        data-testid="project-cover-thumb"
      />
    );
  }

  // Placeholder: initials on the accent swatch, matching the existing row style.
  return (
    <span
      aria-hidden
      className={`bg-accent-soft text-accent-soft-text grid shrink-0 place-items-center rounded-md text-2xs font-semibold ${className ?? ''}`}
      style={dimension}
      data-testid="project-cover-thumb-placeholder"
    >
      {projectInitials(title)}
    </span>
  );
}
