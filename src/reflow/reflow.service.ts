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
    return this.reschedule(orders, centers, violations);
  }
  private static reschedule(
    orders: WorkOrder[],
    centers: WorkCenter[],
    originalViolations: Violation[],
  ): ReflowedSchedule {
    let currentOrders = JSON.parse(JSON.stringify(orders));
    let changes: string[] = [];
    let explanation: string[] = [];

    // We process center by center
    for (const center of centers) {
      const centerOrders = currentOrders.filter(
        (o: WorkOrder) => o.data.workCenterId === center.docId,
      );

      const updatedCenterOrders = this.rescheduleByCenter(
        centerOrders,
        center,
        currentOrders,
        originalViolations,
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
    allOrders: WorkOrder[],
    originalViolations: Violation[],
    changes: string[],
    explanation: string[],
  ): WorkOrder[] {
    const processingOrder = SequencePreserver.prepare(orders).get(center.docId) || [];
    const correctlyScheduledOrders: WorkOrder[] = [];

    let hasCascade = false;

    for (let i = 0; i < processingOrder.length; i++) {
      // 1. Setup current and previous context
      const currOrder = processingOrder[i].order;
      const prevOrder = i > 0 ? correctlyScheduledOrders[i - 1] : null;

      const currOrderStartDate = DateTime.fromISO(currOrder.data.startDate, { zone: 'utc' });
      const prevOrderEndDate = prevOrder
        ? DateTime.fromISO(prevOrder.data.endDate, { zone: 'utc' })
        : null;

      // 2. Logic Branching based on Cascade state
      if (hasCascade) {
        if (prevOrderEndDate && currOrderStartDate >= prevOrderEndDate) {
          // We aren't overlapping the previous order, but we might still hit maintenance
          if (this.conflictsWithMaintenance(currOrder, center, allOrders)) {
            const newStart = this.findNextAvailableStart(currOrderStartDate, center, allOrders);
            this.applyShift(currOrder, newStart, center, allOrders);
            changes.push(`Order ${currOrder.docId} moved to ${currOrder.data.startDate}`);
            explanation.push(`Conflicts with maintenance`);
            // Cascade continues because we moved
          } else {
            hasCascade = false;
          }
        } else {
          // Overlap detected due to a previous move
          const newStart = this.findNextAvailableStart(prevOrderEndDate!, center, allOrders);
          this.applyShift(currOrder, newStart, center, allOrders);
          changes.push(`Order ${currOrder.docId} moved to ${currOrder.data.startDate}`);
          explanation.push(`Cascading shift changes due to earlier violations`);
        }
      } else {
        // No active cascade, checking for original sins
        if (prevOrderEndDate && currOrderStartDate >= prevOrderEndDate) {
          if (this.conflictsWithMaintenance(currOrder, center, allOrders)) {
            const newStart = this.findNextAvailableStart(currOrderStartDate, center, allOrders);
            this.applyShift(currOrder, newStart, center, allOrders);
            changes.push(`Order ${currOrder.docId} moved to ${currOrder.data.startDate}`);
            explanation.push(`Conflicts with maintenance`);
            hasCascade = true;
          }
        } else {
          // Either overlap with previous OR an original violation (Shift/Dependency)
          const nextStart = prevOrderEndDate
            ? this.findNextAvailableStart(prevOrderEndDate, center, allOrders)
            : this.findNextAvailableStart(currOrderStartDate, center, allOrders);

          this.applyShift(currOrder, nextStart, center, allOrders);

          // Find the specific original cause for the logs
          const origViolation = originalViolations.find((v) => v.orderId === currOrder.docId);
          const reason = origViolation
            ? `Original violation: ${origViolation.type}`
            : `Collision with previous order ${prevOrder?.data.workOrderNumber}`;

          changes.push(`Order ${currOrder.docId} moved to ${currOrder.data.startDate}`);
          explanation.push(reason);
          hasCascade = true;
        }
      }

      correctlyScheduledOrders.push(currOrder);
    }

    return correctlyScheduledOrders;
  }

  /**
   * Small helper to apply time changes and re-calculate end date
   */
  private static applyShift(
    order: WorkOrder,
    start: DateTime,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ) {
    order.data.startDate = start.toISO()!;
    order.data.endDate = this.findEndDate(
      start,
      order.data.durationMinutes,
      center,
      allOrders,
    ).toISO()!;
  }

  /**
   * Checks if the current order's window overlaps with:
   * 1. Static Maintenance Orders (isMaintenance: true)
   * 2. The WorkCenter's defined Maintenance Windows
   */
  private static conflictsWithMaintenance(
    order: WorkOrder,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ): boolean {
    const start = DateTime.fromISO(order.data.startDate, { zone: 'utc' });
    const end = DateTime.fromISO(order.data.endDate, { zone: 'utc' });

    // 1. Check against Maintenance Work Orders
    const overlapsMaintenanceOrder = allOrders.some(
      (o) =>
        o.data.isMaintenance &&
        o.data.workCenterId === center.docId &&
        DateUtils.doPeriodsOverlap(
          start,
          end,
          DateTime.fromISO(o.data.startDate, { zone: 'utc' }),
          DateTime.fromISO(o.data.endDate, { zone: 'utc' }),
        ),
    );

    if (overlapsMaintenanceOrder) return true;

    // 2. Check against WorkCenter Maintenance Windows
    const overlapsMaintenanceWindow = center.data.maintenanceWindows.some((window) => {
      const windowStart = DateTime.fromISO(window.startDate, { zone: 'utc' });
      const windowEnd = DateTime.fromISO(window.endDate, { zone: 'utc' });
      return DateUtils.doPeriodsOverlap(start, end, windowStart, windowEnd);
    });

    return overlapsMaintenanceWindow;
  }
  /**
   * Finds the first valid minute for an order to start.
   * It must be within a WorkCenter shift AND not overlapping a Maintenance Work Order.
   */
  private static findNextAvailableStart(
    proposedStart: DateTime,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ): DateTime {
    let current = proposedStart;
    let foundValidStart = false;

    // Filter maintenance orders for this specific center once to optimize
    const maintenance = allOrders.filter(
      (o) => o.data.isMaintenance && o.data.workCenterId === center.docId,
    );

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

      const shiftStart = current.set({
        hour: shift.startHour,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
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
      const blocker = maintenance.find((m) => {
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
  private static findEndDate(
    start: DateTime,
    duration: number,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ): DateTime {
    let remainingMins = duration;
    let current = start;

    const maintenance = allOrders.filter(
      (o) => o.data.isMaintenance && o.data.workCenterId === center.docId,
    );

    while (remainingMins > 0) {
      const dayOfWeek = current.weekday % 7;
      const shift = center.data.shifts.find((s) => s.dayOfWeek === dayOfWeek);

      if (shift) {
        const shiftEnd = current.set({ hour: shift.endHour, minute: 0, second: 0, millisecond: 0 });

        // 1. Find any maintenance that starts between 'current' and 'shiftEnd'
        const nextMaintenance = maintenance
          .map((m) => ({
            start: DateTime.fromISO(m.data.startDate, { zone: 'utc' }),
            end: DateTime.fromISO(m.data.endDate, { zone: 'utc' }),
          }))
          .filter((m) => m.start >= current && m.start < shiftEnd)
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
