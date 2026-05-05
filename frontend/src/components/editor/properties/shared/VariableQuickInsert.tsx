/**
 * Inline button row for inserting common compilation-time variables into a
 * textarea/input at the cursor position. Lighter than the full BindingHelper
 * autocomplete — meant to live next to a multi-line textarea where the user
 * is writing widget content.
 */

import React from 'react';

const COMMON_VARS: Array<{ token: string; label: string; example: string }> = [
  { token: '{date}', label: 'date', example: '2026-01-15' },
  { token: '{date_long}', label: 'date_long', example: 'Wednesday, January 15, 2026' },
  { token: '{weekday}', label: 'weekday', example: 'Wednesday' },
  { token: '{month_name}', label: 'month_name', example: 'January' },
  { token: '{year}', label: 'year', example: '2026' },
  { token: '{month:02d}', label: 'month', example: '01' },
  { token: '{day:02d}', label: 'day', example: '15' },
  { token: '{week}', label: 'week', example: '3' },
  { token: '{index}', label: 'index', example: '1' },
  { token: '{index:03d}', label: 'index padded', example: '001' },
];

interface VariableQuickInsertProps {
  inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement>;
  currentValue: string;
  onChange: (value: string) => void;
  /** Optional set of additional plan-defined variables (counters/context) to surface. */
  extraVars?: string[];
}

const VariableQuickInsert: React.FC<VariableQuickInsertProps> = ({
  inputRef,
  currentValue,
  onChange,
  extraVars,
}) => {
  const insertAtCursor = (token: string) => {
    const el = inputRef.current;
    if (!el) {
      onChange(currentValue + token);
      return;
    }
    const start = el.selectionStart ?? currentValue.length;
    const end = el.selectionEnd ?? currentValue.length;
    const next = currentValue.slice(0, start) + token + currentValue.slice(end);
    onChange(next);
    // Restore focus + place cursor after the inserted token. Defer until after
    // React has reconciled the value change.
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + token.length;
      try {
        el.setSelectionRange(cursor, cursor);
      } catch {
        // Some inputs (e.g. number) don't support setSelectionRange; ignore.
      }
    });
  };

  const renderButton = (token: string, label: string, title: string) => (
    <button
      key={token}
      type="button"
      onClick={() => insertAtCursor(token)}
      title={title}
      className="text-xs px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 rounded font-mono text-gray-700"
    >
      {label}
    </button>
  );

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <span className="text-xs text-gray-500 mr-1">Insert:</span>
      {COMMON_VARS.map((v) =>
        renderButton(v.token, v.label, `${v.token} → ${v.example}`)
      )}
      {extraVars && extraVars.length > 0 && (
        <>
          <span className="text-xs text-gray-400 mx-1">|</span>
          <span className="text-xs text-gray-500">plan:</span>
          {extraVars.map((name) =>
            renderButton(`{${name}}`, name, `{${name}} (defined in this plan)`)
          )}
        </>
      )}
    </div>
  );
};

export default VariableQuickInsert;
