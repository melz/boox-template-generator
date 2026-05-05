/**
 * Pure utilities for analysing which compilation-time variables a project's
 * masters reference and which the plan provides. Shared between PlanEditor
 * (whole-plan view) and MasterEditor (per-master banner).
 *
 * Note: kept in sync with the backend's auto-generated variable set in
 * src/einkpdf/services/compilation_service.py (PlanEnumerator._build_context).
 * If you add an auto var on the backend, mirror it here.
 */

import type { Plan, PlanSection, Project, ProjectMaster } from '@/types';

// Variables auto-provided by the compiler for date-based sections plus the
// generic page/index vars. Includes the auto-navigation _prev/_next forms.
const AUTO_VARIABLES: ReadonlySet<string> = new Set([
  // Section name + page metadata
  'section_name', 'total_pages', 'page', 'page_num',
  // Date components
  'date', 'date_long', 'date_prev', 'date_next',
  'year', 'year_prev', 'year_next',
  'month', 'month_padded', 'month_padded3', 'month_name', 'month_short',
  'month_prev', 'month_next',
  'weekday', 'weekday_short', 'weekday_full',
  'day', 'day_padded',
  'week', 'week_padded', 'week_prev', 'week_next',
  'iso_week',
  // Index for COUNT/each-N modes
  'index', 'index_padded',
  // Locale used for month/weekday names
  'locale',
]);

// Variables only meaningful inside specific composite widgets.
const WIDGET_LOCAL_VARIABLES: ReadonlySet<string> = new Set([
  'row',   // table widget
  'col',   // table widget
  'value', // table widget cell content
]);

export interface VariableStatus {
  /** Auto-generated variables (always available). */
  autoVariables: string[];
  /** Variables only meaningful inside specific widgets. */
  widgetLocalVariables: string[];
  /** User-defined names — counters + context — across all sections. */
  definedVariables: string[];
  /** Names of masters that reference at least one variable, with their lists. */
  mastersWithVariables: Array<{ name: string; variables: string[] }>;
  /** Variables referenced in masters that aren't provided by anything. */
  missingVariables: string[];
  /** Predicate for ad-hoc checks. */
  isVariableProvided: (name: string) => boolean;
}

const collectDefinedFromSections = (sections: PlanSection[], out: Set<string>): void => {
  sections.forEach((section) => {
    if (section.context) {
      Object.keys(section.context).forEach((k) => out.add(k));
    }
    if (section.counters) {
      Object.keys(section.counters).forEach((k) => {
        out.add(k);
        // Counters auto-expose _prev/_next; include them so masters using these
        // forms aren't flagged as missing.
        out.add(`${k}_prev`);
        out.add(`${k}_next`);
      });
    }
    if (section.nested) {
      collectDefinedFromSections(section.nested, out);
    }
  });
};

export function analyzeVariableStatus(masters: ProjectMaster[], plan: Plan): VariableStatus {
  const mastersWithVariables = masters
    .filter((m) => m.used_variables && m.used_variables.length > 0)
    .map((m) => ({ name: m.name, variables: m.used_variables || [] }));

  const allUsed = new Set<string>();
  mastersWithVariables.forEach((m) => m.variables.forEach((v) => allUsed.add(v)));

  const defined = new Set<string>();
  collectDefinedFromSections(plan.sections, defined);

  const missing = Array.from(allUsed)
    .filter((v) => !AUTO_VARIABLES.has(v) && !WIDGET_LOCAL_VARIABLES.has(v) && !defined.has(v))
    .sort();

  return {
    autoVariables: Array.from(AUTO_VARIABLES).sort(),
    widgetLocalVariables: Array.from(WIDGET_LOCAL_VARIABLES).sort(),
    definedVariables: Array.from(defined).sort(),
    mastersWithVariables,
    missingVariables: missing,
    isVariableProvided: (name: string) =>
      AUTO_VARIABLES.has(name) || WIDGET_LOCAL_VARIABLES.has(name) || defined.has(name),
  };
}

/** Variables the plan provides specifically (not auto/widget-local). */
export function planDefinedVariables(plan: Plan): string[] {
  const out = new Set<string>();
  collectDefinedFromSections(plan.sections, out);
  return Array.from(out).sort();
}

/** Compute variables a single master uses that the plan won't satisfy. */
export function missingForMaster(master: ProjectMaster, plan: Plan): string[] {
  const used = master.used_variables || [];
  if (used.length === 0) return [];
  const defined = new Set<string>();
  collectDefinedFromSections(plan.sections, defined);
  return used
    .filter((v) => !AUTO_VARIABLES.has(v) && !WIDGET_LOCAL_VARIABLES.has(v) && !defined.has(v))
    .sort();
}

/** Whether the master is referenced by at least one section in the plan. */
export function isMasterUsedByPlan(masterName: string, plan: Plan): boolean {
  const visit = (sections: PlanSection[]): boolean => {
    for (const s of sections) {
      if (s.master === masterName) return true;
      if (s.nested && visit(s.nested)) return true;
    }
    return false;
  };
  return visit(plan.sections);
}

export function projectFromShape(project: Project): { masters: ProjectMaster[]; plan: Plan } {
  return { masters: project.masters, plan: project.plan };
}
