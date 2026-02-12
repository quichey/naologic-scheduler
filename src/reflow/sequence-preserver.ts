import type { WorkOrder } from './types.js';
import { DateTime } from 'luxon';

/**
 * Internal helper to track the original intent during the reflow process.
 */
interface OriginalSequencedOrder {
  order: WorkOrder;
  /** Based on the original chronological startDate order */
  originalRank: number;
  /** Calculated buffer between this order and its immediate predecessor */
  originalGapMinutes: number;
}

/**
 * Represents a cluster of Work Orders tied together by dependency links.
 */
interface DependencyGroup {
  groupId: number;
  /** All Order IDs present in this specific cluster */
  orderIds: string[];
  /** Adjacency List: Map of OrderID -> Array of Child OrderIDs */
  adjList: Map<string, string[]>;
  /** The sequence in which these specific orders must be processed to satisfy dependencies */
  topologicalOrdering: string[];
  /** The earliest original start date in the whole group (used to rank the group itself against others) */
  originalAnchor: number;
}

/**
 * Represents the final flattened order of execution for the reflow engine.
 */
interface NewSequencedOrder {
  order: WorkOrder;
  /** The absolute processing order [0, 1, 2...] for a specific Work Center */
  rank: number;
}

/**
 * SequencePreserver is responsible for transforming a chaotic set of Work Orders
 * into a structured, linear processing queue.
 * * It solves the "Manufacturing Sort" problem:
 * 1. Respect Hard Dependencies (Topological Sort).
 * 2. Preserve Original Intent (Relative Chronological Sort).
 * 3. Group by Resource (Work Center Isolation).
 */
export class SequencePreserver {
  /**
   * Orchestrates the preparation of orders by center.
   * It identifies dependency clusters and interweaves them with independent orders
   * based on their original chronological starting points.
   * * @param orders - The full set of Work Orders to be sequenced.
   * @returns A Map where keys are WorkCenter IDs and values are optimized execution queues.
   */
  public static prepare(orders: WorkOrder[]): Map<string, NewSequencedOrder[]> {
    const groupedByCenter = new Map<string, NewSequencedOrder[]>();
    const wcIds = [...new Set(orders.map((o) => o.data.workCenterId))];

    for (const wcId of wcIds) {
      // Logic Isolation: Maintenance orders are immutable "blackouts" and are
      // evicted from the sequencing logic to let production flow around them.
      const centerOrders = orders.filter(
        (o) => o.data.workCenterId === wcId && !o.data.isMaintenance,
      );

      // Identify groups of orders that 'touch' each other via dependencies (Directed Graphs)
      const dependencyGroups = this.findDependencyGroups(centerOrders);
      // Capture the user's original intended schedule order
      const originalSequence = this.findOriginalSequenceOrder(centerOrders);

      // 1. Sort each dependency group internally using Kahn's Algorithm / DFS principles
      for (const dGroup of dependencyGroups) {
        this.topologicalSort(dGroup, centerOrders);
      }

      // 2. Final Sequencing Logic
      // Strategy: Iterate through original sequence.
      // If we hit an order in a group, process the ENTIRE group immediately.
      // If we hit an independent order, process it as it appears.
      const finalSequence: NewSequencedOrder[] = [];
      const processedOrderIds = new Set<string>();
      let currentRank = 0;

      for (const seqItem of originalSequence) {
        const orderId = seqItem.order.docId;
        if (processedOrderIds.has(orderId)) continue;

        const group = dependencyGroups.find((g) => g.orderIds.includes(orderId));

        if (group) {
          // Priority: Process the entire cluster to ensure parent-child proximity
          for (const id of group.topologicalOrdering) {
            const groupOrder = centerOrders.find((o) => o.docId === id)!;
            finalSequence.push({ order: groupOrder, rank: currentRank++ });
            processedOrderIds.add(id);
          }
        } else {
          // Independent Order: Append it according to its original chronological rank
          finalSequence.push({ order: seqItem.order, rank: currentRank++ });
          processedOrderIds.add(orderId);
        }
      }
      groupedByCenter.set(wcId, finalSequence);
    }
    return groupedByCenter;
  }

  /**
   * Uses Depth-First Search (DFS) to find "Connected Components" in the dependency graph.
   * A group consists of any order that has a parent-child relationship with another.
   * * @private
   */
  private static findDependencyGroups(orders: WorkOrder[]): DependencyGroup[] {
    const visited = new Set<string>();
    const groups: DependencyGroup[] = [];
    let groupIdCounter = 0;

    for (const order of orders) {
      if (visited.has(order.docId)) continue;

      // DFS to crawl through all relatives (parents and children)
      const groupIds: string[] = [];
      const stack = [order.docId];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        groupIds.push(id);

        const currentOrder = orders.find((o) => o.docId === id)!;
        // Bi-directional search: anyone I depend on OR anyone who depends on me
        const relatives = orders.filter(
          (o) =>
            currentOrder.data.dependsOnWorkOrderIds.includes(o.docId) ||
            o.data.dependsOnWorkOrderIds.includes(id),
        );
        stack.push(...relatives.map((r) => r.docId));
      }

      // Optimization: Only treat it as a 'Dependency Group' if there's at least one link.
      // Single, independent orders are handled separately.
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

  /**
   * Sorts a dependency group so that parents always appear before children.
   * This is critical for the Reflow engine to process parent moves before child moves.
   * * @private
   */
  private static topologicalSort(group: DependencyGroup, centerOrders: WorkOrder[]) {
    const result: string[] = [];
    const remainingIds = [...group.orderIds];

    while (remainingIds.length > 0) {
      const nextIdIndex = remainingIds.findIndex((id) => {
        const order = centerOrders.find((o) => o.docId === id)!;
        // An order is "ready" to be scheduled if none of its parents
        // are left in the 'remaining' pool for this group.
        return !remainingIds.some((otherId) => order.data.dependsOnWorkOrderIds.includes(otherId));
      });

      // Safety: If no order is 'ready', we have a circular dependency loop.
      if (nextIdIndex === -1) break;
      result.push(remainingIds.splice(nextIdIndex, 1)[0]);
    }
    group.topologicalOrdering = result;
  }

  /**
   * Captures the state of the schedule before any reflow logic is applied.
   * This allows the algorithm to understand which orders were intended to come first.
   * * @private
   */
  private static findOriginalSequenceOrder(orders: WorkOrder[]): OriginalSequencedOrder[] {
    return [...orders]
      .sort((a, b) => {
        const timeA = DateTime.fromISO(a.data.startDate).toMillis();
        const timeB = DateTime.fromISO(b.data.startDate).toMillis();
        // Secondary sort: use index if timestamps are identical to maintain stability
        return timeA !== timeB ? timeA - timeB : orders.indexOf(a) - orders.indexOf(b);
      })
      .map((order, index, array) => {
        let gap = 0;
        if (index > 0) {
          const prevEnd = DateTime.fromISO(array[index - 1].data.endDate);
          const currentStart = DateTime.fromISO(order.data.startDate);
          // Calculate the original slack/gap between orders
          gap = Math.max(0, currentStart.diff(prevEnd, 'minutes').minutes);
        }
        return { order, originalRank: index, originalGapMinutes: gap };
      });
  }
}
