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

  /**
   * Scenario: Work Center maintenance window and a maintenance work order close together.
   */
  public static createMaintenanceSandwichScenario(): {
    orders: WorkOrder[];
    centers: WorkCenter[];
  } {
    const centers = this.generateWorkCenters(1);
    const wcId = centers[0].docId;

    // 1. Static Window: 08:00 - 09:00
    centers[0].data.maintenanceWindows = [
      {
        startDate: '2026-02-09T08:00:00Z',
        endDate: '2026-02-09T09:00:00Z',
        reason: 'Static Cleaning',
      },
    ];

    // 2. Maintenance Work Order: 09:00 - 10:00
    const maintOrder = this.createBaseOrder(uuidv4(), wcId);
    maintOrder.data.workOrderNumber = 'MAINT-TASK';
    maintOrder.data.isMaintenance = true;
    maintOrder.data.startDate = '2026-02-09T09:00:00Z';
    maintOrder.data.endDate = '2026-02-09T10:00:00Z';

    // 3. Regular Order: Tries to start at 08:00
    // Reflow should push this all the way to 10:00 AM
    const regularOrder = this.createBaseOrder(uuidv4(), wcId);
    regularOrder.data.workOrderNumber = 'THE-JUMPER';
    regularOrder.data.startDate = '2026-02-09T08:00:00Z';

    return { orders: [maintOrder, regularOrder], centers };
  }

  /**
   * Scenario: Parallel chains across multiple centers.
   * - WC-1: A 3-order chain with a 08:00 AM collision.
   * - WC-2: A 2-order chain starting inside a maintenance window.
   * - WC-3: A single maintenance order (fixed) and a child WO that overlaps it.
   */
  public static createMultiCenterDependencyScenario(): {
    orders: WorkOrder[];
    centers: WorkCenter[];
  } {
    const centers = this.generateWorkCenters(3);
    const mos = this.generateMOs(3);
    const orders: WorkOrder[] = [];

    // --- Center 1: The "Standard" Chain ---
    const wc1 = centers[0].docId;
    const c1_a = this.createBaseOrder(uuidv4(), wc1);
    c1_a.data.workOrderNumber = 'C1-A';
    // Child B depends on A
    const c1_b = this.createBaseOrder(uuidv4(), wc1, [c1_a.docId]);
    c1_b.data.workOrderNumber = 'C1-B';
    // All start at 8am (Violation: Overlap)
    orders.push(c1_a, c1_b);

    // --- Center 2: The "Maintenance Jump" Chain ---
    const wc2 = centers[1].docId;
    centers[1].data.maintenanceWindows = [
      {
        startDate: '2026-02-09T08:00:00Z',
        endDate: '2026-02-09T10:00:00Z',
        reason: 'Morning Calibration',
      },
    ];
    const c2_a = this.createBaseOrder(uuidv4(), wc2);
    c2_a.data.workOrderNumber = 'C2-A';
    c2_a.data.startDate = '2026-02-09T08:00:00Z'; // Violation: Maintenance Collision
    const c2_b = this.createBaseOrder(uuidv4(), wc2, [c2_a.docId]);
    c2_b.data.workOrderNumber = 'C2-B';
    orders.push(c2_a, c2_b);

    // --- Center 3: The "Fixed Maintenance" Constraint ---
    const wc3 = centers[2].docId;
    const c3_maint = this.createBaseOrder(uuidv4(), wc3);
    c3_maint.data.workOrderNumber = 'C3-FIXED';
    c3_maint.data.isMaintenance = true; // CANNOT BE MOVED

    const c3_child = this.createBaseOrder(uuidv4(), wc3, [c3_maint.docId]);
    c3_child.data.workOrderNumber = 'C3-CHILD';
    c3_child.data.startDate = '2026-02-09T08:00:00Z'; // Violation: Overlap with fixed order
    orders.push(c3_maint, c3_child);

    return { orders, centers };
  }

  /**
   * Scenario: Multi-parent dependency (Convergence).
   * WO-C depends on BOTH WO-A and WO-B.
   * Tests if the reflow engine waits for the LATEST parent to finish.
   */
  public static createMultiParentScenario(): { orders: WorkOrder[]; centers: WorkCenter[] } {
    const centers = this.generateWorkCenters(1);
    const wcId = centers[0].docId;

    // Order A: Ends at 10:00 AM
    const orderA = this.createBaseOrder(uuidv4(), wcId);
    orderA.data.workOrderNumber = 'WO-A';
    orderA.data.startDate = '2026-02-09T08:00:00Z';
    orderA.data.endDate = '2026-02-09T10:00:00Z';

    // Order B: Ends at 12:00 PM (The "Bottle-neck" parent)
    const orderB = this.createBaseOrder(uuidv4(), wcId);
    orderB.data.workOrderNumber = 'WO-B';
    orderB.data.startDate = '2026-02-09T08:00:00Z';
    orderB.data.endDate = '2026-02-09T12:00:00Z';

    // Order C: Depends on A AND B.
    // It should be reflowed to start at 12:00 PM (after B), not 10:00 AM (after A).
    const orderC = this.createBaseOrder(uuidv4(), wcId, [orderA.docId, orderB.docId]);
    orderC.data.workOrderNumber = 'WO-C';
    orderC.data.startDate = '2026-02-09T08:00:00Z'; // Overlaps parents intentionally

    return {
      orders: [orderA, orderB, orderC],
      centers,
    };
  }

  /**
   * Scenario: High-density dependency chains on a single center.
   * Useful for testing "Time Walking" and "Maintenance Jumping" logic
   * without cross-center complexity.
   */
  public static createSingleCenterDependencyScenario(orderCount: number): {
    orders: WorkOrder[];
    centers: WorkCenter[];
  } {
    const centers = this.generateWorkCenters(1); // Force only 1 center
    const mos = this.generateMOs(1);
    const wcId = centers[0].docId;
    const orders: WorkOrder[] = [];

    for (let i = 0; i < orderCount; i++) {
      const parent = i > 0 ? orders[i - 1] : null;

      orders.push({
        docId: uuidv4(),
        docType: 'workOrder',
        data: {
          workOrderNumber: `WO-CHAIN-${i}`,
          manufacturingOrderId: mos[0].docId,
          workCenterId: wcId,
          // Start everyone at the exact same second to force reflow to sort them
          startDate: '2026-02-09T08:00:00Z',
          endDate: '2026-02-09T09:00:00Z',
          durationMinutes: 60,
          isMaintenance: false,
          dependsOnWorkOrderIds: parent ? [parent.docId] : [],
        },
      });
    }

    return { orders, centers };
  }

  /**
   * Scenario: An order collides with a Maintenance window.
   */
  public static createOrderCollidesWithMaintenance(): {
    orders: WorkOrder[];
    centers: WorkCenter[];
  } {
    const centers = this.generateWorkCenters(1);

    // Define a maintenance window from 10:00 to 12:00
    centers[0].data.maintenanceWindows = [
      {
        startDate: '2026-02-09T10:00:00Z',
        endDate: '2026-02-09T12:00:00Z',
        reason: 'Emergency Repair',
      },
    ];

    const wcId = centers[0].docId;

    // Create an order that starts at 09:00 and ends at 11:00
    // It collides with the first hour of maintenance
    const order = this.createBaseOrder(uuidv4(), wcId);
    order.data.startDate = '2026-02-09T09:00:00Z';
    order.data.endDate = '2026-02-09T11:00:00Z';
    order.data.durationMinutes = 120;

    return {
      orders: [order],
      centers,
    };
  }
  /**
   * Scenario: Order starts at 06:00 AM, but shift starts at 08:00 AM.
   */
  public static createInvalidStartScenario(): { orders: WorkOrder[]; centers: WorkCenter[] } {
    const centers = this.generateWorkCenters(1);
    const wcId = centers[0].docId;

    const order = this.createBaseOrder(uuidv4(), wcId);
    order.data.startDate = '2026-02-09T06:00:00Z'; // 2 hours before shift
    order.data.endDate = '2026-02-09T09:00:00Z';
    order.data.durationMinutes = 60; // Only 60 mins (08:00-09:00) is valid

    return { orders: [order], centers };
  }

  /**
   * Scenario: Order ends at 07:00 PM, but shift ends at 05:00 PM (17:00).
   */
  public static createInvalidEndScenario(): { orders: WorkOrder[]; centers: WorkCenter[] } {
    const centers = this.generateWorkCenters(1);
    const wcId = centers[0].docId;

    const order = this.createBaseOrder(uuidv4(), wcId);
    order.data.startDate = '2026-02-09T15:00:00Z';
    order.data.endDate = '2026-02-09T19:00:00Z'; // 2 hours after shift
    order.data.durationMinutes = 120; // Only 120 mins (15:00-17:00) is valid

    return { orders: [order], centers };
  }
  /**
   * Scenario: Order is within shift boundaries, but the window is too small.
   * Required: 120m. Provided: 60m.
   */
  public static createInsufficientMinutesScenario(): {
    orders: WorkOrder[];
    centers: WorkCenter[];
  } {
    const centers = this.generateWorkCenters(1);
    const wcId = centers[0].docId;

    const order = this.createBaseOrder(uuidv4(), wcId);
    // Starts at 8am, ends at 9am (60 minute window)
    order.data.startDate = '2026-02-09T08:00:00Z';
    order.data.endDate = '2026-02-09T09:00:00Z';
    // But the order explicitly says it NEEDS 120 minutes to complete
    order.data.durationMinutes = 120;

    return { orders: [order], centers };
  }
  /**
   * Scenario: The Kitchen Sink (Robustness Test)
   * * This scenario validates the engine's ability to resolve multiple
   * overlapping constraints simultaneously across different work centers.
   * * DISTINCT CASES COVERED:
   * 1. THE SANDWICH (WC1):
   * Combines a Static Maintenance Window (08:00-09:00) with a Fixed
   * Maintenance Work Order (09:00-10:00) to create a single 2-hour block.
   * * 2. SHIFT BOUNDARY VIOLATIONS (WC2):
   * Orders are scheduled to start at 06:00 AM, but the Work Center shift
   * does not begin until 08:00 AM.
   * * 3. MULTI-PARENT CONVERGENCE (WC2):
   * Order 'C2-C' depends on both 'C2-A' and 'C2-B'. The engine must
   * delay 'C2-C' until the LATEST parent finishes.
   * * 4. DISJOINT MULTI-CENTER SCHEDULING:
   * Processes two distinct Work Centers in a single pass, ensuring that
   * violations in WC1 do not bleed into or corrupt the logic for WC2.
   */
  public static createComplexRobustnessScenario(): {
    orders: WorkOrder[];
    centers: WorkCenter[];
  } {
    const centers = this.generateWorkCenters(2);
    const wc1 = centers[0].docId; // Machine A
    const wc2 = centers[1].docId; // Machine B

    // --- WORK CENTER 1: THE MAINTENANCE SANDWICH + INTRA-CENTER CHAIN ---
    centers[0].data.maintenanceWindows = [
      {
        startDate: '2026-02-09T08:00:00Z',
        endDate: '2026-02-09T09:00:00Z',
        reason: 'Morning Calibration',
      },
    ];

    const wc1MaintOrder = this.createBaseOrder(uuidv4(), wc1);
    wc1MaintOrder.data.workOrderNumber = 'WC1-FIXED-MAINT';
    wc1MaintOrder.data.isMaintenance = true;
    wc1MaintOrder.data.startDate = '2026-02-09T09:00:00Z';
    wc1MaintOrder.data.endDate = '2026-02-09T10:00:00Z';

    const c1_A = this.createBaseOrder(uuidv4(), wc1);
    c1_A.data.workOrderNumber = 'C1-A';
    c1_A.data.startDate = '2026-02-09T08:00:00Z';
    c1_A.data.durationMinutes = 60;

    const c1_B = this.createBaseOrder(uuidv4(), wc1, [c1_A.docId]);
    c1_B.data.workOrderNumber = 'C1-B';
    c1_B.data.startDate = '2026-02-09T08:00:00Z';

    // --- WORK CENTER 2: SHIFT BOUNDARIES + MULTI-PARENT CONVERGENCE ---
    const c2_A = this.createBaseOrder(uuidv4(), wc2);
    c2_A.data.workOrderNumber = 'C2-A';
    c2_A.data.startDate = '2026-02-09T06:00:00Z'; // 2h before shift
    c2_A.data.durationMinutes = 60;

    const c2_B = this.createBaseOrder(uuidv4(), wc2);
    c2_B.data.workOrderNumber = 'C2-B';
    c2_B.data.startDate = '2026-02-09T06:00:00Z'; // 2h before shift
    c2_B.data.durationMinutes = 120;

    const c2_C = this.createBaseOrder(uuidv4(), wc2, [c2_A.docId, c2_B.docId]);
    c2_C.data.workOrderNumber = 'C2-C-CONVERGE';
    c2_C.data.startDate = '2026-02-09T08:00:00Z';

    return {
      orders: [wc1MaintOrder, c1_A, c1_B, c2_A, c2_B, c2_C],
      centers,
    };
  }
  /**
   * Scenario: A perfectly sequenced schedule.
   * 3 Orders: A -> B -> C, all on the same Work Center, no overlaps.
   */
  public static createPerfectScenario(): { orders: WorkOrder[]; centers: WorkCenter[] } {
    const centers = this.generateWorkCenters(1);
    const wcId = centers[0].docId;

    const orderA = this.createBaseOrder(uuidv4(), wcId);
    orderA.data.startDate = '2026-02-09T08:00:00Z'; // Mon 8am
    orderA.data.endDate = '2026-02-09T10:00:00Z'; // Mon 10am

    const orderB = this.createBaseOrder(uuidv4(), wcId, [orderA.docId]);
    orderB.data.startDate = '2026-02-09T10:00:00Z'; // Mon 10am
    orderB.data.endDate = '2026-02-09T12:00:00Z'; // Mon 12pm

    const orderC = this.createBaseOrder(uuidv4(), wcId, [orderB.docId]);
    orderC.data.startDate = '2026-02-09T13:00:00Z'; // Mon 1pm (after lunch gap)
    orderC.data.endDate = '2026-02-09T15:00:00Z'; // Mon 3pm

    return {
      orders: [orderA, orderB, orderC],
      centers,
    };
  }

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
  } else if (scenarioArg === 'perfect') {
    result = DataGenerator.createPerfectScenario();
    filename = 'scenario-perfect.json';
    console.log('✨ Generating Violation-Free Scenario...');
  } else if (scenarioArg === 'maintenance') {
    // NEW SCENARIO
    result = DataGenerator.createOrderCollidesWithMaintenance();
    filename = 'scenario-maintenance-collision.json';
    console.log('🚧 Generating Maintenance Collision Scenario...');
  } else if (scenarioArg === 'invalid-start') {
    result = DataGenerator.createInvalidStartScenario();
    filename = 'scenario-invalid-start.json';
    console.log('🌅 Generating Invalid Start Scenario...');
  } else if (scenarioArg === 'invalid-end') {
    result = DataGenerator.createInvalidEndScenario();
    filename = 'scenario-invalid-end.json';
    console.log('🌃 Generating Invalid End Scenario...');
  } else if (scenarioArg === 'insufficient-time') {
    // NEW SCENARIO
    result = DataGenerator.createInsufficientMinutesScenario();
    filename = 'scenario-insufficient-time.json';
    console.log('⏳ Generating Insufficient Minutes Scenario...');
  } else if (scenarioArg === 'single-chain') {
    const orderCount = parseInt(args.find((a) => a.startsWith('--orders='))?.split('=')[1] || '10');
    result = DataGenerator.createSingleCenterDependencyScenario(orderCount);
    filename = `${orderCount}-order-single-center.json`;
    console.log(`⛓️ Generating Single Center Chain: ${orderCount} orders on 1 center...`);
  } else if (scenarioArg === 'multi-parent') {
    result = DataGenerator.createMultiParentScenario();
    filename = 'scenario-multi-parent.json';
    console.log('🧬 Generating Multi-Parent Convergence Scenario...');
  } else if (scenarioArg === 'multi-center') {
    result = DataGenerator.createMultiCenterDependencyScenario();
    filename = 'scenario-multi-center.json';
    console.log('🏢 Generating Multi-Center Parallel Chains Scenario...');
  } else if (scenarioArg === 'sandwich') {
    result = DataGenerator.createMaintenanceSandwichScenario();
    filename = 'scenario-sandwich.json';
    console.log('🥪 Generating Maintenance Sandwich (Window + Order) Scenario...');
  } else if (scenarioArg === 'robustness') {
    result = DataGenerator.createComplexRobustnessScenario();
    filename = 'scenario-robustness-test.json';
    console.log('🧪 Generating Complex Robustness Scenario...');
    console.log('   - Testing: Sandwich, Shift Boundaries, Convergence, and Center Isolation.');
  } else {
    // Default: Standard dataset
    const orderCount = parseInt(args[0] || '100');
    const wcCount = parseInt(args[1] || '3');
    result = DataGenerator.createDataset(orderCount, wcCount);
    // TODO: make filename a param
    filename = 'sample-data.json';
    console.log(`✅ Generating standard dataset: ${orderCount} orders, ${wcCount} centers...`);
  }

  fs.writeFileSync(path.join(outputDir, filename), JSON.stringify(result, null, 2));
  console.log(`💾 Saved to src/data/${filename}`);
};

run();
