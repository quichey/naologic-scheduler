import type { WorkOrder, WorkCenter, ManufacturingOrder } from './types.js';
import type { Violation } from './constraint-checker.js';
import { ConstraintChecker } from './constraint-checker.js';

import { DateTime } from 'luxon';
import { DateUtils } from '../utils/date-utils.js';

/**
 * Internal helper to track the original intent during the reflow process.
 */
interface OriginalSequencedOrder {
  order: WorkOrder;
  originalRank: number; // Based on the original startDate order
  originalGapMinutes: number; // Gap between this order and its immediate predecessor
}
interface DependencyGroup {
  groupId: number;
  orderIds: string[];
  // Map of OrderID -> Array of Child OrderIDs
  adjList: Map<string, string[]>;
  // Topological sort of the orders IDs
  topologicalOrdering: string[];
  // The earliest original start date in the whole group (to rank the group itself)
  originalAnchor: number;
}

interface NewSequencedOrder {
  order: WorkOrder;
  rank: number; // The absolute processing order [0, 1, 2...]
}

export class SequencePreserver {
  public static prepare(orders: WorkOrder[]): Map<string, NewSequencedOrder[]> {
    const groupedByCenter = new Map<string, NewSequencedOrder[]>();
    const wcIds = [...new Set(orders.map((o) => o.data.workCenterId))];

    for (const wcId of wcIds) {
      const centerOrders = orders.filter((o) => o.data.workCenterId === wcId);

      const dependencyGroups = this.findDependencyGroups(centerOrders);
      const originalSequence = this.findOriginalSequenceOrder(centerOrders);

      // 1. Sort each dependency group internally
      for (const dGroup of dependencyGroups) {
        this.topologicalSort(dGroup, centerOrders);
      }

      // 2. Final Sequencing Logic
      // Strategy: Iterate through original sequence.
      // If we hit an order in a group, process the ENTIRE group.
      // If we hit an independent order, process it.
      const finalSequence: NewSequencedOrder[] = [];
      const processedOrderIds = new Set<string>();
      let currentRank = 0;

      for (const seqItem of originalSequence) {
        const orderId = seqItem.order.docId;
        if (processedOrderIds.has(orderId)) continue;

        const group = dependencyGroups.find((g) => g.orderIds.includes(orderId));

        if (group) {
          // Process the entire group in its topological order
          for (const id of group.topologicalOrdering) {
            const groupOrder = centerOrders.find((o) => o.docId === id)!;
            finalSequence.push({ order: groupOrder, rank: currentRank++ });
            processedOrderIds.add(id);
          }
        } else {
          // Independent Order: Append it after current progress
          finalSequence.push({ order: seqItem.order, rank: currentRank++ });
          processedOrderIds.add(orderId);
        }
      }
      groupedByCenter.set(wcId, finalSequence);
    }
    return groupedByCenter;
  }

  private static findDependencyGroups(orders: WorkOrder[]): DependencyGroup[] {
    const visited = new Set<string>();
    const groups: DependencyGroup[] = [];
    let groupIdCounter = 0;

    for (const order of orders) {
      if (visited.has(order.docId)) continue;

      // Simple DFS to find connected components (all parents and children)
      const groupIds: string[] = [];
      const stack = [order.docId];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        groupIds.push(id);

        const currentOrder = orders.find((o) => o.docId === id)!;
        // Relatives: anyone I depend on OR anyone who depends on me
        const relatives = orders.filter(
          (o) =>
            currentOrder.data.dependsOnWorkOrderIds.includes(o.docId) ||
            o.data.dependsOnWorkOrderIds.includes(id),
        );
        stack.push(...relatives.map((r) => r.docId));
      }

      // Only treat it as a group if there's an actual dependency
      const hasActualDeps = groupIds.some((id) => {
        const o = orders.find((ord) => ord.docId === id)!;
        return (
          o.data.dependsOnWorkOrderIds.length > 0 ||
          orders.some((other) => other.data.dependsOnWorkOrderIds.includes(id))
        );
      });

      if (hasActualDeps) {
        const adjList = new Map<string, string[]>();
        groupIds.forEach((id) => {
          const children = orders
            .filter((o) => o.data.dependsOnWorkOrderIds.includes(id))
            .map((o) => o.docId);
          adjList.set(id, children);
        });

        groups.push({
          groupId: groupIdCounter++,
          orderIds: groupIds,
          adjList,
          topologicalOrdering: [],
          originalAnchor: Math.min(
            ...groupIds.map((id) =>
              DateTime.fromISO(orders.find((o) => o.docId === id)!.data.startDate).toMillis(),
            ),
          ),
        });
      }
    }
    return groups;
  }

  private static topologicalSort(group: DependencyGroup, centerOrders: WorkOrder[]) {
    const result: string[] = [];
    const remainingIds = [...group.orderIds];

    while (remainingIds.length > 0) {
      const nextIdIndex = remainingIds.findIndex((id) => {
        const order = centerOrders.find((o) => o.docId === id)!;
        // Ready if no other order IN THIS GROUP is my parent
        return !remainingIds.some((otherId) => order.data.dependsOnWorkOrderIds.includes(otherId));
      });

      if (nextIdIndex === -1) break; // Circular safety
      result.push(remainingIds.splice(nextIdIndex, 1)[0]);
    }
    group.topologicalOrdering = result;
  }

  private static findOriginalSequenceOrder(orders: WorkOrder[]): OriginalSequencedOrder[] {
    return [...orders]
      .sort((a, b) => {
        const timeA = DateTime.fromISO(a.data.startDate).toMillis();
        const timeB = DateTime.fromISO(b.data.startDate).toMillis();
        return timeA !== timeB ? timeA - timeB : orders.indexOf(a) - orders.indexOf(b);
      })
      .map((order, index, array) => {
        let gap = 0;
        if (index > 0) {
          const prevEnd = DateTime.fromISO(array[index - 1].data.endDate);
          const currentStart = DateTime.fromISO(order.data.startDate);
          gap = Math.max(0, currentStart.diff(prevEnd, 'minutes').minutes);
        }
        return { order, originalRank: index, originalGapMinutes: gap };
      });
  }
}
