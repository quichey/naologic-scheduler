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
