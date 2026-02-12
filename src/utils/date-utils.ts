import { DateTime, Interval } from 'luxon';
import type { WorkCenter } from '../reflow/types.js';

/**
 * DateUtils provides specialized temporal calculations for the manufacturing domain.
 * It handles shift-aware duration math, timezone normalization (UTC), and
 * interval intersections between production work and maintenance blackouts.
 */
export class DateUtils {
  /**
   * Validates if a specific time falls within any of the provided shifts for a work center.
   * * This method uses "Half-Open" interval logic to handle hand-offs:
   * - A shift from 08:00 to 17:00 contains 08:00:00 but NOT 17:00:00 for a START check.
   * - A shift from 08:00 to 17:00 contains 17:00:00 but NOT 08:00:00 for an END check.
   * * @param time - The DateTime to validate.
   * @param shifts - Array of shift definitions (dayOfWeek 0-6, startHour, endHour).
   * @param options.isEnd - If true, treats the time as a completion point (inclusive of shift end).
   * @returns boolean - True if the time is operationally valid.
   */
  public static isTimeInShift(
    time: DateTime,
    shifts: { dayOfWeek: number; startHour: number; endHour: number }[],
    options: { isEnd?: boolean } = {},
  ): boolean {
    const { isEnd = false } = options;
    // Map Luxon's ISO weekday (1-7) to the 0-6 format used in the dataset
    const dayOfWeek = time.weekday % 7;

    return shifts.some((s) => {
      if (s.dayOfWeek !== dayOfWeek) return false;

      // Normalize boundaries to the same day as the input time for comparison
      const shiftStart = time.set({ hour: s.startHour, minute: 0, second: 0, millisecond: 0 });
      const shiftEnd = time.set({ hour: s.endHour, minute: 0, second: 0, millisecond: 0 });

      if (isEnd) {
        // Completion logic: Work can finish exactly at the minute the shift ends.
        return time > shiftStart && time <= shiftEnd;
      } else {
        // Start logic: Work can begin exactly at the minute the shift starts.
        return time >= shiftStart && time < shiftEnd;
      }
    });
  }

  /**
   * Calculates the total "net working time" between two timestamps.
   * This is the critical "Stopwatch" logic that ignores non-working hours
   * and maintenance downtime.
   * * @param startISO - ISO 8601 start string.
   * @param endISO - ISO 8601 end string.
   * @param center - The WorkCenter context (contains shift and maintenance data).
   * @returns number - Total working minutes rounded to the nearest integer.
   */
  public static calculateWorkingMinutes(
    startISO: string,
    endISO: string,
    center: WorkCenter,
  ): number {
    /** * STRATEGIC NOTE: FORCE UTC
     * In a distributed manufacturing system, servers and clients may be in different zones.
     * We force UTC to ensure that "8 AM" in the data is interpreted as "8 AM" regardless
     * of the execution environment's local time.
     */
    const start = DateTime.fromISO(startISO, { zone: 'utc' });
    const end = DateTime.fromISO(endISO, { zone: 'utc' });

    if (!start.isValid || !end.isValid || start >= end) return 0;

    let totalMinutes = 0;
    const orderInterval = Interval.fromDateTimes(start, end);

    // 1. Iterative Day Walking
    // We process the time span day-by-day to handle multi-day orders correctly.
    let currentDay = start.startOf('day');
    const lastDay = end.startOf('day');

    while (currentDay <= lastDay) {
      const dayOfWeek = currentDay.weekday % 7;
      const shifts = center.data.shifts.filter((s) => s.dayOfWeek === dayOfWeek);

      for (const shift of shifts) {
        // Create an interval representing the operational hours for this specific day
        const shiftStart = currentDay.set({
          hour: shift.startHour,
          minute: 0,
          second: 0,
          millisecond: 0,
        });
        const shiftEnd = currentDay.set({
          hour: shift.endHour,
          minute: 0,
          second: 0,
          millisecond: 0,
        });

        const shiftInterval = Interval.fromDateTimes(shiftStart, shiftEnd);

        // 2. Intersection logic: find the portion of the Work Order that overlaps with this shift
        const workInShift = orderInterval.intersection(shiftInterval);

        if (workInShift) {
          let minutesInShift = workInShift.length('minutes');

          /**
           * 3. Maintenance Subtraction
           * Even if we are inside a shift, a maintenance window might block the resource.
           * We find the intersection of our active work-slice and any maintenance windows.
           */
          for (const mw of center.data.maintenanceWindows) {
            const mwInterval = Interval.fromDateTimes(
              DateTime.fromISO(mw.startDate, { zone: 'utc' }),
              DateTime.fromISO(mw.endDate, { zone: 'utc' }),
            );

            const maintenanceOverlap = workInShift.intersection(mwInterval);
            if (maintenanceOverlap) {
              minutesInShift -= maintenanceOverlap.length('minutes');
            }
          }

          totalMinutes += Math.max(0, minutesInShift);
        }
      }
      // Move to the next calendar day
      currentDay = currentDay.plus({ days: 1 });
    }

    /**
     * Precision Handling:
     * Using Luxon intervals can occasionally result in floating point noise (e.g. 119.999).
     * We round to the nearest minute to align with the discrete nature of the source data.
     */
    return Math.round(totalMinutes);
  }
}
