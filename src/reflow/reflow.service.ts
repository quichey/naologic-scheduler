import type { WorkOrder, WorkCenter, ManufacturingOrder } from './types.js';
import type { Violation } from './constraint-checker.js';
import { ConstraintChecker } from './constraint-checker.js';

import { DateTime } from 'luxon';
import { DateUtils } from '../utils/date-utils.js';

export interface ReflowedSchedule {
  updatedWorkOrders: WorkOrder[];
  changes: string[];
  explanation: string[];
}

export class ReflowService {
  public static reflow(orders: WorkOrder[], centers: WorkCenter[]): ReflowedSchedule {
    let violations = ConstraintChecker.verify(orders, centers);
    // If there are no violations, just return orders
    if (violations.length == 0) {
      return { updatedWorkOrders: orders, changes: [], explanation: [] };
    }
    // If there are any fatal violations, error out
    if (violations.find((v) => v.isFatal)) {
      throw Error('NOT FIXABLE');
    }
    // Do schedule changes
    return this.reschedule(orders, centers);
  }
  private static reschedule(orders: WorkOrder[], centers: WorkCenter[]): ReflowedSchedule {
    let currentOrders = JSON.parse(JSON.stringify(orders));
    let changes: string[] = [];
    let explanation: string[] = [];
    const rootCauses = new Map<string, string>();

    // We process center by center
    for (const center of centers) {
      const centerOrders = currentOrders.filter(
        (o: WorkOrder) => o.data.workCenterId === center.docId,
      );

      const updatedCenterOrders = this.rescheduleByCenter(
        centerOrders,
        center,
        currentOrders,
        rootCauses,
        changes,
        explanation,
      );

      // Update the main list with the moved orders
      updatedCenterOrders.forEach((updated) => {
        const idx = currentOrders.findIndex((o: WorkOrder) => o.docId === updated.docId);
        currentOrders[idx] = updated;
      });
    }

    return { updatedWorkOrders: currentOrders, changes, explanation };
  }
  /*
  Assume orders all have the same work center
  */
  private static rescheduleByCenter(
    orders: WorkOrder[],
    center: WorkCenter,
    allOrders: WorkOrder[], // Needed to check cross-center parent endDates
    rootCauses: Map<string, string>,
    changes: string[],
    explanation: string[],
  ): WorkOrder[] {
    // Sort chronologically
    let sorted = [...orders].sort(
      (a, b) =>
        DateTime.fromISO(a.data.startDate).toMillis() -
        DateTime.fromISO(b.data.startDate).toMillis(),
    );

    for (let i = 0; i < sorted.length; i++) {
      let order = sorted[i];

      // 1. Dependency Check (Cross-Center)
      // If parent is on another machine, we must start AFTER it.
      for (const depId of order.data.dependsOnWorkOrderIds) {
        const parent = allOrders.find((o) => o.docId === depId);
        if (parent) {
          const parentEnd = DateTime.fromISO(parent.data.endDate, { zone: 'utc' });
          const currentStart = DateTime.fromISO(order.data.startDate, { zone: 'utc' });

          if (currentStart < parentEnd) {
            const oldStart = order.data.startDate;
            order.data.startDate = parentEnd.toISO()!;
            const endDt = this.findEndDate(parentEnd, order.data.durationMinutes, center);
            order.data.endDate = endDt.toISO()!;

            rootCauses.set(order.docId, parent.data.workOrderNumber);
            changes.push(
              `[${center.docId}] Moved ${order.data.workOrderNumber} to start after parent ${parent.data.workOrderNumber}`,
            );
            explanation.push(
              `Reflowed ${order.data.workOrderNumber} due to dependency on ${parent.data.workOrderNumber}`,
            );
          }
        }
      }

      // 2. Local Constraints Check (Shifts, Overlaps, Maintenance)
      let violations = ConstraintChecker.verify(allOrders, [center]).filter(
        (v) => v.orderId === order.docId,
      );

      while (violations.length > 0) {
        const v = violations[0];
        const blockerIdMatch = v.message.match(/busy with ([\w-]+) until/);
        const blockerId = blockerIdMatch ? blockerIdMatch[1] : null;

        const trigger = blockerId || v.type;
        const originalCause = rootCauses.get(trigger) || trigger;
        rootCauses.set(order.docId, originalCause);

        const oldStart = order.data.startDate;
        // Jump logic: If it's an overlap, jump to end of blocker. Otherwise nudge.
        let nextStart: DateTime;
        if (blockerId) {
          const blocker = allOrders.find((o) => o.docId === blockerId);
          nextStart = DateTime.fromISO(blocker!.data.endDate, { zone: 'utc' });
        } else {
          nextStart = DateTime.fromISO(oldStart, { zone: 'utc' }).plus({ minutes: 15 });
        }

        order.data.startDate = nextStart.toISO()!;
        const endDtFromViolation = this.findEndDate(nextStart, order.data.durationMinutes, center);
        order.data.endDate = endDtFromViolation.toISO()!;

        changes.push(
          `[${center.docId}] Moved ${order.data.workOrderNumber} from ${oldStart} to ${order.data.startDate}`,
        );
        explanation.push(
          `Reflowed ${order.data.workOrderNumber} because of a cascade started by ${originalCause}`,
        );

        // Re-verify specific to this order
        violations = ConstraintChecker.verify(allOrders, [center]).filter(
          (v) => v.orderId === order.docId,
        );
      }
    }
    return sorted;
  }
  private static findEndDate(start: DateTime, duration: number, center: WorkCenter): DateTime {
    let remainingMins = duration;
    let current = start;

    // Walk through the calendar until all minutes are "spent"
    while (remainingMins > 0) {
      const dayOfWeek = current.weekday % 7; // Sunday = 0
      const shift = center.data.shifts.find((s) => s.dayOfWeek === dayOfWeek);

      if (shift) {
        const shiftEnd = current.set({ hour: shift.endHour, minute: 0, second: 0, millisecond: 0 });
        const minutesAvailableToday = shiftEnd.diff(current, 'minutes').minutes;

        if (minutesAvailableToday > 0) {
          if (remainingMins <= minutesAvailableToday) {
            // Finished during this shift!
            return current.plus({ minutes: remainingMins });
          } else {
            // Use up the rest of today and move to tomorrow's shift start
            remainingMins -= minutesAvailableToday;
          }
        }
      }

      // Move to the start of the next day at 00:00 and find the next shift
      current = current.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
      const nextDayShift = center.data.shifts.find((s) => s.dayOfWeek === current.weekday % 7);
      if (nextDayShift) {
        current = current.set({ hour: nextDayShift.startHour });
      }
    }
    return current;
  }
}
