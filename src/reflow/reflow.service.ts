import type { WorkOrder, WorkCenter } from './types.js';
import type { Violation } from './constraint-checker.js';
import { ConstraintChecker } from './constraint-checker.js';
import { SequencePreserver } from './sequence-preserver.js';
import { DateTime } from 'luxon';

/**
 * Represents the results of a schedule reflow operation.
 */
export interface ReflowedSchedule {
  /** The full list of work orders with updated temporal data. */
  updatedWorkOrders: WorkOrder[];
  /** A log of specific movements (e.g., "Order X moved to Y"). */
  changes: string[];
  /** A natural language explanation of the logic applied (e.g., "Cascading shift"). */
  explanation: string[];
}

/**
 * ReflowService provides the core scheduling logic to resolve constraint violations.
 * It utilizes a "Detect and Repair" strategy, grouping orders by work center and
 * resolving overlaps while preserving original intent and dependencies.
 */
export class ReflowService {
  /**
   * Entry point for the reflow operation. Performs a pre-validation check
   * to ensure the dataset is fixable before attempting to reschedule.
   * * @param orders - The current list of work orders.
   * @param centers - The available work centers and their constraints.
   * @returns A new schedule or throws if fatal violations (like circular deps) exist.
   * @throws Error "NOT FIXABLE" if a fatal violation is detected.
   */
  public static reflow(orders: WorkOrder[], centers: WorkCenter[]): ReflowedSchedule {
    let violations = ConstraintChecker.verify(orders, centers);

    if (violations.length === 0) {
      return { updatedWorkOrders: orders, changes: [], explanation: [] };
    }

    if (violations.find((v) => v.isFatal)) {
      throw Error('NOT FIXABLE');
    }

    return this.reschedule(orders, centers, violations);
  }

  /**
   * Internal orchestrator that iterates through each work center to resolve local conflicts.
   * * @private
   */
  private static reschedule(
    orders: WorkOrder[],
    centers: WorkCenter[],
    originalViolations: Violation[],
  ): ReflowedSchedule {
    let currentOrders = JSON.parse(JSON.stringify(orders));
    let changes: string[] = [];
    let explanation: string[] = [];

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

      updatedCenterOrders.forEach((updated) => {
        const idx = currentOrders.findIndex((o: WorkOrder) => o.docId === updated.docId);
        currentOrders[idx] = updated;
      });
    }

    return { updatedWorkOrders: currentOrders, changes, explanation };
  }

  /**
   * Manages scheduling for a specific Work Center. It respects the sequence provided
   * by the SequencePreserver and manages the "Cascade" state to track if movements
   * are caused by original violations or downstream effects.
   * * @private
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
      const currOrder = processingOrder[i].order;
      const prevOrder = i > 0 ? correctlyScheduledOrders[i - 1] : null;

      const currOrderStartDate = DateTime.fromISO(currOrder.data.startDate, { zone: 'utc' });
      const prevOrderEndDate = prevOrder
        ? DateTime.fromISO(prevOrder.data.endDate, { zone: 'utc' })
        : null;

      const checkForOriginalViolations =
        (prevOrderEndDate && currOrderStartDate >= prevOrderEndDate) || prevOrderEndDate == null;
      const origViolation = originalViolations.find((v) => v.orderId === currOrder.docId);

      // Branching logic manages the "Cascade" flag to differentiate between
      // repairing a direct violation vs. shifting an order because its predecessor moved.
      if (hasCascade) {
        if (checkForOriginalViolations) {
          if (origViolation) {
            const newStart = this.findNextAvailableStart(currOrderStartDate, center, allOrders);
            this.applyShift(currOrder, newStart, center, allOrders);
            changes.push(
              `Order ${currOrder.data.workOrderNumber} moved to ${currOrder.data.startDate}`,
            );
            explanation.push(`Original violation: ${origViolation.type}`);
          } else {
            hasCascade = false;
          }
        } else {
          const newStart = this.findNextAvailableStart(prevOrderEndDate!, center, allOrders);
          this.applyShift(currOrder, newStart, center, allOrders);
          changes.push(
            `Order ${currOrder.data.workOrderNumber} moved to ${currOrder.data.startDate}`,
          );
          explanation.push(`Cascading shift changes due to earlier violations`);
        }
      } else {
        if (checkForOriginalViolations) {
          if (origViolation) {
            const newStart = this.findNextAvailableStart(currOrderStartDate, center, allOrders);
            this.applyShift(currOrder, newStart, center, allOrders);
            changes.push(
              `Order ${currOrder.data.workOrderNumber} moved to ${currOrder.data.startDate}`,
            );
            explanation.push(`Original violation: ${origViolation.type}`);
            hasCascade = true;
          }
        } else {
          const nextStart = prevOrderEndDate
            ? this.findNextAvailableStart(prevOrderEndDate, center, allOrders)
            : this.findNextAvailableStart(currOrderStartDate, center, allOrders);

          this.applyShift(currOrder, nextStart, center, allOrders);

          const reason = origViolation
            ? `Original violation: ${origViolation.type}`
            : `Collision with previous order ${prevOrder?.data.workOrderNumber}`;

          changes.push(
            `Order ${currOrder.data.workOrderNumber} moved to ${currOrder.data.startDate}`,
          );
          explanation.push(reason);
          hasCascade = true;
        }
      }

      correctlyScheduledOrders.push(currOrder);
    }

    return correctlyScheduledOrders;
  }

  /**
   * Updates an order's start date and triggers a recalculation of the end date
   * based on the work center's available capacity.
   * * @private
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
   * Determines if a given order's time window overlaps with maintenance activities.
   * Maintenance includes both static WorkCenter windows and dynamic Maintenance Work Orders.
   * * @private
   */
  private static conflictsWithMaintenance(
    order: WorkOrder,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ): boolean {
    const start = DateTime.fromISO(order.data.startDate, { zone: 'utc' });
    const end = DateTime.fromISO(order.data.endDate, { zone: 'utc' });

    const hasOrderConflict = allOrders.some((o) => {
      if (!o.data.isMaintenance || o.data.workCenterId !== center.docId) return false;
      const mStart = DateTime.fromISO(o.data.startDate, { zone: 'utc' });
      const mEnd = DateTime.fromISO(o.data.endDate, { zone: 'utc' });
      return (start < mEnd && start >= mStart) || (end <= mEnd && end > mStart);
    });

    if (hasOrderConflict) return true;

    const hasWindowConflict = center.data.maintenanceWindows.some((window) => {
      const wStart = DateTime.fromISO(window.startDate, { zone: 'utc' });
      const wEnd = DateTime.fromISO(window.endDate, { zone: 'utc' });
      return (start < wEnd && start >= wStart) || (end <= wEnd && end > wStart);
    });

    return hasWindowConflict;
  }

  /**
   * Searches for the first available minute a Work Center is "Open" and "Available."
   * It skips over non-working days, out-of-shift hours, and maintenance obstacles.
   * * @private
   * @param proposedStart - The ideal starting time.
   * @returns The nearest valid DateTime that satisfies all constraints.
   */
  private static findNextAvailableStart(
    proposedStart: DateTime,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ): DateTime {
    let current = proposedStart;
    let foundValidStart = false;

    const maintenanceOrders = allOrders.filter(
      (o) => o.data.isMaintenance && o.data.workCenterId === center.docId,
    );

    while (!foundValidStart) {
      const dayOfWeek = current.weekday % 7;
      const shift = center.data.shifts.find((s) => s.dayOfWeek === dayOfWeek);

      if (!shift) {
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
      } else if (current >= shiftEnd) {
        current = current.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
        continue;
      }

      const orderBlocker = maintenanceOrders.find((m) => {
        const mStart = DateTime.fromISO(m.data.startDate, { zone: 'utc' });
        const mEnd = DateTime.fromISO(m.data.endDate, { zone: 'utc' });
        return current >= mStart && current < mEnd;
      });

      const windowBlocker = center.data.maintenanceWindows.find((w) => {
        const wStart = DateTime.fromISO(w.startDate, { zone: 'utc' });
        const wEnd = DateTime.fromISO(w.endDate, { zone: 'utc' });
        return current >= wStart && current < wEnd;
      });

      if (orderBlocker) {
        current = DateTime.fromISO(orderBlocker.data.endDate, { zone: 'utc' });
        continue;
      }

      if (windowBlocker) {
        current = DateTime.fromISO(windowBlocker.endDate, { zone: 'utc' });
        continue;
      }

      foundValidStart = true;
    }

    return current;
  }

  /**
   * Calculates the completion time of an order by "walking" through available
   * capacity. It effectively skips over gaps where work cannot proceed.
   * * @private
   * @param start - The validated start time.
   * @param duration - Required working minutes.
   * @returns The final completion DateTime.
   */
  private static findEndDate(
    start: DateTime,
    duration: number,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ): DateTime {
    let remainingMins = duration;
    let current = start;

    const obstacles = [
      ...center.data.maintenanceWindows.map((w) => ({
        start: DateTime.fromISO(w.startDate, { zone: 'utc' }),
        end: DateTime.fromISO(w.endDate, { zone: 'utc' }),
      })),
      ...allOrders
        .filter((o) => o.data.isMaintenance && o.data.workCenterId === center.docId)
        .map((o) => ({
          start: DateTime.fromISO(o.data.startDate, { zone: 'utc' }),
          end: DateTime.fromISO(o.data.endDate, { zone: 'utc' }),
        })),
    ];

    while (remainingMins > 0) {
      const dayOfWeek = current.weekday % 7;
      const shift = center.data.shifts.find((s) => s.dayOfWeek === dayOfWeek);

      if (shift) {
        const shiftEnd = current.set({ hour: shift.endHour, minute: 0, second: 0, millisecond: 0 });

        const nextObstacle = obstacles
          .filter((obs) => obs.start >= current && obs.start < shiftEnd)
          .sort((a, b) => a.start.toMillis() - b.start.toMillis())[0];

        const nextDeadline = nextObstacle ? nextObstacle.start : shiftEnd;
        const minutesAvailable = nextDeadline.diff(current, 'minutes').minutes;

        if (minutesAvailable > 0) {
          if (remainingMins <= minutesAvailable) {
            return current.plus({ minutes: remainingMins });
          } else {
            remainingMins -= minutesAvailable;
            current = nextDeadline;
          }
        }

        if (nextObstacle && current.equals(nextObstacle.start)) {
          current = nextObstacle.end;
          continue;
        }
      }

      current = current.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
      const nextDayShift = center.data.shifts.find((s) => s.dayOfWeek === current.weekday % 7);
      if (nextDayShift) {
        current = current.set({ hour: nextDayShift.startHour });
      }
    }

    return current;
  }
}
