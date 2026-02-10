import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ConstraintChecker } from '../reflow/constraint-checker.js';

// Helper to load our generated scenarios
const loadScenario = (filename: string) => {
  const filePath = path.join(process.cwd(), 'src', 'data', filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
};

const runTests = () => {
  console.log('🚀 Starting ConstraintChecker Unit Tests...\n');

  // --- Test Case 1: Circular Dependency ---
  try {
    const { orders, centers } = loadScenario('scenario-fatal-circular.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const fatal = violations.find((v) => v.isFatal && v.type === 'DEPENDENCY_ERROR');
    assert.ok(fatal, 'Scenario 2 should have a fatal dependency error');
    console.log('✅ Test Passed: Circular Dependency detected.');
  } catch (err) {
    if (err instanceof Error) {
      console.error('❌ Test Failed (Circular):', err.message);
    } else {
      console.error('❌ An unknown error occurred:', err);
    }
  }

  // --- Test Case 2: Maintenance Clash ---
  try {
    const { orders, centers } = loadScenario('scenario-fatal-clash.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const fatal = violations.find((v) => v.isFatal && v.type === 'MAINTENANCE_COLLISION');
    assert.ok(fatal, 'Scenario 3 should have a fatal overlap error (Maintenance)');
    console.log('✅ Test Passed: Maintenance Clash detected.');
  } catch (err) {
    if (err instanceof Error) {
      console.error('❌ Test Failed (Clash):', err.message);
    } else {
      console.error('❌ An unknown error occurred:', err);
    }
  }

  // --- Test Case 3: Valid Dataset ---
  try {
    const { orders, centers } = loadScenario('500-orders-10-centers.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const fatals = violations.filter((v) => v.isFatal);
    assert.strictEqual(fatals.length, 0, 'Standard dataset should have NO fatal violations');
    console.log('✅ Test Passed: Standard dataset contains no fatal errors.');
  } catch (err) {
    if (err instanceof Error) {
      console.error('❌ Test Failed (Valid Data):', err.message);
    } else {
      console.error('❌ An unknown error occurred:', err);
    }
  }
  // --- Test Case 4: Perfect Schedule ---
  try {
    const { orders, centers } = loadScenario('scenario-perfect.json');
    const violations = ConstraintChecker.verify(orders, centers);

    assert.strictEqual(
      violations.length,
      0,
      `Expected 0 violations, but found ${violations.length}`,
    );
    console.log('✅ Test Passed: Perfect schedule returned zero violations.');
  } catch (err) {
    if (err instanceof Error) {
      console.error('❌ Test Failed (Perfect):', err.message);
    }
  }
  // --- Test Case 5: Maintenance Window Collision ---
  try {
    const { orders, centers } = loadScenario('scenario-maintenance-collision.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const collision = violations.find((v) => v.type === 'MAINTENANCE_COLLISION');
    assert.ok(collision, 'Should detect overlap with maintenance window');
    console.log('✅ Test Passed: Maintenance Window Collision detected.');
  } catch (err) {
    if (err instanceof Error) console.error('❌ Test Failed (Maintenance):', err.message);
  }

  // --- Test Case 6: Invalid Start (Outside Shift) ---
  try {
    const { orders, centers } = loadScenario('scenario-invalid-start.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const invalidStart = violations.find((v) => v.message.includes('Invalid Start'));
    assert.ok(invalidStart, 'Should detect order starting before shift begins');
    console.log('✅ Test Passed: Invalid Start (Outside Shift) detected.');
  } catch (err) {
    if (err instanceof Error) console.error('❌ Test Failed (Invalid Start):', err.message);
  }

  // --- Test Case 7: Invalid End (Outside Shift) ---
  try {
    const { orders, centers } = loadScenario('scenario-invalid-end.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const invalidEnd = violations.find((v) => v.message.includes('Invalid End'));
    assert.ok(invalidEnd, 'Should detect order ending after shift ends');
    console.log('✅ Test Passed: Invalid End (Outside Shift) detected.');
  } catch (err) {
    if (err instanceof Error) console.error('❌ Test Failed (Invalid End):', err.message);
  }

  // --- Test Case 8: Insufficient Working Minutes ---
  try {
    const { orders, centers } = loadScenario('scenario-insufficient-time.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const mismatch = violations.find((v) => v.message.includes('Total work time mismatch'));
    assert.ok(mismatch, 'Should detect when durationMinutes exceeds actual shift time available');
    console.log('✅ Test Passed: Insufficient Working Minutes detected.');
  } catch (err) {
    if (err instanceof Error) console.error('❌ Test Failed (Insufficient Time):', err.message);
  }
  console.log('\n🏁 All tests completed.');
};

runTests();
