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

    // If there are no violations, just return orders
    if (violations.length === 0) {
      return { updatedWorkOrders: orders, changes: [], explanation: [] };
    }

    // If there are any fatal violations, error out instead of running an infinite loop
    if (violations.find((v) => v.isFatal)) {
      throw Error('NOT FIXABLE');
    }

    // Begin the automated repair process
    return this.reschedule(orders, centers, violations);
  }

  /**
   * Internal orchestrator that iterates through each work center to resolve local conflicts.
   * It performs a deep clone of orders to ensure data immutability during the calculation phase.
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

    // Process scheduling constraints center-by-center
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

  /**
   * Manages scheduling for a specific Work Center.
   * It respects the topological sequence provided by the SequencePreserver and
   * manages the "Cascade" state to track if movements are caused by original
   * violations or downstream effects.
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
    // 1. Get the optimized sequence (dependencies + original order)
    const processingOrder = SequencePreserver.prepare(orders).get(center.docId) || [];
    const correctlyScheduledOrders: WorkOrder[] = [];

    let hasCascade = false;

    for (let i = 0; i < processingOrder.length; i++) {
      // 2. Setup current and previous context for overlap checking
      const currOrder = processingOrder[i].order;
      const prevOrder = i > 0 ? correctlyScheduledOrders[i - 1] : null;

      const currOrderStartDate = DateTime.fromISO(currOrder.data.startDate, { zone: 'utc' });
      const prevOrderEndDate = prevOrder
        ? DateTime.fromISO(prevOrder.data.endDate, { zone: 'utc' })
        : null;

      // Determine if this order is currently scheduled correctly relative to its predecessor
      const checkForOriginalViolations =
        (prevOrderEndDate && currOrderStartDate >= prevOrderEndDate) || prevOrderEndDate == null;

      // Look up if this order had a pre-existing violation (Shift/Maintenance/Dependency)
      const origViolation = originalViolations.find((v) => v.orderId === currOrder.docId);

      // 3. Logic Branching based on Cascade state
      // A cascade means a previous order in this sequence was moved, likely pushing this one out.
      if (hasCascade) {
        if (checkForOriginalViolations) {
          // We aren't overlapping the previous order, but we might still hit maintenance/shifts
          if (origViolation) {
            const newStart = this.findNextAvailableStart(currOrderStartDate, center, allOrders);
            this.applyShift(currOrder, newStart, center, allOrders);
            changes.push(
              `Order ${currOrder.data.workOrderNumber} moved to ${currOrder.data.startDate}`,
            );

            const reason = `Original violation: ${origViolation.type}`;
            explanation.push(reason);
            // Cascade continues because we had to move this order
          } else {
            // The cascade ends here as this order fits in its original slot
            hasCascade = false;
          }
        } else {
          // Overlap detected due to a previous move (The "Cascade" effect)
          const newStart = this.findNextAvailableStart(prevOrderEndDate!, center, allOrders);
          this.applyShift(currOrder, newStart, center, allOrders);
          changes.push(
            `Order ${currOrder.data.workOrderNumber} moved to ${currOrder.data.startDate}`,
          );
          explanation.push(`Cascading shift changes due to earlier violations`);
        }
      } else {
        // No active cascade, checking for "Original Sins"
        if (checkForOriginalViolations) {
          if (origViolation) {
            const newStart = this.findNextAvailableStart(currOrderStartDate, center, allOrders);
            this.applyShift(currOrder, newStart, center, allOrders);
            changes.push(
              `Order ${currOrder.data.workOrderNumber} moved to ${currOrder.data.startDate}`,
            );

            const reason = `Original violation: ${origViolation.type}`;
            explanation.push(reason);
            hasCascade = true;
          }
        } else {
          // Collision with the previous order OR an original violation
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
   * Helper to update an order's start date and re-calculate the end date.
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
   * Checks if the order's window overlaps with maintenance orders or static windows.
   * * @private
   */
  private static conflictsWithMaintenance(
    order: WorkOrder,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ): boolean {
    const start = DateTime.fromISO(order.data.startDate, { zone: 'utc' });
    const end = DateTime.fromISO(order.data.endDate, { zone: 'utc' });

    // 1. Check against Maintenance Work Orders
    const hasOrderConflict = allOrders.some((o) => {
      if (!o.data.isMaintenance || o.data.workCenterId !== center.docId) return false;
      const mStart = DateTime.fromISO(o.data.startDate, { zone: 'utc' });
      const mEnd = DateTime.fromISO(o.data.endDate, { zone: 'utc' });
      return (start < mEnd && start >= mStart) || (end <= mEnd && end > mStart);
    });

    if (hasOrderConflict) return true;

    // 2. Check against WorkCenter Static Maintenance Windows
    const hasWindowConflict = center.data.maintenanceWindows.some((window) => {
      const wStart = DateTime.fromISO(window.startDate, { zone: 'utc' });
      const wEnd = DateTime.fromISO(window.endDate, { zone: 'utc' });
      return (start < wEnd && start >= wStart) || (end <= wEnd && end > wStart);
    });

    return hasWindowConflict;
  }

  /**
   * Finds the first valid minute for an order to start.
   * It must be within a WorkCenter shift AND not overlapping
   * maintenance (orders or windows).
   * * @private
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

      // --- 1. Shift Check ---
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

      // --- 2. Combined Maintenance Check (Orders + Windows) ---
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
   * Calculates the end date by "walking" through available shift minutes,
   * skipping over Maintenance Orders and Maintenance Windows.
   * * @private
   */
  private static findEndDate(
    start: DateTime,
    duration: number,
    center: WorkCenter,
    allOrders: WorkOrder[],
  ): DateTime {
    let remainingMins = duration;
    let current = start;

    // Create a unified list of "time-blocks" to skip
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

        // Find the next obstacle starting within this shift
        const nextObstacle = obstacles
          .filter((obs) => obs.start >= current && obs.start < shiftEnd)
          .sort((a, b) => a.start.toMillis() - b.start.toMillis())[0];

        // The next point where work MUST stop (either shift end or an obstacle start)
        const nextDeadline = nextObstacle ? nextObstacle.start : shiftEnd;
        const minutesAvailable = nextDeadline.diff(current, 'minutes').minutes;

        if (minutesAvailable > 0) {
          if (remainingMins <= minutesAvailable) {
            // Success! The order fits in the current available block
            return current.plus({ minutes: remainingMins });
          } else {
            // Consume the available time and jump to the obstacle/shift-end
            remainingMins -= minutesAvailable;
            current = nextDeadline;
          }
        }

        // If we reached a maintenance obstacle, jump to the end of it
        if (nextObstacle && current.equals(nextObstacle.start)) {
          current = nextObstacle.end;
          continue; // Re-check if the new current time is still within shift
        }
      }

      // If we are at shift end, jump to the start of the next day's shift
      current = current.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
      const nextDayShift = center.data.shifts.find((s) => s.dayOfWeek === current.weekday % 7);
      if (nextDayShift) {
        current = current.set({ hour: nextDayShift.startHour });
      }
    }

    return current;
  }
}
