# naologic-scheduler

Take Home Assessment for Naologic

# Architecture

- Data generator
- Core Algorithm
  -- reflow.service.ts
  -- constraint-checker.ts
  -- types.ts
  -- sequence-preserver.ts
  -- utils/
- Automated Testing
  -- src/tests
  --- src/tests/constraint-checker.test.ts
  --- src/tests/reflow.test.ts

Constraint Checker servers multiple functions. It serves as both a part of the reflow algorithm as well as a verifier in automated testing. Within the reflow algorithm, it used to first check what the violations are, and it also later helps provides the reasons for changes.

There are certain scenarios of datasets where the schedule has unfixable violations. When this happens, the reflow algorithm errors out instead of running infinitely, so that proper manual review/intervention can be done.

The scope of the cases covered does not include the case of a group of orders that are dependent on each other and also covering multiple data-centers. This scope is an @upgrade to do later.

To handle the scope of this problem, the reflow algorithm groups orders based on work center. For each center, sequence-preserver.ts is used. This logic will topologically sort dependency groups as well as analyze the original sequencing of the orders. After this, it will output a new Sequence of orders that follows the topological sorting of the dependency groups as well as maintain the original sequence of the independent orders.
With this new sequencing, the reflow algorithm goes through it in order, ensuring that the current order happens after the previous order. Since original sequencing is preserved, some orders will have to be shifted despite having no original violation due to earlier orders moving up. The reflow correctly outputs "Cascading..." as the reason for these changes.

# package.json utility scripts

- data:gen:<scenario> for dataset generation
- test:<module/file> for running test suites

# Automated Testing

Workflow: create a dataset using data:gen scripts. Then add a test case to test.ts files utilizing those datasets. If a test fails, there is a debugHelper function to generate json files of new violations and reflowed schedule. These are ignored through .gitignore

Since constraint-checker serves as a way to validate the reflow algorithm in the automated tests for large datasets, there are unit tests for constraint-checker to ensure the tests are actually helpful.

## 🛡️ Constraint Checker Engine

The `ConstraintChecker` is the high-integrity validation core of the scheduling system. It performs a multi-pass audit on reflowed datasets to ensure every Work Order adheres to physical, temporal, and business-logic constraints.

### 🔍 Validation Suite

The engine categorizes issues into **Violations**, distinguishing between adjustable scheduling conflicts and **Fatal** logical errors that require manual data correction.

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
