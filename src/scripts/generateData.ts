import { WorkOrder, WorkCenter, ManufacturingOrder } from '../reflow/types.js';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';

const generateData = (count: number) => {
  // 1. Generate 5 Manufacturing Orders
  const mos: ManufacturingOrder[] = Array.from({ length: 5 }).map((_, i) => ({
    docId: uuidv4(),
    docType: "manufacturingOrder",
    data: {
      manufacturingOrderNumber: `MO-100${i}`,
      itemId: "PVC-PIPE-100",
      quantity: 500,
      dueDate: "2026-03-01T00:00:00Z"
    }
  }));

  // 2. Generate 3 Work Centers (Machines)
  const centers: WorkCenter[] = [
    {
      docId: "wc-1",
      docType: "workCenter",
      data: {
        name: "Extruder A",
        shifts: [{ dayOfWeek: 1, startHour: 8, endHour: 17 }, { dayOfWeek: 2, startHour: 8, endHour: 17 }], // Mon-Tue 8-5
        maintenanceWindows: []
      }
    },
    // Add more centers here...
  ];

  // 3. Generate Thousands of Work Orders
  const orders: WorkOrder[] = [];
  for (let i = 0; i < count; i++) {
    const parent = i > 0 && i % 3 !== 0 ? orders[i - 1] : null; // Create chains of 3
    orders.push({
      docId: uuidv4(),
      docType: "workOrder",
      data: {
        workOrderNumber: `WO-${i}`,
        manufacturingOrderId: mos[i % 5].docId,
        workCenterId: centers[0].docId,
        startDate: "2026-02-09T08:00:00Z",
        endDate: "2026-02-09T10:00:00Z",
        durationMinutes: 120,
        isMaintenance: false,
        dependsOnWorkOrderIds: parent ? [parent.docId] : []
      }
    });
  }

  fs.writeFileSync('sample-data.json', JSON.stringify({ mos, centers, orders }, null, 2));
};

generateData(1000);