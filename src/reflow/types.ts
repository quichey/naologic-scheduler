export interface WorkOrder {
  docId: string;
  docType: "workOrder";
  data: {
    workOrderNumber: string;
    manufacturingOrderId: string;
    workCenterId: string;
    startDate: string;              
    endDate: string;                
    durationMinutes: number;        
    isMaintenance: boolean;         // If true, cannot be rescheduled
    dependsOnWorkOrderIds: string[]; // All must complete before this starts
    setupTimeMinutes?: number;      // Bonus: setup time
  };
}

export interface WorkCenter {
  docId: string;
  docType: "workCenter";
  data: {
    name: string;
    shifts: Array<{
      dayOfWeek: number;           // 0-6, Sunday = 0
      startHour: number;           // 0-23
      endHour: number;             // 0-23
    }>;
    maintenanceWindows: Array<{
      startDate: string;           
      endDate: string;             
      reason?: string;             
    }>;
  };
}

export interface ManufacturingOrder {
  docId: string;
  docType: "manufacturingOrder";
  data: {
    manufacturingOrderNumber: string;
    itemId: string;
    quantity: number;
    dueDate: string;               
  };
}

export interface ReflowResult {
  updatedWorkOrders: WorkOrder[];
  changes: Array<{
    workOrderNumber: string;
    oldStartDate: string;
    newStartDate: string;
    delayMinutes: number;
  }>;
  explanation: string;
}