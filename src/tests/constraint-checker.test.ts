import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ConstraintChecker } from '../reflow/constraint-checker.js';

/**
 * Loads a generated manufacturing scenario from the local filesystem.
 * * @param filename - The name of the JSON file located in src/data/
 * @returns The parsed Manufacturing dataset (orders and centers).
 * @throws Will throw an error if the file is missing or contains invalid JSON.
 */
const loadScenario = (filename: string) => {
  const filePath = path.join(process.cwd(), 'src', 'data', filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
};

/**
 * Main Test Runner for the ConstraintChecker module.
 * Executes a series of integration tests using pre-generated JSON scenarios
 * to validate that the engine correctly identifies both fatal and non-fatal violations.
 */
const runTests = () => {
  console.log('🚀 Starting ConstraintChecker Unit Tests...\n');

  // --- Test Case 1: Circular Dependency ---
  // Logic: Verify that a dependency loop (A -> B -> A) is flagged as a FATAL error.
  // This prevents the Reflow engine from entering an infinite recursion.
  try {
    const { orders, centers } = loadScenario('scenario-fatal-circular.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const fatal = violations.find((v) => v.isFatal && v.type === 'DEPENDENCY_ERROR');
    assert.ok(fatal, 'Scenario should have a fatal dependency error');
    console.log('✅ Test Passed: Circular Dependency detected.');
  } catch (err) {
    if (err instanceof Error) {
      console.error('❌ Test Failed (Circular):', err.message);
    } else {
      console.error('❌ An unknown error occurred:', err);
    }
  }

  // --- Test Case 2: Maintenance Clash ---
  // Logic: Fixed maintenance orders that overlap are unfixable.
  // The engine must flag this as FATAL because it cannot move either block.
  try {
    const { orders, centers } = loadScenario('scenario-fatal-clash.json');
    const violations = ConstraintChecker.verify(orders, centers);

    const fatal = violations.find((v) => v.isFatal && v.type === 'MAINTENANCE_COLLISION');
    assert.ok(fatal, 'Scenario should have a fatal overlap error (Maintenance)');
    console.log('✅ Test Passed: Maintenance Clash detected.');
  } catch (err) {
    if (err instanceof Error) {
      console.error('❌ Test Failed (Clash):', err.message);
    } else {
      console.error('❌ An unknown error occurred:', err);
    }
  }

  // --- Test Case 3: Valid Dataset ---
  // Logic: A large-scale standard dataset should yield zero FATAL errors,
  // although it may contain resolvable non-fatal warnings.
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
  // Logic: Validates the "Happy Path." A perfectly sequenced schedule should
  // result in an empty violation array.
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
  // Logic: Tests detection of production orders scheduled during static downtime.
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
  // Logic: Validates temporal boundary checks (Order start < Shift start).
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
  // Logic: Validates temporal boundary checks (Order end > Shift end).
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
  // Logic: Checks that the 'durationMinutes' metadata is physically achievable
  // within the start/end timestamps provided.
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

// Execute the test runner
runTests();
