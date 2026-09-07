// bench.mjs
// Benchmark utility for Toolhub
// Sends customizable parallel requests and prints latency distribution.

import readline from "node:readline";
import process from "node:process";
import { performance } from "node:perf_hooks";

// Sample queries ranging from short keywords to descriptive sentences
const DICTIONARY = [
  "git", 
  "github", 
  "database", 
  "postgres", 
  "read file", 
  "run command",
  "web page", 
  "search repositories", 
  "mcp server", 
  "sqlite",
  "openai", 
  "claude",
  "google search", 
  "calculator", 
  "filesystem", 
  "http client",
  "kostenloser server zum durchsuchen von github-repositories",
  "mcp für datenbankabfragen", 
  "tool for managing pull requests",
  "server, der webseiten lesen und zusammenfassen kann"
];

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

async function main() {
  console.log(`${colors.cyan}${colors.bold}=============================================`);
  console.log(" Toolhub Benchmark Utility ");
  console.log(`=============================================${colors.reset}\n`);

  // Parse command line args
  let durationSec = parseInt(process.argv.find(a => a.startsWith("--duration="))?.split("=")[1] || "0", 10);
  let concurrency = parseInt(process.argv.find(a => a.startsWith("--concurrency="))?.split("=")[1] || "0", 10);
  let targetUrl = process.argv.find(a => a.startsWith("--url="))?.split("=")[1] || "http://localhost:7600/search";
  
  // Interactive fallback
  if (!durationSec) {
    const ans = await askQuestion(`${colors.yellow}Enter test duration in seconds (default: 10): ${colors.reset}`);
    durationSec = parseInt(ans, 10) || 10;
  }
  if (!concurrency) {
    const ans = await askQuestion(`${colors.yellow}Enter concurrency level (parallel requests) (default: 5): ${colors.reset}`);
    concurrency = parseInt(ans, 10) || 5;
  }

  console.log(`\n${colors.cyan}Target URL:     ${colors.reset}${targetUrl}`);
  console.log(`${colors.cyan}Duration:       ${colors.reset}${durationSec} seconds`);
  console.log(`${colors.cyan}Concurrency:    ${colors.reset}${concurrency} workers`);
  console.log(`${colors.gray}Starting benchmark in 1 second...${colors.reset}\n`);

  await new Promise(r => setTimeout(r, 1000));

  const latencies = [];
  let totalRequests = 0;
  let successRequests = 0;
  let errorRequests = 0;
  
  const startTime = performance.now();
  const endTime = startTime + (durationSec * 1000);
  let stopBenchmark = false;

  // Worker loop
  const runWorker = async () => {
    while (performance.now() < endTime && !stopBenchmark) {
      // Pick a random query
      const query = DICTIONARY[Math.floor(Math.random() * DICTIONARY.length)];
      const url = `${targetUrl}?q=${encodeURIComponent(query)}`;

      const t0 = performance.now();
      try {
        totalRequests++;
        const res = await fetch(url);
        const t1 = performance.now();
        
        latencies.push(t1 - t0);
        if (res.status === 200) {
          successRequests++;
        } else {
          errorRequests++;
        }
      } catch (err) {
        errorRequests++;
      }
    }
  };

  // Launch parallel workers
  const workers = Array.from({ length: concurrency }, runWorker);
  
  // Progress tracker
  const progressTimer = setInterval(() => {
    const elapsed = (performance.now() - startTime) / 1000;
    const progress = Math.min(100, (elapsed / durationSec) * 1000 * 100);
    const rps = (totalRequests / elapsed).toFixed(1);
    process.stdout.write(`\r${colors.cyan}Progress: ${progress.toFixed(0)}% | Requests: ${totalRequests} | Current RPS: ${rps}${colors.reset}`);
  }, 200);

  // Wait for all workers to finish
  await Promise.all(workers);
  clearInterval(progressTimer);
  
  const totalDuration = (performance.now() - startTime) / 1000;
  stopBenchmark = true;

  console.log("\n\n" + colors.green + colors.bold + "=============================================");
  console.log(" Benchmark Results ");
  console.log("=============================================" + colors.reset);

  if (latencies.length === 0) {
    console.log(`${colors.red}No requests completed successfully.${colors.reset}`);
    return;
  }

  // Calculate statistics
  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avg = sum / total;
  const min = latencies[0];
  const max = latencies[latencies.length - 1];
  
  const p50 = latencies[Math.floor(total * 0.50)];
  const p90 = latencies[Math.floor(total * 0.90)];
  const p99 = latencies[Math.floor(total * 0.99)];
  
  const rps = (total / totalDuration).toFixed(2);
  const successRate = ((successRequests / totalRequests) * 100).toFixed(1);

  console.log(`${colors.cyan}Total Duration:  ${colors.reset}${totalDuration.toFixed(2)} s`);
  console.log(`${colors.cyan}Total Requests:  ${colors.reset}${totalRequests}`);
  console.log(`${colors.cyan}Success Rate:    ${colors.reset}${successRate}% (${successRequests} OK, ${errorRequests} Errors)`);
  console.log(`${colors.cyan}Throughput:      ${colors.reset}${colors.bold}${rps} Requests/sec${colors.reset}`);
  console.log();
  console.log(`${colors.cyan}Latency Distribution:${colors.reset}`);
  console.log(`  Min:           ${colors.green}${min.toFixed(2)} ms${colors.reset}`);
  console.log(`  Average:       ${colors.green}${avg.toFixed(2)} ms${colors.reset}`);
  console.log(`  p50 (Median):  ${colors.green}${p50.toFixed(2)} ms${colors.reset}`);
  console.log(`  p90:           ${colors.yellow}${p90.toFixed(2)} ms${colors.reset}`);
  console.log(`  p99:           ${colors.red}${p99.toFixed(2)} ms${colors.reset}`);
  console.log(`  Max:           ${colors.red}${max.toFixed(2)} ms${colors.reset}`);
  console.log(`${colors.cyan}=============================================${colors.reset}\n`);
}

main().catch(err => {
  console.error("Benchmark failed with error:", err);
});
