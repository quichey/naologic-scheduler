# 🚀 Naologic Scheduler

A high-performance manufacturing scheduling engine designed to reflow work orders across multiple work centers while adhering to complex temporal, resource, and maintenance constraints.

## 🏗️ Architecture

The system is built with a modular approach to ensure that constraints can be validated both during the reflow process and as a standalone audit for large datasets.

- **Core Algorithm (`reflow.service.ts`):** Orchestrates the rescheduling of work orders. It utilizes a "Detect and Repair" loop, failing early if fatal violations are discovered.
- **Constraint Checker (`constraint-checker.ts`):** The source of truth for schedule integrity. It serves as both a sub-module of the reflow engine and a standalone validator for automated testing.
- **Sequence Preserver (`sequence-preserver.ts`):** Implements topological sorting to ensure that dependency chains are respected while maintaining the relative original order of independent tasks.
- **Data Utility Hub (`utils/`):** Contains `DateUtils` leveraging `Luxon` for UTC-safe interval math and shift boundary validation.

---

## ⚙️ Reflow Logic & "Cascading" Shifts

To handle complex manufacturing environments, the algorithm groups orders by **Work Center**.

1. **Topological Sequencing:** For each center, dependency groups are sorted. Independent orders maintain their original relative sequence to minimize unnecessary schedule churn.
2. **The "Cascade" Effect:** When an early order is moved (due to a maintenance window or shift change), all subsequent orders in that center’s sequence are evaluated. If an order is shifted solely because its predecessor finished later, the system flags the reason as **"Cascading"**, providing clear traceability for schedule changes.
3. **Safety Rails:** If the engine detects a scenario that is mathematically impossible to resolve (e.g., circular dependencies), it exits with a fatal error to allow for manual intervention rather than entering an infinite loop.

---

## 🛡️ Constraint Checker Engine

The `ConstraintChecker` is the high-integrity validation core of the scheduling system. It performs a multi-pass audit on reflowed datasets to ensure every Work Order adheres to physical, temporal, and business-logic constraints.

### 🔍 Validation Suite

| Constraint Type           | Description                                                                                                         | Severity  |
| :------------------------ | :------------------------------------------------------------------------------------------------------------------ | :-------- |
| **OVERLAP**               | Ensures a Work Center only handles one Work Order at a time.                                                        | Warning   |
| **OUTSIDE_SHIFT**         | Validates that non-maintenance work occurs strictly within active Work Center shifts using UTC-safe boundary logic. | Warning   |
| **MAINTENANCE_COLLISION** | Detects if a standard Work Order is scheduled during a Work Center’s blackout/maintenance window.                   | Warning   |
| **DEPENDENCY_ERROR**      | Validates the "Finish-to-Start" relationship; parent orders must complete before child orders begin.                | Warning   |
| **FIXED_ORDER_MOVED**     | Alerts if a "Fixed" Maintenance Work Order was moved from its original immutable slot.                              | Warning   |
| **FATAL: CIRCULAR DEP**   | Detects infinite loops in the dependency graph (e.g., A → B → A).                                                   | **Fatal** |
| **FATAL: MAINT OVERLAP**  | Detects overlapping fixed maintenance windows on the same resource which cannot be resolved by shifting.            | **Fatal** |

### 🛠️ Key Architectural Features

- **Temporal Precision:** Leverages `Luxon` and `Interval` math to prevent timezone "drift" from invalidating shift boundaries across global work centers.
- **Shift Boundary Handling:** Implements specialized `isTimeInShift` logic to correctly handle "on-the-hour" edge cases (e.g., an order ending exactly at 08:00 when a shift begins).
- **Graph Analysis:** Utilizes Depth-First Search (DFS) with recursion stack tracking to identify circular dependencies in complex manufacturing orders.
- **Performance at Scale:** Optimized for large-scale datasets (170k+ records) by utilizing Work Center grouping and O(n log n) sorting strategies before validation.

### 🚦 Data Structure

The checker returns a standardized array of violations, allowing the UI or the Reflow algorithm to react accordingly:

```typescript
export interface Violation {
  orderId: string;
  type:
    | 'OVERLAP'
    | 'OUTSIDE_SHIFT'
    | 'MAINTENANCE_COLLISION'
    | 'DEPENDENCY_ERROR'
    | 'FIXED_ORDER_MOVED';
  message: string;
  isFatal: boolean; // True if the algorithm cannot resolve this automatically
}
```
