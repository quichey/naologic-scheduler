import type { WorkOrder, WorkCenter, ManufacturingOrder } from './types.js';
import type { Violation } from './constraint-checker.js';
import { ConstraintChecker } from './constraint-checker.js';
import { SequencePreserver } from './sequence-preserver.js';

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
    // 1. Generate the Master Processing Order using your blueprint
    const processingOrder = SequencePreserver.prepare(orders).get(center.docId) || [];

    let hasCascade = false
    for (var i = 0; i < processingOrder.length; i++) {
      const currOrder = //get cur order in processingOrder
      const prevOrder = //get prev order in processingOrder
      // adjust the schedule
      // check if currOrder overlaps with prevOrder or starts before prevOrder because of some cascade
      // or if it overlaps with maintenance
      // use the helper functions for finding start and end date

      // after making adjustments if necessary, provide the changes and explanations
      // Explanations:
      // 1. check the original violations for dependency violation
      // 2. collision with maintenance
      // 3. collision with previous order
      // 4. cascade shift 
    }
  }
  /*
  Assume orders all have the same work center
  */
  private static rescheduleByCenterOld(
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
            // Ensure the child starts at the parent end OR the next shift start
            const nextValidStart = this.findNextAvailableStart(parentEnd, center);

            order.data.startDate = nextValidStart.toISO()!;
            order.data.endDate = this.findEndDate(
              nextValidStart,
              order.data.durationMinutes,
              center,
            ).toISO()!;

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
          nextStart = this.findNextAvailableStart(
            DateTime.fromISO(blocker!.data.endDate, { zone: 'utc' }),
            center,
          );
        } else {
          // If it's a shift or maintenance violation, jump to the next minute and let the helper find the next shift
          const current = DateTime.fromISO(order.data.startDate, { zone: 'utc' });
          nextStart = this.findNextAvailableStart(current.plus({ minutes: 1 }), center);
        }

        order.data.startDate = nextStart.toISO()!;
        order.data.endDate = this.findEndDate(
          nextStart,
          order.data.durationMinutes,
          center,
        ).toISO()!;

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

  /**
   * Finds the first valid minute for an order to start.
   * It must be within a WorkCenter shift AND not overlapping a Maintenance Work Order.
   */
  private static findNextAvailableStart(proposedStart: DateTime, center: WorkCenter, allOrders: WorkOrder[]): DateTime {
    let current = proposedStart;
    let foundValidStart = false;

    // Filter maintenance orders for this specific center once to optimize
    const maintenance = allOrders.filter(o => o.data.isMaintenance && o.data.workCenterId === center.docId);

    // We keep checking until we find a time that satisfies both Shift and Maintenance constraints
    while (!foundValidStart) {
      const dayOfWeek = current.weekday % 7;
      const shift = center.data.shifts.find((s) => s.dayOfWeek === dayOfWeek);

      // --- 1. Shift Check ---
      if (!shift) {
        // No shift today, jump to start of tomorrow
        current = current.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
        continue;
      }

      const shiftStart = current.set({ hour: shift.startHour, minute: 0, second: 0, millisecond: 0 });
      const shiftEnd = current.set({ hour: shift.endHour, minute: 0, second: 0, millisecond: 0 });

      if (current < shiftStart) {
        current = shiftStart;
        // Re-check this new time against maintenance
      } else if (current >= shiftEnd) {
        // Past today's shift, jump to tomorrow
        current = current.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
        continue;
      }

      // --- 2. Maintenance Check ---
      // Find any maintenance block that currently "swallows" our proposed start time
      const blocker = maintenance.find(m => {
        const mStart = DateTime.fromISO(m.data.startDate, { zone: 'utc' });
        const mEnd = DateTime.fromISO(m.data.endDate, { zone: 'utc' });
        return current >= mStart && current < mEnd;
      });

      if (blocker) {
        // Collision! Jump to the end of the maintenance and loop again to re-check shifts
        current = DateTime.fromISO(blocker.data.endDate, { zone: 'utc' });
        continue;
      }

      // If we got here, we are inside a shift and not in maintenance
      foundValidStart = true;
    }

    return current;
  }
  private static findEndDate(start: DateTime, duration: number, center: WorkCenter, allOrders: WorkOrder[]): DateTime {
  let remainingMins = duration;
  let current = start;

  const maintenance = allOrders.filter(o => o.data.isMaintenance && o.data.workCenterId === center.docId);

  while (remainingMins > 0) {
    const dayOfWeek = current.weekday % 7;
    const shift = center.data.shifts.find((s) => s.dayOfWeek === dayOfWeek);

    if (shift) {
      const shiftEnd = current.set({ hour: shift.endHour, minute: 0, second: 0, millisecond: 0 });
      
      // 1. Find any maintenance that starts between 'current' and 'shiftEnd'
      const nextMaintenance = maintenance
        .map(m => ({ start: DateTime.fromISO(m.data.startDate, { zone: 'utc' }), end: DateTime.fromISO(m.data.endDate, { zone: 'utc' }) }))
        .filter(m => m.start >= current && m.start < shiftEnd)
        .sort((a, b) => a.start.toMillis() - b.start.toMillis())[0];

      // 2. Determine the "Next Deadline" (either the shift end or the next maintenance start)
      const nextObstacle = nextMaintenance ? nextMaintenance.start : shiftEnd;
      const minutesAvailable = nextObstacle.diff(current, 'minutes').minutes;

      if (minutesAvailable > 0) {
        if (remainingMins <= minutesAvailable) {
          // We finish before the next obstacle!
          return current.plus({ minutes: remainingMins });
        } else {
          // Consume available time and jump to the obstacle
          remainingMins -= minutesAvailable;
          current = nextObstacle;
        }
      }

      // 3. Handle Obstacle Jumping
      if (nextMaintenance && current.equals(nextMaintenance.start)) {
        // We hit maintenance! Jump to the end of it and continue the loop
        current = nextMaintenance.end;
        continue; // Re-check if we are still within shift or if maintenance pushed us out
      }
    }

    // 4. If we are at shift end or in a non-working period, jump to next shift start
    current = current.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
    const nextDayShift = center.data.shifts.find((s) => s.dayOfWeek === current.weekday % 7);
    if (nextDayShift) {
      current = current.set({ hour: nextDayShift.startHour });
    }
  }

  return current;
}
}
