/**
 * Async Inference Flow Visualization
 *
 * An interactive visualization showing how async requests flow through
 * Baseten's infrastructure: Client -> Queue -> Model Replicas -> Webhook
 *
 * Key concepts demonstrated:
 * - Queue is decoupled from autoscaling (requests queue while model scales)
 * - Cold start delay when replicas scale from zero
 * - Multiple replicas can process requests in parallel
 * - Webhook delivery with success/failure outcomes
 *
 * Based on the visualization patterns from:
 * - https://encore.dev/blog/queueing
 * - https://github.com/samwho/visualisations
 */

import { Simulation } from './simulation';
import { Renderer } from './renderer';
import { Controls } from './controls';
import { Narrator } from './narrator';
import { SettingsExporter } from './settings-exporter';

async function main() {
  console.log('Initializing Async Flow Visualization...');

  // Create simulation with Baseten-accurate default config
  // Matches actual Baseten behavior for async/sync request handling
  const simulation = new Simulation({
    // Model behavior
    modelProcessingTimeMs: 2000,    // Model takes 2s to process
    coldStartTimeMs: 3000,          // Cold start takes 3s
    predictConcurrency: 1,          // Default predict_concurrency

    // Autoscaling (scaled down for demo)
    minReplicas: 0,                 // Scale to zero enabled
    maxReplicas: 10,                // Up to 10 replicas (Baseten max)
    concurrencyTarget: 1,           // 1 request per replica before scaling
    scaleDownDelayMs: 15000,        // 15s for demo (real: 900s)
    autoscalingWindowMs: 5000,      // 5s for demo (real: 60s)

    // Queue behavior (async)
    maxQueueSize: 20,               // Async queue capacity
    maxTimeInQueueMs: 10000,        // 10s TTL (real default: 600s)

    // Webhook and sync
    webhookTimeMs: 500,             // Webhook delivery takes 500ms
    syncTimeoutMs: 30000,           // Sync timeout: 30s for demo
  });

  // Create renderer
  const renderer = new Renderer(simulation);
  await renderer.init();

  // Create controls UI
  new Controls(simulation);

  // Create narrator for madlib-style descriptions
  const narrator = new Narrator(simulation);

  // Update narrator periodically (every 100ms for smooth updates)
  setInterval(() => narrator.update(), 100);

  // Create settings exporter for config.yaml and curl commands
  new SettingsExporter(simulation);

  // Log when metrics change
  renderer.onMetricsUpdate((metrics) => {
    // Could send to analytics or update external displays
  });

  console.log('Visualization ready!');
  console.log('The model starts at 0 replicas. Send a request to trigger scale-up.');
  console.log('Watch for the cold start delay before processing begins.');
}

// Start the visualization
main().catch((error) => {
  console.error('Failed to initialize visualization:', error);
});
