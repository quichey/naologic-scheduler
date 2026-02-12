# 🚀 naologic-scheduler

Take Home Assessment for Naologic. A high-performance manufacturing scheduling engine designed to reflow work orders while adhering to complex temporal, resource, and maintenance constraints.

## 🏗️ Architecture

The system is built with a modular approach to ensure that constraints can be validated both during the reflow process and as a standalone audit for automated testing.

- **Data Generator:** Scripts to create various manufacturing scenarios and stress-test datasets.
- **Core Algorithm:**
  - `reflow.service.ts`: Orchestrates the rescheduling of work orders. It utilizes a "Detect and Repair" loop.
  - `constraint-checker.ts`: The source of truth for schedule integrity; serves as both a sub-module of reflow and a standalone validator.
  - `sequence-preserver.ts`: Implements topological sorting to ensure dependency chains are respected while maintaining original order sequences.
  - `types.ts`: Centralized TypeScript interfaces for Work Orders, Centers, and Violations.
  - `utils/`: Includes `date-utils.ts` for UTC-safe interval math and shift boundary validation.
- **Automated Testing:** Located in `src/tests/`, covering both individual constraints and full reflow integration.

---

## ⚙️ Reflow Logic & "Cascading" Shifts

To handle the complexity of manufacturing, the algorithm groups orders by **Work Center**.

### Sequence Preservation

For each center, `sequence-preserver.ts` is used to:

1. **Topological Sort:** Analyze dependency groups to ensure parent tasks always precede children.
2. **Relative Sequencing:** Maintain the original relative sequence of independent orders to minimize schedule churn.
3. **The "Cascade" Effect:** The algorithm iterates through the new sequence, ensuring each order starts after its predecessor. If an order is shifted solely because its predecessor moved, the system flags the reason as **"Cascading"**, providing clear traceability.

### Maintenance & Fixed Orders

**Constraint Question:** _If a maintenance work order cannot be moved, what if its duration is longer than a shift?_
**Decision:** Maintenance Work Orders are treated as critical events that proceed even outside of regular Work Center shifts. They are "fixed" in time and the algorithm will move regular production orders around them.

### Safety Rails

If the engine detects a scenario that is mathematically impossible to resolve (e.g., circular dependencies or overlapping fixed maintenance), it exits with a **Fatal Error** to allow for manual intervention.

---

## 🛡️ Constraint Checker Engine

The `ConstraintChecker` performs a multi-pass audit on reflowed datasets to ensure every Work Order adheres to physical and business-logic constraints.

### 🔍 Validation Suite

| Constraint Type           | Description                                                                                              | Severity  |
| :------------------------ | :------------------------------------------------------------------------------------------------------- | :-------- |
| **OVERLAP**               | Ensures a Work Center only handles one Work Order at a time.                                             | Warning   |
| **OUTSIDE_SHIFT**         | Validates that work occurs strictly within active Work Center shifts using UTC-safe boundary logic.      | Warning   |
| **MAINTENANCE_COLLISION** | Detects if a standard Work Order overlaps with a resource blackout/maintenance window.                   | Warning   |
| **DEPENDENCY_ERROR**      | Validates "Finish-to-Start" logic; child orders cannot start before parents finish.                      | Warning   |
| **FIXED_ORDER_MOVED**     | Alerts if an immutable "Fixed" Maintenance Order was shifted from its original slot.                     | Warning   |
| **FATAL: CIRCULAR DEP**   | Detects infinite loops in the dependency graph (e.g., A → B → A).                                        | **Fatal** |
| **FATAL: MAINT OVERLAP**  | Detects overlapping fixed maintenance windows on the same resource which cannot be resolved by shifting. | **Fatal** |

### 🛠️ Key Architectural Features

- **Temporal Precision:** Leverages `Luxon` and `Interval` math to prevent timezone "drift" across global work centers.
- **Shift Boundary Handling:** Implements specialized `isTimeInShift` logic to handle "on-the-hour" hand-offs (e.g., an order ending exactly at 08:00 when a shift begins).
- **Performance at Scale:** Optimized for large-scale datasets (170k+ records) utilizing Work Center grouping and O(n log n) sorting.

---

## 🧪 Automated Testing & Debugging

The project emphasizes a data-driven testing workflow:

1. **Generation:** Create scenarios using `npm run data:gen:<scenario>`.
2. **Execution:** Run targeted suites via `npm run test:<file>`.
3. **Debug Helpers:** If a test fails, a local `debugHelper` function generates JSON snapshots of the violations and the reflowed schedule. These are ignored via `.gitignore`.

### Package Utility Scripts

- `data:gen:<scenario>`: Generate specific datasets.
- `test:<module/file>`: Run specific test suites (e.g., `npm run test:reflow`).

---

## 📈 Roadmap & Upgrades

- [ ] **Cross-Center Dependencies:** Support for dependency chains that span multiple work centers.
- [ ] **Multi-Resource Work Orders:** Logic for tasks requiring multiple work centers simultaneously.
