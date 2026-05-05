/**
 * Token replacement utilities for frontend preview.
 *
 * Two related concerns:
 *
 * 1. `replaceTokensForPreview` — used by widget components and TableWidget to
 *    show plausible content in the editor canvas while the user designs
 *    masters. The substituted values are static samples (always the same
 *    Wed Jan 15 2025) so the canvas doesn't shift around as the clock moves.
 *
 * 2. The substitution understands `{var}` and `{var:format}` patterns and
 *    leaves any token whose name isn't in the sample context as the literal
 *    `{var}`. That way the author can see at a glance which references the
 *    compiler won't be able to resolve either.
 *
 * Keep the sample variable list in sync with the auto-generated vars produced
 * by the backend in compilation_service.py (PlanEnumerator._build_context).
 */

export interface PreviewContext {
  page?: number;
  total_pages?: number;
  date?: string;
  date_long?: string;
  date_prev?: string;
  date_next?: string;
  year?: number;
  year_prev?: number;
  year_next?: number;
  month?: number;
  month_padded?: string;
  month_name?: string;
  month_short?: string;
  month_abbr?: string; // alias kept for older callers
  month_prev?: number;
  month_next?: number;
  day?: number;
  day_padded?: string;
  weekday?: string;
  weekday_short?: string;
  weekday_full?: string;
  week?: number;
  week_padded?: string;
  week_prev?: number;
  week_next?: number;
  iso_week?: string;
  index?: number;
  index_padded?: string;
  section_name?: string;
  locale?: string;
  [key: string]: any;
}

/** Stable sample context; date matches Wed Jan 15 2025 (which IS a Wednesday). */
export const SAMPLE_PREVIEW_CONTEXT: PreviewContext = {
  page: 1,
  total_pages: 10,
  date: '2025-01-15',
  date_long: 'Wednesday, January 15, 2025',
  date_prev: '2025-01-14',
  date_next: '2025-01-16',
  year: 2025,
  year_prev: 2024,
  year_next: 2026,
  month: 1,
  month_padded: '01',
  month_name: 'January',
  month_short: 'Jan',
  month_abbr: 'Jan',
  month_prev: 12,
  month_next: 2,
  day: 15,
  day_padded: '15',
  weekday: 'Wednesday',
  weekday_short: 'Wed',
  weekday_full: 'Wednesday',
  week: 3,
  week_padded: '03',
  week_prev: 2,
  week_next: 4,
  iso_week: '2025-W03',
  index: 1,
  index_padded: '001',
  section_name: 'sample',
  locale: 'en',
};

const TOKEN_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)(?::([^{}]+))?\}/g;

/**
 * Apply a Python-style format specifier to a value.
 * Supports the subset our backend emits: integer width/padding (`02d`, `03d`),
 * float precision (`.2f`), and bare strings.
 */
const formatValue = (value: unknown, spec: string | undefined): string => {
  if (value === undefined || value === null) return '';
  if (!spec) return String(value);

  // Integer formats: e.g. "02d", "3d"
  const intMatch = spec.match(/^0?(\d+)d$/);
  if (intMatch) {
    const width = parseInt(intMatch[1], 10);
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    const padded = String(Math.trunc(num));
    return spec.startsWith('0')
      ? padded.padStart(width, '0')
      : padded.padStart(width, ' ');
  }

  // Float formats: e.g. ".2f"
  const floatMatch = spec.match(/^\.(\d+)f$/);
  if (floatMatch) {
    const decimals = parseInt(floatMatch[1], 10);
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    return num.toFixed(decimals);
  }

  // Unknown spec: fall back to the raw value
  return String(value);
};

/**
 * Replace `{var}` and `{var:format}` tokens in `text` using `context`. Unknown
 * tokens are left as their original `{var}` literal so the author can spot
 * what won't resolve. If you want to swallow unknowns instead, pre-fill the
 * context with empty strings for those keys.
 */
export const replaceTokensForPreview = (
  text: string,
  context?: Partial<PreviewContext>
): string => {
  if (text === undefined || text === null) return '';
  if (typeof text !== 'string') return String(text);

  const merged: Record<string, any> = { ...SAMPLE_PREVIEW_CONTEXT, ...(context || {}) };

  return text.replace(TOKEN_PATTERN, (match, name: string, spec: string | undefined) => {
    if (!Object.prototype.hasOwnProperty.call(merged, name)) {
      return match; // unknown — preserve literal
    }
    const value = merged[name];
    if (value === undefined || value === null) return match;
    return formatValue(value, spec);
  });
};

/**
 * Recursively replace tokens inside arbitrary data (used by TableWidget for
 * cell text). Strings get substituted; other values pass through unchanged.
 */
export const replaceTokensInData = (data: any, context?: Partial<PreviewContext>): any => {
  if (typeof data === 'string') {
    return replaceTokensForPreview(data, context);
  }

  if (Array.isArray(data)) {
    return data.map((item) => replaceTokensInData(item, context));
  }

  if (data && typeof data === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = replaceTokensInData(value, context);
    }
    return result;
  }

  return data;
};

/** Helper for callers that want to spread the sample context with overrides. */
export const getSamplePreviewContext = (overrides?: Partial<PreviewContext>): PreviewContext => ({
  ...SAMPLE_PREVIEW_CONTEXT,
  ...(overrides || {}),
});
