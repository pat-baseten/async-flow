/**
 * States a request can be in as it flows through the async system
 *
 * BASETEN ASYNC REQUEST FLOW:
 * Requests queue immediately, processed by workers, results delivered via webhook
 */
export type RequestState =
  | 'entering'           // Animating into gateway
  | 'validating'         // Being validated by the gateway
  | 'queued'             // In the async request queue
  | 'waiting_for_model'  // Assigned to replica, waiting for cold start
  | 'processing'         // Being processed by model replica
  | 'delivering'         // Webhook delivery in progress
  | 'completed'          // Successfully delivered
  | 'failed'             // Webhook delivery failed
  | 'expired'            // Timed out in queue
  | 'rate_limited'       // Hit rate limit (429)
  | 'exiting';           // Animating out of view

/**
 * A single async request flowing through the system
 */
export interface Request {
  id: string;
  state: RequestState;
  priority: 0 | 1 | 2;
  createdAt: number;
  queuedAt?: number;
  processorPickedAt?: number;
  processStartedAt?: number;
  completedAt?: number;
  assignedReplica?: number;

  // Position and animation
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  scale: number;
  alpha: number;
}

/**
 * State of a model replica
 */
export type ReplicaState = 'stopped' | 'starting' | 'ready' | 'busy';

export interface Replica {
  id: number;
  state: ReplicaState;
  startingAt?: number;
  currentRequestIds: string[];  // Supports concurrent requests per replica
}

/**
 * Configuration for the simulation
 * Based on Baseten's actual config options:
 * - config.yaml: predict_concurrency, model settings
 * - UI/API: concurrency_target, autoscaling settings
 */
export interface SimulationConfig {
  // Model behavior (config.yaml)
  modelProcessingTimeMs: number;  // How long the model takes to process
  coldStartTimeMs: number;        // Time to start a replica from stopped
  predictConcurrency: number;     // Concurrent requests inside model container (config.yaml)

  // Autoscaling (UI/API settings)
  minReplicas: number;            // Minimum replicas (0 = scale to zero)
  maxReplicas: number;            // Maximum replicas allowed
  concurrencyTarget: number;      // Requests per replica before scaling (UI setting)
  scaleDownDelayMs: number;       // Time before scaling down idle replicas (default 900s)
  autoscalingWindowMs: number;    // Window for traffic analysis (default 60s)

  // Queue behavior
  maxQueueSize: number;           // Max requests in async queue
  maxTimeInQueueMs: number;       // When requests expire (10s to 72h)

  // Webhook behavior
  webhookTimeMs: number;          // Time to deliver webhook
}

/**
 * Metrics tracked by the simulation
 */
export interface Metrics {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  expired: number;
  replicas: number;
  readyReplicas: number;
}

/**
 * Complete simulation state
 */
export interface SimulationState {
  tick: number;
  mode: 'async';  // Always async
  requests: Request[];
  replicas: Replica[];
  metrics: Metrics;
  config: SimulationConfig;
  targetReplicas: number;
}

/**
 * Zone definitions for rendering
 */
export interface Zone {
  id: string;
  label: string;
  sublabel?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
