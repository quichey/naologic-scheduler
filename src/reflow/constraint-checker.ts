import { DateTime, Interval } from 'luxon';
import type { WorkOrder, WorkCenter } from './types.js';
import { DateUtils } from '../utils/date-utils.js';

/**
 * Represents a specific constraint violation found within a schedule.
 */
export interface Violation {
  /** The unique identifier of the Work Order causing the violation. */
  orderId: string;
  /** The specific category of constraint broken. */
  type:
    | 'OVERLAP'
    | 'OUTSIDE_SHIFT'
    | 'MAINTENANCE_COLLISION'
    | 'DEPENDENCY_ERROR'
    | 'FIXED_ORDER_MOVED';
  /** Human-readable details about the violation. */
  message: string;
  /** * If true, the automated reflow algorithm cannot resolve this.
   * Examples: Circular dependencies or overlapping fixed maintenance.
   */
  isFatal: boolean;
}

/**
 * ConstraintChecker is the high-integrity validation core of the system.
 * It performs multi-pass audits on datasets to ensure adherence to physical,
 * temporal, and business-logic constraints.
 * * It is used by the ReflowService to identify repair needs and by automated
 * tests to verify the correctness of the final output.
 */
export class ConstraintChecker {
  /**
   * Main entry point to verify a full schedule.
   * Runs an exhaustive suite of checks against all active constraints.
   * * @param orders - The list of work orders to validate.
   * @param centers - The work center definitions (shifts and windows).
   * @param originalOrders - Optional. Used to detect if immutable 'Fixed' orders were moved.
   * @returns An array of all detected violations.
   */
  public static verify(
    orders: WorkOrder[],
    centers: WorkCenter[],
    originalOrders?: WorkOrder[],
  ): Violation[] {
    const violations: Violation[] = [];

    // 1. Static Maintenance Windows (Highest Precedence)
    violations.push(...this.checkOrderCollidesWithMaintenanceWindow(orders, centers));

    // 2. Fixed Order Integrity (Immutable maintenance WOs)
    if (originalOrders) {
      violations.push(...this.checkFixedOrders(orders, originalOrders));
    }

    // 3. Resource Constraints (Single-tasking work centers)
    violations.push(...this.checkOverlaps(orders));

    // 4. Shift Adherence (Operational hours validation)
    violations.push(...this.checkShifts(orders, centers));

    // 5. Dependency Chains (Finish-to-Start logic)
    violations.push(...this.checkDependencies(orders));

    // 6. Fatal Violations (Pre-checks for unsolvable states)
    violations.push(...this.checkFixedOrderOverlaps(orders));
    violations.push(...this.checkCircularDependencies(orders));

    return violations;
  }

  /**
   * Detects if standard production orders overlap with a center's maintenance blackout window.
   * Note: Maintenance-type Work Orders are exempt from this check as they represent the work being done.
   * @private
   */
  private static checkOrderCollidesWithMaintenanceWindow(
    orders: WorkOrder[],
    centers: WorkCenter[],
  ): Violation[] {
    const violations: Violation[] = [];

    for (const order of orders) {
      if (order.data.isMaintenance) continue;

      const center = centers.find((c) => c.docId === order.data.workCenterId);
      if (!center || !center.data.maintenanceWindows.length) continue;

      const orderInterval = Interval.fromDateTimes(
        DateTime.fromISO(order.data.startDate, { zone: 'utc' }),
        DateTime.fromISO(order.data.endDate, { zone: 'utc' }),
      );

      for (const mw of center.data.maintenanceWindows) {
        const mwInterval = Interval.fromDateTimes(
          DateTime.fromISO(mw.startDate, { zone: 'utc' }),
          DateTime.fromISO(mw.endDate, { zone: 'utc' }),
        );

        if (orderInterval.overlaps(mwInterval)) {
          violations.push({
            orderId: order.docId,
            type: 'MAINTENANCE_COLLISION',
            isFatal: false, // Recoverable by shifting the production order
            message: `Work Order ${order.data.workOrderNumber} overlaps with a blocked Maintenance Window (${mw.reason || 'Scheduled Maintenance'}).`,
          });
          break; // Avoid spamming multiple violations for the same interval
        }
      }
    }
    return violations;
  }

  /**
   * Ensures that no two orders occupy the same Work Center at the same time.
   * Performs an O(n log n) sort per center to check adjacent orders for overlaps.
   * @private
   */
  private static checkOverlaps(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    const wcGroups = this.groupBy(orders, (o) => o.data.workCenterId);

    for (const [wcId, group] of Object.entries(wcGroups)) {
      const sorted = group.sort(
        (a, b) =>
          DateTime.fromISO(a.data.startDate).toMillis() -
          DateTime.fromISO(b.data.startDate).toMillis(),
      );

      for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i]!;
        const next = sorted[i + 1]!;

        if (DateTime.fromISO(next.data.startDate) < DateTime.fromISO(current.data.endDate)) {
          violations.push({
            orderId: next.docId,
            type: 'OVERLAP',
            message: `Work Center ${wcId} is busy with ${current.docId} until ${current.data.endDate}`,
            isFatal: false,
          });
        }
      }
    }
    return violations;
  }

  /**
   * FATAL CHECK: Maintenance Work Orders are fixed in time. If two maintenance orders
   * overlap on the same resource, the schedule is mathematically impossible to fix.
   * @private
   */
  private static checkFixedOrderOverlaps(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    const fixedOrders = orders.filter((o) => o.data.isMaintenance);
    const wcGroups = this.groupBy(fixedOrders, (o) => o.data.workCenterId);

    for (const [wcId, group] of Object.entries(wcGroups)) {
      const sorted = group.sort(
        (a, b) => new Date(a.data.startDate).getTime() - new Date(b.data.startDate).getTime(),
      );

      for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i]!;
        const next = sorted[i + 1]!;

        const currentEnd = new Date(current.data.endDate).getTime();
        const nextStart = new Date(next.data.startDate).getTime();

        if (nextStart < currentEnd) {
          violations.push({
            orderId: next.docId,
            type: 'MAINTENANCE_COLLISION',
            isFatal: true,
            message: `FATAL: Maintenance Order ${next.docId} overlaps with another fixed Maintenance Order ${current.docId} on Work Center ${wcId}.`,
          });
        }
      }
    }
    return violations;
  }

  /**
   * Validates that production orders occur within operational shifts.
   * Utilizes DateUtils for precise working-minute calculations and boundary checks.
   * @private
   */
  private static checkShifts(orders: WorkOrder[], centers: WorkCenter[]): Violation[] {
    const violations: Violation[] = [];

    for (const order of orders) {
      if (order.data.isMaintenance) continue;

      const center = centers.find((c) => c.docId === order.data.workCenterId);
      if (!center) continue;

      const start = DateTime.fromISO(order.data.startDate, { zone: 'utc' });
      const end = DateTime.fromISO(order.data.endDate, { zone: 'utc' });

      // Check 1: Is the total working-time duration sufficient?
      const actualMins = DateUtils.calculateWorkingMinutes(
        order.data.startDate,
        order.data.endDate,
        center,
      );

      if (Math.abs(actualMins - order.data.durationMinutes) > 1) {
        violations.push({
          orderId: order.docId,
          type: 'OUTSIDE_SHIFT',
          message: `Total work time mismatch: Needs ${order.data.durationMinutes}m, but provided window only allows for ${actualMins}m of shift time.`,
          isFatal: false,
        });
      }

      // Check 2: Boundaries - Start must be within an active shift
      if (!DateUtils.isTimeInShift(start, center.data.shifts, { isEnd: false })) {
        violations.push({
          orderId: order.docId,
          type: 'OUTSIDE_SHIFT',
          message: `Invalid Start: Work Order scheduled to start at ${start.toFormat('HH:mm')} during non-operational hours.`,
          isFatal: false,
        });
      }

      // Check 3: Boundaries - End must be within an active shift
      if (!DateUtils.isTimeInShift(end, center.data.shifts, { isEnd: true })) {
        violations.push({
          orderId: order.docId,
          type: 'OUTSIDE_SHIFT',
          message: `Invalid End: Work Order scheduled to end at ${end.toFormat('HH:mm')} during non-operational hours.`,
          isFatal: false,
        });
      }
    }
    return violations;
  }

  /**
   * Validates Finish-to-Start dependency relationships.
   * @private
   */
  private static checkDependencies(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    const orderMap = new Map(orders.map((o) => [o.docId, o]));

    for (const order of orders) {
      for (const parentId of order.data.dependsOnWorkOrderIds) {
        const parent = orderMap.get(parentId);
        if (
          parent &&
          DateTime.fromISO(order.data.startDate) < DateTime.fromISO(parent.data.endDate)
        ) {
          violations.push({
            orderId: order.docId,
            type: 'DEPENDENCY_ERROR',
            message: `Started at ${order.data.startDate} before parent ${parentId} finished at ${parent.data.endDate}`,
            isFatal: false,
          });
        }
      }
    }
    return violations;
  }

  /**
   * FATAL CHECK: Detects infinite loops in the dependency graph using DFS and a recursion stack.
   * If Order A depends on B, and B depends on A, the schedule is unfixable.
   * @private
   */
  private static checkCircularDependencies(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    const orderMap = new Map(orders.map((o) => [o.docId, o]));
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const hasCycle = (orderId: string, path: string[]): boolean => {
      if (recStack.has(orderId)) {
        violations.push({
          orderId,
          type: 'DEPENDENCY_ERROR',
          isFatal: true,
          message: `FATAL: Circular dependency detected: ${path.join(' -> ')} -> ${orderId}`,
        });
        return true;
      }
      if (visited.has(orderId)) return false;

      visited.add(orderId);
      recStack.add(orderId);

      const order = orderMap.get(orderId);
      if (order) {
        for (const depId of order.data.dependsOnWorkOrderIds) {
          if (hasCycle(depId, [...path, orderId])) return true;
        }
      }

      recStack.delete(orderId);
      return false;
    };

    for (const order of orders) {
      if (!visited.has(order.docId)) {
        hasCycle(order.docId, []);
      }
    }

    return violations;
  }

  /**
   * Ensures that Maintenance Work Orders (which are immutable) haven't been shifted.
   * @private
   */
  private static checkFixedOrders(current: WorkOrder[], original: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    for (const order of current) {
      if (order.data.isMaintenance) {
        const orig = original.find((o) => o.docId === order.docId);
        if (orig && orig.data.startDate !== order.data.startDate) {
          violations.push({
            orderId: order.docId,
            type: 'FIXED_ORDER_MOVED',
            message: `Maintenance Work Order was moved from ${orig.data.startDate} to ${order.data.startDate}`,
            isFatal: false,
          });
        }
      }
    }
    return violations;
  }

  /**
   * Utility to group flat arrays into indexed records.
   * @private
   */
  private static groupBy<T>(array: T[], keyGetter: (item: T) => string) {
    const map: Record<string, T[]> = {};
    array.forEach((item) => {
      const key = keyGetter(item);
      if (!map[key]) map[key] = [];
      map[key]!.push(item);
    });
    return map;
  }
}
