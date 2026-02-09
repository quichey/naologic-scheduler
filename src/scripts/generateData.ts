import { v4 as uuidv4 } from 'uuid';
import type { WorkOrder, WorkCenter, ManufacturingOrder } from '../reflow/types.js';
import * as fs from 'fs';
import * as path from 'path';

export class DataGenerator {
  // 1. Reusable: Passing parameters instead of hardcoding
  public static createDataset(orderCount: number, wcCount: number = 3) {
    const mos = this.generateMOs(5);
    const centers = this.generateWorkCenters(wcCount);
    const orders = this.generateWorkOrders(orderCount, mos, centers);

    return { mos, centers, orders };
  }

  // Inside DataGenerator class...

  /**
   * Scenario: Two Maintenance (fixed) orders overlap.
   * This is GUARANTEED not fixable because fixed orders cannot be moved.
   */
  public static createMaintenanceClashScenario(): { orders: WorkOrder[]; centers: WorkCenter[] } {
    const centers = this.generateWorkCenters(1);
    const wcId = centers[0].docId;

    const orders: WorkOrder[] = [
      {
        ...this.createBaseOrder(uuidv4(), wcId),
        data: { ...this.createBaseOrder(uuidv4(), wcId).data, isMaintenance: true },
      },
      {
        ...this.createBaseOrder(uuidv4(), wcId),
        data: {
          ...this.createBaseOrder(uuidv4(), wcId).data,
          isMaintenance: true,
          startDate: '2026-02-09T09:00:00Z', // Overlaps with the one above
        },
      },
    ];

    return { orders, centers };
  }

  private static generateWorkCenters(count: number): WorkCenter[] {
    return Array.from({ length: count }).map((_, i) => ({
      docId: `wc-${i + 1}`,
      docType: 'workCenter',
      data: {
        name: `Machine ${String.fromCharCode(65 + i)}`,
        shifts: [
          { dayOfWeek: 1, startHour: 8, endHour: 17 }, // Mon
          { dayOfWeek: 2, startHour: 8, endHour: 17 }, // Tue
        ],
        maintenanceWindows: [],
      },
    }));
  }

  // 3. Scenario Logic: Guaranteed Unfixable (Circular)
  public static createCircularScenario(): { orders: WorkOrder[]; centers: WorkCenter[] } {
    const centers = this.generateWorkCenters(1);
    const idA = uuidv4();
    const idB = uuidv4();

    const orders: WorkOrder[] = [
      this.createBaseOrder(idA, 'wc-1', [idB]), // A depends on B
      this.createBaseOrder(idB, 'wc-1', [idA]), // B depends on A
    ];

    return { orders, centers };
  }

  // Helper to keep code DRY
  private static createBaseOrder(id: string, wcId: string, deps: string[] = []): WorkOrder {
    return {
      docId: id,
      docType: 'workOrder',
      data: {
        workOrderNumber: `WO-${id.substring(0, 4)}`,
        manufacturingOrderId: 'mo-1',
        workCenterId: wcId,
        startDate: '2026-02-09T08:00:00Z',
        endDate: '2026-02-09T10:00:00Z',
        durationMinutes: 120,
        isMaintenance: false,
        dependsOnWorkOrderIds: deps,
      },
    };
  }

  private static generateMOs(count: number): ManufacturingOrder[] {
    return Array.from({ length: count }).map((_, i) => ({
      docId: uuidv4(),
      docType: 'manufacturingOrder',
      data: {
        manufacturingOrderNumber: `MO-100${i}`,
        itemId: `ITEM-${100 + i}`,
        quantity: Math.floor(Math.random() * 1000) + 100,
        dueDate: '2026-03-01T00:00:00Z',
      },
    }));
  }

  private static generateWorkOrders(
    count: number,
    mos: ManufacturingOrder[],
    centers: WorkCenter[],
  ): WorkOrder[] {
    const orders: WorkOrder[] = [];

    for (let i = 0; i < count; i++) {
      // Create chains: Every 3rd order starts a new chain (no parent)
      // Others depend on the order immediately preceding them
      const parent = i % 3 !== 0 && i > 0 ? orders[i - 1] : null;

      // Rotate through Work Centers and MOs to ensure distribution
      const targetWC = centers[i % centers.length];
      const targetMO = mos[i % mos.length];

      orders.push({
        docId: uuidv4(),
        docType: 'workOrder',
        data: {
          workOrderNumber: `WO-${i}`,
          manufacturingOrderId: targetMO.docId,
          workCenterId: targetWC.docId,
          // Start everyone at the same time to force the Reflow engine to work!
          startDate: '2026-02-09T08:00:00Z',
          endDate: '2026-02-09T10:00:00Z',
          durationMinutes: 120,
          isMaintenance: false,
          dependsOnWorkOrderIds: parent ? [parent.docId] : [],
        },
      });
    }
    return orders;
  }
}

const run = () => {
  const args = process.argv.slice(2);
  const scenarioArg = args.find((a) => a.startsWith('--scenario='))?.split('=')[1];

  const outputDir = path.join(process.cwd(), 'src', 'data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let result: any;
  let filename: string;

  if (scenarioArg === 'clash') {
    result = DataGenerator.createMaintenanceClashScenario();
    filename = 'scenario-fatal-clash.json';
    console.log('⚠️ Generating Maintenance Clash Scenario...');
  } else if (scenarioArg === 'circular') {
    result = DataGenerator.createCircularScenario();
    filename = 'scenario-fatal-circular.json';
    console.log('⚠️ Generating Circular Dependency Scenario...');
  } else {
    // Default: Standard dataset
    const orderCount = parseInt(args[0] || '100');
    const wcCount = parseInt(args[1] || '3');
    result = DataGenerator.createDataset(orderCount, wcCount);
    filename = 'sample-data.json';
    console.log(`✅ Generating standard dataset: ${orderCount} orders, ${wcCount} centers...`);
  }

  fs.writeFileSync(path.join(outputDir, filename), JSON.stringify(result, null, 2));
  console.log(`💾 Saved to src/data/${filename}`);
};

run();
