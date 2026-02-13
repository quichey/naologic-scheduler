import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReflowService } from '../reflow/reflow.service.js';

// Get current directory for relative path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * CLI Wrapper for ReflowService
 * Usage: npx tsx src/scripts/reflow-cli.ts <input_json> [output_json]
 */
const run = () => {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const outputPathArg = args[1];

  if (!inputPath) {
    console.error('❌ Error: Please provide an input JSON file.');
    console.log('Usage: npx tsx src/scripts/reflow-cli.ts <input_path> [output_path]');
    process.exit(1);
  }

  // Default output name based on input filename if not provided
  const inputBasename = path.basename(inputPath, '.json');
  const defaultOutput = path.join(process.cwd(), `${inputBasename}-output.json`);
  const outputPath = outputPathArg ? path.resolve(outputPathArg) : defaultOutput;

  try {
    // 1. Load Data
    const fullInputPath = path.resolve(inputPath);
    if (!fs.existsSync(fullInputPath)) {
      throw new Error(`Input file not found: ${fullInputPath}`);
    }

    const rawData = JSON.parse(fs.readFileSync(fullInputPath, 'utf-8'));
    const { workOrders, workCenters, manufacturingOrders } = rawData.data || rawData;

    console.log(`\n🚀 Initializing Reflow Engine...`);
    console.log(
      `📊 Processing: ${workOrders.length} Work Orders across ${workCenters.length} Centers.`,
    );

    // 2. Execute Reflow
    const startTime = performance.now();
    const result = ReflowService.reflow(workOrders, workCenters);
    const endTime = performance.now();

    // 3. Ensure Output Directory Exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 4. Save Result
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

    // 5. Clean Terminal Summary for your Demo
    console.log('✅ Reflow Complete!');
    console.log('-------------------------------------------');
    console.log(`⏱️  Execution Time: ${(endTime - startTime).toFixed(2)}ms`);
    console.log(`📝 Changes Detected: ${result.changes.length}`);
    console.log(`💾 Results saved to: ${path.relative(process.cwd(), outputPath)}`);
    console.log('-------------------------------------------\n');
  } catch (err) {
    console.error('\n❌ Reflow Engine Error:');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
};

run();
