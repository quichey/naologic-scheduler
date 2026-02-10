import type { WorkOrder, WorkCenter, ManufacturingOrder } from './types.js';
import type { Violation } from './constraint-checker.js';
import { ConstraintChecker } from './constraint-checker.js';

import { DateTime } from 'luxon';
import { DateUtils } from '../utils/date-utils.js';

/**
 * Internal helper to track the original intent during the reflow process.
 */
interface SequencedOrder {
  order: WorkOrder;
  originalRank: number; // Based on the original startDate order
  originalGapMinutes: number; // Gap between this order and its immediate predecessor
}

export class SequencePreserver {
  /**
   * Prepares orders by tagging them with their original sequence rank
   * per work center.
   */
  public static prepare(orders: WorkOrder[]): Map<string, SequencedOrder[]> {
    const grouped = new Map<string, SequencedOrder[]>();

    // Group by center and sort by original date
    const centers = [...new Set(orders.map((o) => o.data.workCenterId))];

    for (const wcId of centers) {
      const centerOrders = orders
        .filter((o) => o.data.workCenterId === wcId)
        .sort(
          (a, b) =>
            DateTime.fromISO(a.data.startDate).toMillis() -
            DateTime.fromISO(b.data.startDate).toMillis(),
        );

      const sequenced = centerOrders.map((order, index) => {
        let gap = 0;
        if (index > 0) {
          const prevEnd = DateTime.fromISO(centerOrders[index - 1].data.endDate);
          const currentStart = DateTime.fromISO(order.data.startDate);
          gap = Math.max(0, currentStart.diff(prevEnd, 'minutes').minutes);
        }

        return {
          order,
          originalRank: index,
          originalGapMinutes: gap,
        };
      });

      grouped.set(wcId, sequenced);
    }

    return grouped;
  }
}
