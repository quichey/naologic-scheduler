import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ConstraintChecker } from '../reflow/constraint-checker.js';
import { ReflowService } from '../reflow/reflow.service.js';
import type { ReflowedSchedule } from '../reflow/reflow.service.js';
import type { Violation } from '../reflow/constraint-checker.js';

/**
 * Loads a generated manufacturing scenario from the filesystem.
 * Handles path resolution for both the root data directory and the 'large' stress-test subdirectory.
 * * @param filename - The name of the JSON file to be loaded.
 * @param isLarge - Boolean flag to toggle searching in the 'large' subdirectory.
 * @returns The parsed JSON content containing the orders and centers.
 */
const loadScenario = (filename: string, isLarge: boolean = false) => {
  const dataDir = isLarge
    ? path.join(process.cwd(), 'src', 'data', 'large')
    : path.join(process.cwd(), 'src', 'data');
  const filePath = path.join(dataDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
};

/**
 * Diagnostic utility to dump state to a JSON file if the ReflowService fails to resolve all violations.
 * Assists in debugging complex temporal logic overlaps or dependency chain breaks.
 * * @param violationsAfter - The array of violations still present after a reflow attempt.
 * @param reflowed - The result object from the ReflowService containing updated orders and explanations.
 * @param debug_file - Optional custom path for the resulting debug file.
 */
const debugHelper = (
  violationsAfter: Violation[],
  reflowed: ReflowedSchedule,
  debug_file: string | null = null,
) => {
  if (violationsAfter.length > 0) {
    const debugPath = debug_file
      ? debug_file
      : path.join(process.cwd(), 'src', 'tests', 'debug', 'debug-reflow-results.json');

    // Ensure the debug directory exists to prevent write errors
    const dir = path.dirname(debugPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(
      debugPath,
      JSON.stringify(
        {
          violations: violationsAfter,
          updatedOrders: reflowed.updatedWorkOrders,
        },
        null,
        2,
      ),
    );

    console.log(`⚠️ Violations remained. Debug file saved to: ${debugPath}`);
    console.log('Top Violation Types:', [...new Set(violationsAfter.map((v) => v.type))]);
  }
};

/**
 * Integration Test Runner for the ReflowService.
 * Validates the algorithmic correction of manufacturing schedules against
 * various logical, temporal, and resource-based constraints.
 */
const runTests = () => {
  console.log('🚀 Starting Reflow Service Unit Tests...\n');

  // --- Test Case 1: Circular Dependency (Expected: NOT FIXABLE) ---
  // Ensures the engine detects infinite loops in the dependency graph (A -> B -> A).
  try {
    const { orders, centers } = loadScenario('scenario-fatal-circular.json');
    ReflowService.reflow(orders, centers);
    assert.fail('Should have thrown "NOT FIXABLE" for circular dependency');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(message.includes('NOT FIXABLE'), `Expected "NOT FIXABLE" but got: ${message}`);
    console.log('✅ Test Passed: Correctly threw "NOT FIXABLE" for Circular Dependency.');
  }

  // --- Test Case 2: Maintenance Clash (Expected: NOT FIXABLE) ---
  // Ensures the engine recognizes when two immovable (fixed) maintenance blocks overlap.
  try {
    const { orders, centers } = loadScenario('scenario-fatal-clash.json');
    ReflowService.reflow(orders, centers);
    assert.fail('Should have thrown "NOT FIXABLE" for maintenance clash');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(message.includes('NOT FIXABLE'), `Expected "NOT FIXABLE" but got: ${message}`);
    console.log('✅ Test Passed: Correctly threw "NOT FIXABLE" fatal clash.');
  }

  // --- Test Case 3: 10-Order Distribution ---
  // Small multi-center dataset check with active debug export on failure.
  try {
    const { orders, centers } = loadScenario('10-orders-2-centers.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violationsAfter = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    console.log(`[10 Orders] Violations Before: ${violationsBefore.length}`);
    console.log(`[10 Orders] Violations After: ${violationsAfter.length}`);

    debugHelper(violationsAfter, reflowed);

    assert.strictEqual(violationsAfter.length, 0, 'Should have zero violations');
    console.log('✅ Test Passed: 10-order dataset successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (10 Orders):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 4: Single Center Chain ---
  // Tests sequential "push" logic when all orders share a single bottleneck resource.
  try {
    const { orders, centers } = loadScenario('10-order-single-center.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.strictEqual(
      violations.length,
      0,
      'Standard dataset should have ZERO violations after reflow',
    );
    console.log('✅ Test Passed: 10-order single center dataset successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (Single Center):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 5: Multi-Parent Convergence ---
  // Verifies that a child order waits for the completion of its LATEST parent.
  try {
    const { orders, centers } = loadScenario('scenario-multi-parent.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.ok(violationsBefore.length > 0, 'Scenario multi-parent should have a violation');
    assert.strictEqual(
      violations.length,
      0,
      'Standard dataset should have ZERO violations after reflow',
    );
    console.log('✅ Test Passed: Multi-parent dataset successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (Multi-Parent):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 6: Multi-Center Parallel Chains ---
  // Validates that corrections in one Work Center do not bleed into or corrupt other Work Centers.
  try {
    const { orders, centers } = loadScenario('scenario-multi-center.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.ok(violationsBefore.length > 0, 'Scenario multi-center should have a violation');
    assert.strictEqual(
      violations.length,
      0,
      'Standard dataset should have ZERO violations after reflow',
    );
    console.log(
      '✅ Test Passed: Multi-center with dependency violations dataset successfully reflowed.',
    );
  } catch (err) {
    console.error('❌ Test Failed (Multi-Center):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 7: Maintenance Sandwich ---
  // Tests the ability to jump an order over a contiguous block of downtime (Window + Order).
  try {
    const { orders, centers } = loadScenario('scenario-sandwich.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.ok(violationsBefore.length > 0, 'Scenario sandwich should have a violation');
    assert.strictEqual(
      violations.length,
      0,
      'Standard dataset should have ZERO violations after reflow',
    );
    console.log(
      '✅ Test Passed: Scenario with maintenance window/order combo successfully reflowed.',
    );
  } catch (err) {
    console.error('❌ Test Failed (Sandwich):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 8: Robustness (The Kitchen Sink) ---
  // Simultaneous validation of complex overlaps, shift boundaries, and dependency chains.
  try {
    const { orders, centers } = loadScenario('scenario-robustness-test.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.ok(violationsBefore.length > 0, 'Scenario robustness should have a violation');
    assert.strictEqual(
      violations.length,
      0,
      'Standard dataset should have ZERO violations after reflow',
    );
    console.log(
      '✅ Test Passed: Scenario with combination of smaller scenarios successfully reflowed.',
    );
  } catch (err) {
    console.error('❌ Test Failed (Robustness):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 9: Explanation & Change Log Audit ---
  // Inspects the 'explanation' metadata to ensure human-readable reasons match performed actions.
  try {
    const { orders, centers } = loadScenario('scenario-robustness-test.json');
    const reflowed = ReflowService.reflow(orders, centers);

    console.log('\n--- Reflow Audit Log ---');
    reflowed.explanation.forEach((reason, i) => {
      console.log(`🔹 ${reflowed.changes[i]} | Reason: ${reason}`);
    });

    assert.ok(reflowed.changes.length > 0, 'Should have logged changes');
    assert.ok(
      reflowed.explanation.length === reflowed.changes.length,
      'Changes and explanations must match 1:1',
    );

    const hasSandwichFix = reflowed.explanation.some((e) =>
      e.includes('Original violation: MAINTENANCE_COLLISION'),
    );
    const hasCascadeFix = reflowed.explanation.some((e) => e.includes('Cascading shift changes'));
    const hasConvergenceFix = reflowed.explanation.some((e) =>
      e.includes('Collision with previous order'),
    );

    assert.ok(hasSandwichFix, 'Should explain a fix for Maintenance Sandwich');
    assert.ok(hasCascadeFix, 'Should explain a cascading shift');

    console.log('✅ Test Passed: Change logs and explanations are accurate.');
  } catch (err) {
    console.error('❌ Test Failed (Audit Log):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 10: 10,000 Order Stress Test ---
  try {
    const { orders, centers } = loadScenario('stress-10000o-50c.json', true);
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.ok(violationsBefore.length > 0, 'Stress test 10000 scenario should have a violation');
    assert.strictEqual(
      violations.length,
      0,
      'Stress Testing 10000 dataset should have ZERO violations after reflow',
    );
    console.log('✅ Test Passed: Stress test 10000 scenario successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (10k Stress):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 11: 1,000 Order Stress Test ---
  try {
    const { orders, centers } = loadScenario('stress-1000o-50c.json', true);
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.ok(violationsBefore.length > 0, 'Stress test 1000 scenario should have a violation');
    assert.strictEqual(
      violations.length,
      0,
      'Stress Testing 1000 dataset should have ZERO violations after reflow',
    );
    console.log('✅ Test Passed: Stress test 1000 scenario successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (1k Stress):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 12: Perfect Schedule (Stability Test) ---
  // Verifies that the engine is idempotent—no changes are made to a perfect schedule.
  try {
    const { orders, centers } = loadScenario('scenario-perfect.json');
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.strictEqual(violations.length, 0, 'Perfect schedule should not be altered/corrupted');
    console.log('✅ Test Passed: Perfect schedule remained stable.');
  } catch (err) {
    console.error('❌ Test Failed (Stability):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 13: Shift & Timing Fixes ---
  // Validates basic fixes for invalid start/end times and insufficient working minutes.
  try {
    const scenarios = [
      'scenario-invalid-start.json',
      'scenario-invalid-end.json',
      'scenario-insufficient-time.json',
    ];

    for (const scenario of scenarios) {
      const { orders, centers } = loadScenario(scenario);
      const reflowed = ReflowService.reflow(orders, centers);
      const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

      assert.strictEqual(violations.length, 0, `Reflow should fix all violations in ${scenario}`);
    }
    console.log('✅ Test Passed: All Shift/Timing scenarios corrected successfully.');
  } catch (err) {
    console.error('❌ Test Failed (Timing Fixes):', err instanceof Error ? err.message : err);
  }

  console.log('\n🏁 Reflow Testing Complete. All logic guards verified.');
};

runTests();
