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

    const fatal = violations.find((v) => v.isFatal && v.type === 'OVERLAP');
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

  console.log('\n🏁 All tests completed.');
};

runTests();
