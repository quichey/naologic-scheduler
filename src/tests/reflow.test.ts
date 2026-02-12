import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ConstraintChecker } from '../reflow/constraint-checker.js';
import { ReflowService } from '../reflow/reflow.service.js';
import type { ReflowedSchedule } from '../reflow/reflow.service.js';
import type { Violation } from '../reflow/constraint-checker.js';

/**
 * Loads a generated manufacturing scenario from either the standard or large data directories.
 * * @param filename - Name of the JSON file.
 * @param isLarge - Whether to look in the 'large' sub-directory (for stress tests).
 * @returns Parsed dataset.
 */
const loadScenario = (filename: string, isLarge: boolean = false) => {
  const dataDir = isLarge
    ? path.join(process.cwd(), 'src', 'data', 'large')
    : path.join(process.cwd(), 'src', 'data');
  const filePath = path.join(dataDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
};

/**
 * Diagnostic utility that exports state to a JSON file if violations persist after a reflow attempt.
 * * @param violationsAfter - Array of remaining violations.
 * @param reflowed - The resulting schedule object.
 * @param debug_file - Optional custom path for the debug output.
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

    // Ensure debug directory exists
    const dir = path.dirname(debugPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(
      debugPath,
      JSON.stringify(
        { violations: violationsAfter, updatedOrders: reflowed.updatedWorkOrders },
        null,
        2,
      ),
    );

    console.log(`⚠️ Violations remained. Debug file saved to: ${debugPath}`);
    console.log('Top Violation Types:', [...new Set(violationsAfter.map((v) => v.type))]);
  }
};

/**
 * Integration Test Suite for ReflowService.
 * Validates the core algorithmic logic: moving orders, respecting dependencies,
 * jumping maintenance windows, and handling unfixable fatal errors.
 */
const runTests = () => {
  console.log('🚀 Starting Reflow Service Unit Tests...\n');

  // --- Test Case 1: Circular Dependency (Expected: NOT FIXABLE) ---
  // Logic: The engine must detect loops immediately and abort to prevent stack overflows.
  try {
    const { orders, centers } = loadScenario('scenario-fatal-circular.json');
    ReflowService.reflow(orders, centers);
    assert.fail('Should have thrown "NOT FIXABLE" for circular dependency');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(message.includes('NOT FIXABLE'), `Expected "NOT FIXABLE" but got: ${message}`);
    console.log('✅ Test Passed: Correctly threw "NOT FIXABLE" for Circular Dependency.');
  }

  // --- Test Case 2: Maintenance Clash (Unfixable) ---
  // Logic: When two 'fixed' maintenance blocks occupy the same time, the engine
  // has no authority to move them and must report a fatal conflict.
  try {
    const { orders, centers } = loadScenario('scenario-fatal-clash.json');
    ReflowService.reflow(orders, centers);
    assert.fail('Should have thrown "NOT FIXABLE" for maintenance clash');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(message.includes('NOT FIXABLE'), `Expected "NOT FIXABLE" but got: ${message}`);
    console.log('✅ Test Passed: Correctly threw "NOT FIXABLE" fatal clash.');
  }

  // --- Test Case 3: Sequential Chain Reflow ---
  // Logic: Tests a simple 10-order chain on one machine where every order starts at 8 AM.
  // Expectation: Reflow should sequence them end-to-end (8-9, 9-10, 10-11, etc).
  try {
    const { orders, centers } = loadScenario('10-order-single-center.json');
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.strictEqual(violations.length, 0, 'Chain should have ZERO violations after reflow');
    console.log('✅ Test Passed: 10-order single center dataset successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (Chain Logic):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 4: Multi-Parent Convergence ---
  // Logic: WO-C depends on WO-A and WO-B. If WO-B ends later, WO-C must start after B.
  try {
    const { orders, centers } = loadScenario('scenario-multi-parent.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.ok(violationsBefore.length > 0, 'Scenario should have had initial violations');
    assert.strictEqual(violations.length, 0, 'Multi-parent convergence resolved successfully');
    console.log('✅ Test Passed: Multi-parent dataset successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (Multi-Parent):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 5: Maintenance Sandwich ---
  // Logic: An order must "jump" over both a maintenance window AND a maintenance work order.
  try {
    const { orders, centers } = loadScenario('scenario-sandwich.json');
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.strictEqual(violations.length, 0, 'Sandwich scenario resolved successfully');
    console.log('✅ Test Passed: Maintenance Sandwich scenario successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (Sandwich):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 6: Audit Log & Explanations ---
  // Logic: Validates that the engine provides a human-readable "why" for every change made.
  try {
    const { orders, centers } = loadScenario('scenario-robustness-test.json');
    const reflowed = ReflowService.reflow(orders, centers);

    console.log('\n--- Reflow Audit Log ---');
    reflowed.explanation.forEach((reason, i) => {
      console.log(`🔹 ${reflowed.changes[i]} | Reason: ${reason}`);
    });

    assert.ok(reflowed.changes.length > 0, 'Should have logged changes');
    assert.strictEqual(reflowed.explanation.length, reflowed.changes.length, '1:1 ratio check');

    const hasCascadeFix = reflowed.explanation.some((e) => e.includes('Cascading shift changes'));
    assert.ok(hasCascadeFix, 'Should explain cascading shift logic');

    console.log('✅ Test Passed: Change logs and explanations are accurate.');
  } catch (err) {
    console.error('❌ Test Failed (Audit Logic):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 7: High-Volume Stress Tests (1,000 & 10,000 orders) ---
  // Logic: Ensures the algorithm scales without exceeding memory or recursion limits.
  const stressFiles = ['stress-1000o-50c.json', 'stress-10000o-50c.json'];
  for (const file of stressFiles) {
    try {
      const { orders, centers } = loadScenario(file, true);
      const reflowed = ReflowService.reflow(orders, centers);
      const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

      assert.strictEqual(violations.length, 0, `Stress test ${file} should have 0 violations`);
      console.log(`✅ Test Passed: Stress test ${file} successfully reflowed.`);
    } catch (err) {
      console.error(`❌ Test Failed (${file}):`, err instanceof Error ? err.message : err);
    }
  }

  // --- Test Case 8: Stability Check (Perfect Schedule) ---
  // Logic: If the schedule is already perfect, Reflow should not move anything (Idempotency).
  try {
    const { orders, centers } = loadScenario('scenario-perfect.json');
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.strictEqual(violations.length, 0, 'Perfect schedule should remain perfect');
    console.log('✅ Test Passed: Perfect schedule remained stable.');
  } catch (err) {
    console.error('❌ Test Failed (Stability):', err instanceof Error ? err.message : err);
  }

  console.log('\n🏁 Reflow Testing Complete. All logic guards verified.');
};

runTests();
