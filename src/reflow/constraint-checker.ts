import { DateTime, Interval } from 'luxon';
import type { WorkOrder, WorkCenter, ManufacturingOrder } from './types.js';
import { DateUtils } from '../utils/date-utils.js';

/*
Since datasets are going to be large,
want to use this script as a way to vet and automate testing 
of the large datasets.

constraints:

-- Work Centers can only work on 1 Work Order at a time

-- Work Centers have shifts like typical companies. Work orders cannot progress when a shift is not in session

-- Work Centers have specified maintenance windows in which work orders cannot progress

-- some work orders require other work orders to be finished first

-- some Work Orders are maintenance work orders. That cannot be moved

--- question: if the work order cannot be moved, what if the duration is longer than any shifts of any work center? Does the work center continue progress on it outside of regular schedule? Do we assume this will never happen?
----- gemini says to treat these as things that happen even outside of Work Center shifts, as these are critical.

-- algorithm needs to output:

--- Output:

---- new schedule that satisfies all conditions

---- list of changes from original schedule

---- why changes occurred
*/

export interface Violation {
  orderId: string;
  type:
    | 'OVERLAP'
    | 'OUTSIDE_SHIFT'
    | 'MAINTENANCE_COLLISION'
    | 'DEPENDENCY_ERROR'
    | 'FIXED_ORDER_MOVED';
  message: string;
  isFatal: boolean; // True if the algorithm cannot possibly fix this
}

export class ConstraintChecker {
  /**
   * Main entry point to verify a full schedule
   */
  public static verify(
    orders: WorkOrder[],
    centers: WorkCenter[],
    originalOrders?: WorkOrder[], // Used to check if Fixed Orders moved
  ): Violation[] {
    const violations: Violation[] = [];

    // Check Maintenance Window Collisions FIRST (Highest Precedence)
    violations.push(...this.checkOrderCollidesWithMaintenanceWindow(orders, centers));

    // Check for Fixed Order integrity (Maintenance WOs shouldn't move)
    if (originalOrders) {
      violations.push(...this.checkFixedOrders(orders, originalOrders));
    }

    // Check Resource Constraints (1 Order at a time per Work Center)
    violations.push(...this.checkOverlaps(orders));

    // Check Shift Adherence (Except for Fixed Maintenance)
    violations.push(...this.checkShifts(orders, centers));

    // Check Dependencies
    violations.push(...this.checkDependencies(orders));

    // Check If any Maintenance Orders Overlap (Fatal unfixable violation)
    violations.push(...this.checkFixedOrderOverlaps(orders));

    // Check For Circular dependencies of Orders (Fatal unfixable violation)
    violations.push(...this.checkCircularDependencies(orders));

    return violations;
  }

  private static checkOrderCollidesWithMaintenanceWindow(
    orders: WorkOrder[],
    centers: WorkCenter[],
  ): Violation[] {
    const violations: Violation[] = [];

    for (const order of orders) {
      // Maintenance-type Work Orders are allowed to be in maintenance windows
      // (since they are the maintenance)
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

        // We check for any overlap at all
        if (orderInterval.overlaps(mwInterval)) {
          violations.push({
            orderId: order.docId,
            type: 'MAINTENANCE_COLLISION',
            isFatal: false, // The algorithm should be able to move the WO
            message: `Work Order ${order.data.workOrderNumber} overlaps with a blocked Maintenance Window (${mw.reason || 'Scheduled Maintenance'}).`,
          });
          // Break after first collision for this order to avoid duplicate violations
          break;
        }
      }
    }
    return violations;
  }

  private static checkOverlaps(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    // Group by WorkCenter
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

  private static checkFixedOrderOverlaps(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    const fixedOrders = orders.filter((o) => o.data.isMaintenance);
    const wcGroups = this.groupBy(fixedOrders, (o) => o.data.workCenterId);

    for (const [wcId, group] of Object.entries(wcGroups)) {
      // Sort by start time to check neighbors
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
            isFatal: true, // This is the key!
            message: `FATAL: Maintenance Order ${next.docId} overlaps with another fixed Maintenance Order ${current.docId} on Work Center ${wcId}.`,
          });
        }
      }
    }
    return violations;
  }

  private static checkShifts(orders: WorkOrder[], centers: WorkCenter[]): Violation[] {
    const violations: Violation[] = [];

    for (const order of orders) {
      if (order.data.isMaintenance) continue;

      const center = centers.find((c) => c.docId === order.data.workCenterId);
      if (!center) continue;

      const start = DateTime.fromISO(order.data.startDate, { zone: 'utc' });
      const end = DateTime.fromISO(order.data.endDate, { zone: 'utc' });

      // 1. Existing check: Is the TOTAL duration correct?
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

      // 2. NEW check: Is the startDate actually inside a shift?
      const isStartInShift = center.data.shifts.some(
        (s) =>
          s.dayOfWeek === start.weekday % 7 && start.hour >= s.startHour && start.hour < s.endHour,
      );

      if (!isStartInShift) {
        violations.push({
          orderId: order.docId,
          type: 'OUTSIDE_SHIFT',
          message: `Invalid Start: Work Order is scheduled to start at ${start.toFormat('HH:mm')} on a day/time with no active shift.`,
          isFatal: false,
        });
      }

      // 3. NEW check: Is the endDate actually inside a shift?
      const isEndInShift = center.data.shifts.some(
        (s) => s.dayOfWeek === end.weekday % 7 && end.hour > s.startHour && end.hour <= s.endHour,
      );

      if (!isEndInShift) {
        violations.push({
          orderId: order.docId,
          type: 'OUTSIDE_SHIFT',
          message: `Invalid End: Work Order is scheduled to end at ${end.toFormat('HH:mm')} on a day/time with no active shift.`,
          isFatal: false,
        });
      }
    }
    return violations;
  }

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

  private static checkCircularDependencies(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    const orderMap = new Map(orders.map((o) => [o.docId, o]));
    const visited = new Set<string>();
    const recStack = new Set<string>(); // Tracking the current recursion path

    const hasCycle = (orderId: string, path: string[]): boolean => {
      if (recStack.has(orderId)) {
        // Cycle detected!
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
