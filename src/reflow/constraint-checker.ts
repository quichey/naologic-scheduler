

import { DateTime, Interval } from 'luxon';
import type { WorkOrder, WorkCenter, ManufacturingOrder } from './types.js';

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
  type: 'OVERLAP' | 'OUTSIDE_SHIFT' | 'MAINTENANCE_COLLISION' | 'DEPENDENCY_ERROR' | 'FIXED_ORDER_MOVED';
  message: string;
}

export class ConstraintChecker {
  /**
   * Main entry point to verify a full schedule
   */
  public static verify(
    orders: WorkOrder[],
    centers: WorkCenter[],
    originalOrders?: WorkOrder[] // Used to check if Fixed Orders moved
  ): Violation[] {
    const violations: Violation[] = [];

    // 1. Check for Fixed Order integrity (Maintenance WOs shouldn't move)
    if (originalOrders) {
      violations.push(...this.checkFixedOrders(orders, originalOrders));
    }

    // 2. Check Resource Constraints (1 Order at a time per Work Center)
    violations.push(...this.checkOverlaps(orders));

    // 3. Check Shift Adherence (Except for Fixed Maintenance)
    violations.push(...this.checkShifts(orders, centers));

    // 4. Check Dependencies
    violations.push(...this.checkDependencies(orders));

    return violations;
  }

  private static checkOverlaps(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    // Group by WorkCenter
    const wcGroups = this.groupBy(orders, (o) => o.data.workCenterId);

    for (const [wcId, group] of Object.entries(wcGroups)) {
      const sorted = group.sort((a, b) => 
        DateTime.fromISO(a.data.startDate).toMillis() - DateTime.fromISO(b.data.startDate).toMillis()
      );

      for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i]!;
        const next = sorted[i + 1]!;
        
        if (DateTime.fromISO(next.data.startDate) < DateTime.fromISO(current.data.endDate)) {
          violations.push({
            orderId: next.docId,
            type: 'OVERLAP',
            message: `Work Center ${wcId} is busy with ${current.docId} until ${current.data.endDate}`
          });
        }
      }
    }
    return violations;
  }

  private static checkShifts(orders: WorkOrder[], centers: WorkCenter[]): Violation[] {
    const violations: Violation[] = [];
    
    for (const order of orders) {
      // Skip check if it's a fixed maintenance order (Gemini assumption: these bypass shifts)
      if (order.data.isMaintenance) continue;

      const center = centers.find(c => c.docId === order.data.workCenterId);
      if (!center) continue;

      const start = DateTime.fromISO(order.data.startDate);
      const end = DateTime.fromISO(order.data.endDate);
      
      // Logic: Ensure the time span is within the work center's shifts
      // (This will be complex logic checking dayOfWeek and hour ranges)
      // For now, we flag if the day is not in center.data.shifts
      const day = start.weekday;
      const hasShift = center.data.shifts.some(s => s.dayOfWeek === day);
      
      if (!hasShift) {
        violations.push({
          orderId: order.docId,
          type: 'OUTSIDE_SHIFT',
          message: `Scheduled on day ${day} but Work Center has no shift defined.`
        });
      }
    }
    return violations;
  }

  private static checkDependencies(orders: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    const orderMap = new Map(orders.map(o => [o.docId, o]));

    for (const order of orders) {
      for (const parentId of order.data.dependsOnWorkOrderIds) {
        const parent = orderMap.get(parentId);
        if (parent && DateTime.fromISO(order.data.startDate) < DateTime.fromISO(parent.data.endDate)) {
          violations.push({
            orderId: order.docId,
            type: 'DEPENDENCY_ERROR',
            message: `Started at ${order.data.startDate} before parent ${parentId} finished at ${parent.data.endDate}`
          });
        }
      }
    }
    return violations;
  }

  private static checkFixedOrders(current: WorkOrder[], original: WorkOrder[]): Violation[] {
    const violations: Violation[] = [];
    for (const order of current) {
      if (order.data.isMaintenance) {
        const orig = original.find(o => o.docId === order.docId);
        if (orig && orig.data.startDate !== order.data.startDate) {
          violations.push({
            orderId: order.docId,
            type: 'FIXED_ORDER_MOVED',
            message: `Maintenance Work Order was moved from ${orig.data.startDate} to ${order.data.startDate}`
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