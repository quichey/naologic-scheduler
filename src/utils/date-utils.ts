import { DateTime, Interval } from 'luxon';
import type { WorkCenter } from '../reflow/types.js';

export class DateUtils {
  /**
   * Calculates the total "on-the-clock" minutes between two dates,
   * considering work center shifts and excluding maintenance windows.
   */
  public static calculateWorkingMinutes(
    startISO: string,
    endISO: string,
    center: WorkCenter,
  ): number {
    // FORCE UTC: Without this, local machine timezones can shift the startHour
    // and make an 8AM order look like a 4AM order (outside shift).
    const start = DateTime.fromISO(startISO, { zone: 'utc' });
    const end = DateTime.fromISO(endISO, { zone: 'utc' });

    if (!start.isValid || !end.isValid || start >= end) return 0;

    let totalMinutes = 0;
    const orderInterval = Interval.fromDateTimes(start, end);

    // 1. Walk through each day spanned by the start and end dates
    let currentDay = start.startOf('day');
    const lastDay = end.startOf('day');

    while (currentDay <= lastDay) {
      // Map Luxon (1=Mon, 7=Sun) to Problem Statement (0=Sun, 1=Mon)
      const dayOfWeek = currentDay.weekday % 7;

      const shifts = center.data.shifts.filter((s) => s.dayOfWeek === dayOfWeek);

      for (const shift of shifts) {
        // Ensure shift boundaries are also explicitly UTC
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

        // Calculate intersection between the Work Order time and this Shift
        const workInShift = orderInterval.intersection(shiftInterval);

        if (workInShift) {
          let minutesInShift = workInShift.length('minutes');

          // 2. Subtract any maintenance windows that occur DURING this shift overlap
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
      currentDay = currentDay.plus({ days: 1 });
    }

    // Use Math.round to handle floating point precision (e.g., 119.9999999)
    return Math.round(totalMinutes);
  }
}
