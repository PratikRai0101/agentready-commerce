"use client";

/**
 * AI-4 loading, error, and empty states.
 * Prevents duplicate sends and provides clear recovery actions.
 */

type Props = {
  busy: boolean;
  error?: string | null;
  onRetry?: () => void;
};

export function LoadingIndicator({ busy, error, onRetry }: Props) {
  if (error) {
    return (
      <div className="loading-error" role="alert">
        <span className="loading-error-text">{error}</span>
        {onRetry && (
          <button type="button" className="loading-retry" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  if (busy) {
    return (
      <div className="loading-indicator" role="status" aria-live="polite">
        <span className="loading-dots" aria-hidden="true">
          <span className="dot" /><span className="dot" /><span className="dot" />
        </span>
        <span className="loading-text">Thinking\u2026</span>
      </div>
    );
  }
  return null;
}
