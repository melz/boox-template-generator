/**
 * Track the PDF generation job lifecycle for a single project.
 *
 * Encapsulates: localStorage persistence (so an in-progress job survives a
 * page reload), restoration on mount, mutation of the job state when the
 * `<PDFJobStatusComponent>` reports progress callbacks, and the boolean
 * `pdfExists` state that the editor uses to gate "open / download" buttons.
 *
 * Extracted from `ProjectEditor.tsx` — kept generic enough that any project-
 * scoped editor can use it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { APIClient } from '@/services/api';
import type { PDFJob } from '@/types';

const ACTIVE_KEY_PREFIX = 'einkpdf:pdfjob:active:';
const COMPLETED_KEY_PREFIX = 'einkpdf:pdfjob:completed:';

const storageAvailable = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const readValue = (key: string | null): string | null => {
  if (!key || !storageAvailable) return null;
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    console.warn('Failed to read PDF job state', err);
    return null;
  }
};

const persistValue = (key: string | null, value: string | null) => {
  if (!key || !storageAvailable) return;
  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch (err) {
    console.warn('Failed to persist PDF job state', err);
  }
};

const is404 = (err: any): boolean =>
  err?.status === 404 ||
  err?.response?.status === 404 ||
  err?.message?.includes?.('404') ||
  err?.message?.includes?.('Not Found');

export interface UsePDFJobLifecycleResult {
  /** True while an async createPDFJob call is in flight. */
  creatingPDF: boolean;
  /** True while a server-side job is pending or processing. */
  jobInProgress: boolean;
  /** ID of the job currently shown in the UI, or null if none. */
  currentPDFJobId: string | null;
  /** True if a compiled PDF currently exists on the server for this project. */
  pdfExists: boolean;
  /** Submit a new PDF generation job. Throws on API failure. */
  startJob: () => Promise<void>;
  /** PDFJobStatusComponent onComplete callback. */
  handleJobCompleted: (job: PDFJob) => void;
  /** PDFJobStatusComponent onError callback. */
  handleJobErrored: () => void;
  /** PDFJobStatusComponent onCancel callback. */
  handleJobCancelled: () => void;
  /** Mark the PDF as missing (e.g. after a 404 on download). */
  markPdfMissing: () => void;
  /** Re-check the server for whether a PDF exists. */
  refreshPDFExistence: () => Promise<boolean>;
}

export function usePDFJobLifecycle(projectId: string | undefined): UsePDFJobLifecycleResult {
  const [creatingPDF, setCreatingPDF] = useState(false);
  const [jobInProgress, setJobInProgress] = useState(false);
  const [currentPDFJobId, setCurrentPDFJobId] = useState<string | null>(null);
  const [pdfExists, setPdfExists] = useState(false);

  // Storage keys are derived per-projectId so multiple tabs viewing different
  // projects don't trample each other's job state.
  const activeKey = projectId ? `${ACTIVE_KEY_PREFIX}${projectId}` : null;
  const completedKey = projectId ? `${COMPLETED_KEY_PREFIX}${projectId}` : null;

  // Stash latest keys in refs so callbacks can read them without re-running effects.
  const activeKeyRef = useRef(activeKey);
  const completedKeyRef = useRef(completedKey);
  activeKeyRef.current = activeKey;
  completedKeyRef.current = completedKey;

  const persistActiveJob = useCallback((jobId: string | null) => {
    persistValue(activeKeyRef.current, jobId);
  }, []);

  const persistCompletedJob = useCallback((jobId: string | null) => {
    persistValue(completedKeyRef.current, jobId);
  }, []);

  const refreshPDFExistence = useCallback(async (): Promise<boolean> => {
    if (!projectId) {
      setPdfExists(false);
      return false;
    }
    try {
      const exists = await APIClient.hasCompiledPDF(projectId);
      setPdfExists(exists);
      return exists;
    } catch (err) {
      console.warn('hasCompiledPDF check failed:', err);
      return false;
    }
  }, [projectId]);

  // Restore an in-flight or recently-completed job from storage on mount.
  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;

    const restoreActiveJobFromStorage = async (): Promise<boolean> => {
      const storedJobId = readValue(activeKeyRef.current);
      if (!storedJobId) return false;

      try {
        const job = await APIClient.getPDFJob(storedJobId);
        if (cancelled) return false;
        if (job.project_id && job.project_id !== projectId) {
          persistActiveJob(null);
          return false;
        }
        if (job.status === 'pending' || job.status === 'processing') {
          setCurrentPDFJobId(job.id);
          setJobInProgress(true);
          return true;
        }
        if (job.status === 'completed') {
          setCurrentPDFJobId(job.id);
          setJobInProgress(false);
          persistActiveJob(null);
          persistCompletedJob(job.id);
          return true;
        }
        // Failed/cancelled — clear it.
        persistActiveJob(null);
      } catch (err: any) {
        // Stale job from a previous session. Either way, drop it from
        // localStorage so we don't keep retrying on every reload.
        if (!is404(err)) {
          console.warn('Failed to restore active PDF job (clearing stale localStorage):', err);
        } else {
          console.warn('Active PDF job not found (404), clearing storage:', storedJobId);
        }
        persistActiveJob(null);
      }
      return false;
    };

    const restoreCompletedJobFromStorage = async (): Promise<boolean> => {
      const storedJobId = readValue(completedKeyRef.current);
      if (!storedJobId) return false;

      try {
        const job = await APIClient.getPDFJob(storedJobId);
        if (cancelled) return false;
        if (job.project_id && job.project_id !== projectId) {
          persistCompletedJob(null);
          return false;
        }
        if (job.status === 'completed') {
          setCurrentPDFJobId(job.id);
          setJobInProgress(false);
          return true;
        }
        if (job.status === 'pending' || job.status === 'processing') {
          // Status flipped back to in-flight (rare).
          persistCompletedJob(null);
          persistActiveJob(job.id);
          setCurrentPDFJobId(job.id);
          setJobInProgress(true);
          return true;
        }
        persistCompletedJob(null);
      } catch (err: any) {
        if (!is404(err)) {
          console.warn('Failed to restore completed PDF job (clearing stale localStorage):', err);
        } else {
          console.warn('Completed PDF job not found (404), clearing storage:', storedJobId);
        }
        persistCompletedJob(null);
      }
      return false;
    };

    const checkForCompletedPDFJobs = async () => {
      try {
        const response = await APIClient.listPDFJobs(undefined, 50, 0);
        if (cancelled) return;

        const mostRecentJob = response.jobs.find(job => job.project_id === projectId);
        if (!mostRecentJob) {
          setCurrentPDFJobId(null);
          setJobInProgress(false);
          persistActiveJob(null);
          persistCompletedJob(null);
          return;
        }

        setCurrentPDFJobId(mostRecentJob.id);
        if (mostRecentJob.status === 'pending' || mostRecentJob.status === 'processing') {
          setJobInProgress(true);
          persistActiveJob(mostRecentJob.id);
          persistCompletedJob(null);
        } else if (mostRecentJob.status === 'completed') {
          setJobInProgress(false);
          persistActiveJob(null);
          persistCompletedJob(mostRecentJob.id);
        } else {
          setJobInProgress(false);
          persistActiveJob(null);
          persistCompletedJob(null);
        }
      } catch (err) {
        // Non-fatal — leave UI in its current state.
        console.error('Failed to check for PDF jobs:', err);
      }
    };

    const initializeJobs = async () => {
      const hasActive = await restoreActiveJobFromStorage();
      if (hasActive || cancelled) return;

      const hasCompleted = await restoreCompletedJobFromStorage();
      if (cancelled || hasCompleted) return;

      await checkForCompletedPDFJobs();
    };

    initializeJobs();

    // Also reflect actual on-server PDF existence into pdfExists.
    refreshPDFExistence();

    return () => {
      cancelled = true;
    };
    // persistActiveJob/persistCompletedJob are stable (refs); refreshPDFExistence
    // is memoized on projectId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const startJob = useCallback(async () => {
    if (!projectId) {
      throw new Error('Cannot start a PDF job without a projectId');
    }
    setCreatingPDF(true);
    setJobInProgress(true);
    // Force PDFJobStatusComponent to remount with the new id.
    setCurrentPDFJobId(null);
    persistCompletedJob(null);

    try {
      const job = await APIClient.createPDFJob({
        project_id: projectId,
        deterministic: false,
        strict_mode: false,
      });
      setCurrentPDFJobId(job.id);
      persistActiveJob(job.id);
    } catch (err) {
      persistActiveJob(null);
      setJobInProgress(false);
      setCurrentPDFJobId(null);
      throw err;
    } finally {
      setCreatingPDF(false);
    }
  }, [projectId, persistActiveJob, persistCompletedJob]);

  const handleJobCompleted = useCallback((job: PDFJob) => {
    setCurrentPDFJobId(job.id);
    setJobInProgress(false);
    setPdfExists(true);
    persistActiveJob(null);
    persistCompletedJob(job.id);
  }, [persistActiveJob, persistCompletedJob]);

  const handleJobErrored = useCallback(() => {
    setJobInProgress(false);
    persistActiveJob(null);
    persistCompletedJob(null);
  }, [persistActiveJob, persistCompletedJob]);

  const handleJobCancelled = useCallback(() => {
    setJobInProgress(false);
    persistActiveJob(null);
    persistCompletedJob(null);
  }, [persistActiveJob, persistCompletedJob]);

  const markPdfMissing = useCallback(() => {
    setPdfExists(false);
    persistCompletedJob(null);
    setCurrentPDFJobId(null);
  }, [persistCompletedJob]);

  return {
    creatingPDF,
    jobInProgress,
    currentPDFJobId,
    pdfExists,
    startJob,
    handleJobCompleted,
    handleJobErrored,
    handleJobCancelled,
    markPdfMissing,
    refreshPDFExistence,
  };
}
