import { startOfDay, startOfMonth, subMonths } from 'date-fns';
import type { MonthRange } from './splitRangeByMonth';
import type { BatchStatus, ClearCounts } from './useBatchedClear';

export const OLDER_THAN_MONTHS = [3, 6, 12, 24] as const;
export const DEFAULT_OLDER_THAN_MONTHS = 6;

export type CountKey = keyof ClearCounts;

const COUNT_KEYS: CountKey[] = ['events', 'eventData', 'sessions', 'revenue', 'replays'];

export function getOlderThanCutoff(months: number, now: Date): Date {
  return startOfDay(subMonths(now, months));
}

// Everything recorded before the cutoff, from the month of the first recorded data.
// Undefined when there is nothing that old.
export function getOlderThanRange(
  months: number,
  firstDataDate: Date | null | undefined,
  now: Date,
): MonthRange | undefined {
  if (!firstDataDate) {
    return undefined;
  }

  const startAt = startOfMonth(firstDataDate).getTime();
  const endAt = getOlderThanCutoff(months, now).getTime();

  return startAt < endAt ? { startAt, endAt } : undefined;
}

export function getCountItems(counts: ClearCounts): { key: CountKey; value: number }[] {
  return COUNT_KEYS.filter(key => counts[key] > 0).map(key => ({ key, value: counts[key] }));
}

export function isEmptyCounts(counts: ClearCounts): boolean {
  return getCountItems(counts).length === 0;
}

// Ranges are half-open, so the last day shown is the one holding endAt - 1 ms.
export function getDisplayDates(range: MonthRange): { startDate: Date; endDate: Date } {
  return { startDate: new Date(range.startAt), endDate: new Date(range.endAt - 1) };
}

export function getProgressPercent(completed: number, total: number): number {
  return total > 0 ? (completed / total) * 100 : 0;
}

export interface RunView {
  kind: 'progress' | 'error' | 'stopped' | 'done';
  canStop: boolean;
  isStopping: boolean;
  canRetry: boolean;
  canClose: boolean;
}

export function getRunView(status: BatchStatus): RunView {
  const view: RunView = {
    kind: 'progress',
    canStop: false,
    isStopping: false,
    canRetry: false,
    canClose: false,
  };

  switch (status) {
    case 'running':
      return { ...view, canStop: true };
    case 'stopping':
      return { ...view, canStop: true, isStopping: true };
    case 'error':
      return { ...view, kind: 'error', canRetry: true, canClose: true };
    case 'stopped':
    case 'done':
      return { ...view, kind: status, canClose: true };
    default:
      return view;
  }
}

export interface Period {
  from: Date;
  to: Date;
}

// Sets one end of the period and drags the other along so that from <= to.
export function updatePeriod(period: Period, field: keyof Period, date: Date): Period {
  if (field === 'from') {
    return { from: date, to: date > period.to ? date : period.to };
  }

  return { from: date < period.from ? date : period.from, to: date };
}
