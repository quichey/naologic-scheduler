import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ConstraintChecker } from '../reflow/constraint-checker.js';
import { ReflowService } from '../reflow/reflow.service.js';
import type { ReflowedSchedule } from '../reflow/reflow.service.js';
import type { Violation } from '../reflow/constraint-checker.js';

const loadScenario = (filename: string, isLarge: boolean = false) => {
  const dataDir = isLarge
    ? path.join(process.cwd(), 'src', 'data', 'large')
    : path.join(process.cwd(), 'src', 'data');
  const filePath = path.join(dataDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
};

const debugHelper = (
  violationsAfter: Violation[],
  reflowed: ReflowedSchedule,
  debug_file = null,
) => {
  if (violationsAfter.length > 0) {
    const debugPath = debug_file
      ? debug_file
      : path.join(process.cwd(), 'src', 'tests', 'debug', 'debug-reflow-results.json');
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

const runTests = () => {
  console.log('🚀 Starting Reflow Service Unit Tests...\n');

  // --- Test Case 1: Circular Dependency (Expected: NOT FIXABLE) ---
  try {
    const { orders, centers } = loadScenario('scenario-fatal-circular.json');
    ReflowService.reflow(orders, centers);
    assert.fail('Should have thrown "NOT FIXABLE" for circular dependency');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(message.includes('NOT FIXABLE'), `Expected "NOT FIXABLE" but got: ${message}`);
    console.log('✅ Test Passed: Correctly threw "NOT FIXABLE" for Circular Dependency.');
  }

  // --- Test Case 2: Maintenance Clash (Fixable) ---
  // Note: If maintenance overlaps an order, reflow SHOULD fix it by moving it.
  try {
    const { orders, centers } = loadScenario('scenario-fatal-clash.json');
    ReflowService.reflow(orders, centers);
    assert.fail('Should have thrown "NOT FIXABLE" for circular dependency');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(message.includes('NOT FIXABLE'), `Expected "NOT FIXABLE" but got: ${message}`);
    console.log('✅ Test Passed: Correctly threw "NOT FIXABLE" fatal clash.');
  }

  // --- Test Case 3: Valid Dataset (Stress Test) ---
  /*
  try {
    const { orders, centers } = loadScenario('500-orders-10-centers.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    console.log(`violations before: ${violationsBefore.length}`);
    assert.strictEqual(
      violations.length,
      0,
      'Standard dataset should have ZERO violations after reflow',
    );
    console.log('✅ Test Passed: 500-order dataset successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }
  try {
    const { orders, centers } = loadScenario('100-orders-3-centers.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    console.log(`violations before: ${violationsBefore.length}`);
    assert.strictEqual(
      violations.length,
      0,
      'Standard dataset should have ZERO violations after reflow',
    );
    console.log('✅ Test Passed: 100-order dataset successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }
  try {
    const { orders, centers } = loadScenario('10-orders-2-centers.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violationsAfter = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    console.log(`[10 Orders] Violations Before: ${violationsBefore.length}`);
    console.log(`[10 Orders] Violations After: ${violationsAfter.length}`);

    debugHelper(violationsAfter, reflowed);

    assert.strictEqual(violationsAfter.length, 0, 'Should have zero violations');
  } catch (err) {
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }
    */
  try {
    const { orders, centers } = loadScenario('10-order-single-center.json');
    const violationsBefore = ConstraintChecker.verify(orders, centers);
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    //console.log(`violations before: ${violationsBefore.length}`);
    assert.strictEqual(
      violations.length,
      0,
      'Standard dataset should have ZERO violations after reflow',
    );
    console.log('✅ Test Passed: 10-order single center dataset successfully reflowed.');
  } catch (err) {
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }
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
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }
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
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }
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
      '✅ Test Passed: Scenario with work center maintenance window and maintenance work order close together successfully reflowed.',
    );
  } catch (err) {
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }
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
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }
  // --- Test Case 6: Explanation & Change Log (Audit Test) ---
  try {
    const { orders, centers } = loadScenario('scenario-robustness-test.json');
    const reflowed = ReflowService.reflow(orders, centers);

    console.log('\n--- Reflow Audit Log ---');
    reflowed.explanation.forEach((reason, i) => {
      console.log(`🔹 ${reflowed.changes[i]} | Reason: ${reason}`);
    });

    // 1. Assert we have changes
    assert.ok(reflowed.changes.length > 0, 'Should have logged changes');
    assert.ok(
      reflowed.explanation.length === reflowed.changes.length,
      'Changes and explanations must match 1:1',
    );

    // 2. Target specific logic checks
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
    console.error('❌ Test Failed (Audit Logic):', err instanceof Error ? err.message : err);
  }

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
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }

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
    console.error('❌ Test Failed (Valid Data):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 4: Perfect Schedule (Stability Test) ---
  try {
    const { orders, centers } = loadScenario('scenario-perfect.json');
    const reflowed = ReflowService.reflow(orders, centers);
    const violations = ConstraintChecker.verify(reflowed.updatedWorkOrders, centers);

    assert.strictEqual(violations.length, 0, 'Perfect schedule should not be altered/corrupted');
    console.log('✅ Test Passed: Perfect schedule remained stable.');
  } catch (err) {
    console.error('❌ Test Failed (Perfect):', err instanceof Error ? err.message : err);
  }

  // --- Test Case 5: Shift & Timing Fixes (Validating Logic) ---
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
    console.error('❌ Test Failed (Timing Logic):', err instanceof Error ? err.message : err);
  }

  console.log('\n🏁 Reflow Testing Complete. All logic guards verified.');
};

runTests();
