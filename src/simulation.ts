import {
  Request,
  RequestState,
  Replica,
  ReplicaState,
  SimulationConfig,
  SimulationState,
  Metrics,
} from './types';

/**
 * Default configuration matching Baseten's actual defaults
 * Reference: docs.baseten.co/deployment/autoscaling and docs.baseten.co/development/model/performance/concurrency
 */
const DEFAULT_CONFIG: SimulationConfig = {
  // Model behavior
  modelProcessingTimeMs: 2000,     // 2 seconds inference time
  coldStartTimeMs: 3000,           // 3 seconds cold start (varies by model size)
  predictConcurrency: 1,           // Default predict_concurrency in config.yaml

  // Autoscaling (Baseten defaults)
  minReplicas: 0,                  // Scale to zero enabled by default
  maxReplicas: 10,                 // Max replicas (Baseten default is 1, max 10)
  concurrencyTarget: 1,            // Requests per replica before scaling
  scaleDownDelayMs: 15000,         // 15 sec for demo (real default is 900s = 15 min)
  autoscalingWindowMs: 5000,       // 5 sec for demo (real default is 60s)

  // Queue behavior
  maxQueueSize: 20,                // Async queue capacity
  maxTimeInQueueMs: 10000,         // 10 sec TTL (real default is 600s = 10 min)

  // Webhook
  webhookTimeMs: 500,              // Webhook delivery time
};

/**
 * Core simulation logic for async request flow.
 * This is the source of truth - renderer only reads this state.
 */
export class Simulation {
  private state: SimulationState;
  private speed: number = 1;
  private paused: boolean = false;
  private nextId: number = 0;
  private nextReplicaId: number = 0;
  private lastActivityTick: number = 0;
  private scaleDownDelay: number = 5000; // Time with no activity before scaling down
  private roundRobinIndex: number = 0; // For round-robin load balancing across replicas

  // Layout constants (x positions for each stage)
  private readonly STAGE_X = {
    enter: -30,
    gateway: 80,
    queue: 180,
    queueEnd: 320,
    model: 420,       // Model zone start
    modelEnd: 600,    // Model zone end (expanded for more replicas)
    webhook: 720,     // Webhook zone start (shifted right)
    exit: 1050,       // Exit point (shifted right)
  };

  // Vertical layout (dynamically adjusted based on replica count)
  private readonly CANVAS_HEIGHT = 450;  // Increased from 350
  private readonly MODEL_ZONE_TOP = 50;
  private readonly MODEL_ZONE_BOTTOM = 400;
  private readonly CENTER_Y = 225;  // Adjusted for taller canvas
  private readonly MAX_REPLICA_SPACING = 45;  // Maximum spacing between replicas
  private readonly MIN_REPLICA_SPACING = 25;  // Minimum spacing (for 10 replicas)

  constructor(config: Partial<SimulationConfig> = {}) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      tick: 0,
      mode: 'async',  // Always async
      requests: [],
      replicas: [],
      metrics: this.initialMetrics(),
      config: mergedConfig,
      targetReplicas: mergedConfig.minReplicas,
    };

    // Initialize with min replicas
    if (mergedConfig.minReplicas > 0) {
      this.setTargetReplicas(mergedConfig.minReplicas);
    }
  }

  private initialMetrics(): Metrics {
    return {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      expired: 0,
      replicas: 0,
      readyReplicas: 0,
    };
  }

  /**
   * Advance the simulation by deltaMs milliseconds
   */
  tick(deltaMs: number): void {
    if (this.paused) return;

    const adjustedDelta = deltaMs * this.speed;
    this.state.tick += adjustedDelta;

    // Update all requests
    for (const request of this.state.requests) {
      this.updateRequest(request, adjustedDelta);
    }

    // Update all replicas
    for (const replica of this.state.replicas) {
      this.updateReplica(replica, adjustedDelta);
    }

    // Remove exited requests
    this.state.requests = this.state.requests.filter(
      (r) => r.state !== 'exiting' || r.alpha > 0.01
    );

    // Handle autoscaling
    this.handleAutoscaling();

    // Try to assign waiting requests to ready replicas
    this.tryAssignToReplicas();

    // Update metrics
    this.updateMetrics();
  }

  /**
   * Update a single request's state machine (async flow only)
   */
  private updateRequest(request: Request, delta: number): void {
    // Smooth position interpolation
    const lerpFactor = 0.12;
    request.x += (request.targetX - request.x) * lerpFactor;
    request.y += (request.targetY - request.y) * lerpFactor;

    switch (request.state) {
      case 'entering':
        // Move toward gateway (validation)
        if (Math.abs(request.x - request.targetX) < 2) {
          request.state = 'validating';
          console.log(`[entering] Request ${request.id} reached gateway`);
        }
        break;

      case 'validating':
        // Queue immediately (fire-and-forget)
        // Key behavior - queue is DECOUPLED from autoscaling
        request.state = 'queued';
        request.queuedAt = this.state.tick;
        request.targetX = this.STAGE_X.queue;
        this.repositionQueue();
        console.log(`[async] Request ${request.id} queued`);
        this.lastActivityTick = this.state.tick;
        break;

      case 'queued':
        // Check for expiration in queue
        const timeInQueue = this.state.tick - (request.queuedAt || 0);
        if (timeInQueue > this.state.config.maxTimeInQueueMs) {
          request.state = 'expired';
          request.targetX = this.STAGE_X.exit;
          request.targetY = this.CENTER_Y + 80;
        }
        // Pulse animation for waiting
        request.scale = 1 + Math.sin(this.state.tick * 0.003) * 0.05;
        break;

      case 'waiting_for_model':
        // Waiting for assigned replica to be ready (cold start)
        const assignedReplica = this.state.replicas.find(
          (r) => r.id === request.assignedReplica
        );
        if (assignedReplica && assignedReplica.state === 'ready') {
          // Replica is ready, start processing
          const concurrencyTarget = this.state.config.concurrencyTarget;
          request.state = 'processing';
          request.processStartedAt = this.state.tick;
          assignedReplica.currentRequestIds.push(request.id);
          assignedReplica.state = assignedReplica.currentRequestIds.length >= concurrencyTarget ? 'busy' : 'ready';
          request.targetX = this.getReplicaX(assignedReplica);
          request.targetY = this.getReplicaYForRequest(assignedReplica, request.id);
          console.log(`[waiting_for_model] Request ${request.id} -> processing on replica ${assignedReplica.id}`);
        }
        // Show loading animation
        request.scale = 1 + Math.sin(this.state.tick * 0.005) * 0.1;

        // Check for expiration while waiting for cold start
        const coldStartWaitTime = this.state.tick - (request.processorPickedAt || 0);
        if (coldStartWaitTime > this.state.config.maxTimeInQueueMs) {
          request.state = 'expired';
          request.targetX = this.STAGE_X.exit;
          request.targetY = this.CENTER_Y + 80;
          // Free the replica assignment (remove from list if already added)
          if (assignedReplica) {
            assignedReplica.currentRequestIds = assignedReplica.currentRequestIds.filter(id => id !== request.id);
          }
        }
        break;

      case 'processing':
        // Check if processing complete
        const processingTime = this.state.tick - (request.processStartedAt || 0);
        if (processingTime > this.state.config.modelProcessingTimeMs) {
          // Free the replica slot
          const replica = this.state.replicas.find(
            (r) => r.currentRequestIds.includes(request.id)
          );
          if (replica) {
            // Remove this request from the replica's list
            replica.currentRequestIds = replica.currentRequestIds.filter(id => id !== request.id);
            // Update replica state based on remaining capacity
            const concurrencyTarget = this.state.config.concurrencyTarget;
            replica.state = replica.currentRequestIds.length >= concurrencyTarget ? 'busy' : 'ready';
          }

          // Go to webhook delivery
          request.state = 'delivering';
          request.targetX = this.STAGE_X.webhook;
          request.targetY = this.CENTER_Y;
          console.log(`[processing] Request ${request.id} -> delivering`);
          this.lastActivityTick = this.state.tick;
        }
        // Active processing animation
        request.scale = 1 + Math.sin(this.state.tick * 0.008) * 0.08;
        break;

      case 'delivering':
        // Webhook delivery (best-effort, 3 attempts with exponential backoff)
        if (Math.abs(request.x - request.targetX) < 5) {
          const deliveryTime = this.state.tick - (request.processStartedAt || 0) -
            this.state.config.modelProcessingTimeMs;

          if (deliveryTime > this.state.config.webhookTimeMs) {
            // Webhook delivery - in reality success depends on user's webhook endpoint
            // Real Baseten retries 3 times with 1s->4s backoff before giving up
            request.state = 'completed';
            request.completedAt = this.state.tick;
            request.targetX = this.STAGE_X.exit;
          }
        }
        break;

      case 'completed':
        request.scale = 1;
        // Fade out as it exits
        if (request.x > this.STAGE_X.webhook + 50) {
          request.alpha = Math.max(0, request.alpha - 0.02);
          if (request.alpha <= 0.01) {
            request.state = 'exiting';
          }
        }
        break;

      case 'failed':
        // Shake animation (webhook failure)
        request.x += Math.sin(this.state.tick * 0.05) * 2;
        request.scale = 1;
        // Fade out
        if (request.x > this.STAGE_X.webhook + 30) {
          request.alpha = Math.max(0, request.alpha - 0.015);
          if (request.alpha <= 0.01) {
            request.state = 'exiting';
          }
        }
        break;

      case 'expired':
        request.scale = 0.8;
        request.alpha = Math.max(0, request.alpha - 0.01);
        if (request.alpha <= 0.01) {
          request.state = 'exiting';
        }
        break;
    }
  }


  /**
   * Update a replica's state
   */
  private updateReplica(replica: Replica, delta: number): void {
    if (replica.state === 'starting' && replica.startingAt) {
      const startupTime = this.state.tick - replica.startingAt;
      if (startupTime >= this.state.config.coldStartTimeMs) {
        replica.state = 'ready';
        replica.startingAt = undefined;
        console.log(`[replica] Replica ${replica.id} is now ready`);
      }
    }

    // Handle stopping animation (1 second fade out)
    if (replica.state === 'stopping' && replica.stoppingAt) {
      const stoppingTime = this.state.tick - replica.stoppingAt;
      if (stoppingTime >= 1000) {
        replica.state = 'stopped';
        replica.stoppingAt = undefined;
        console.log(`[replica] Replica ${replica.id} has stopped`);
      }
    }
  }

  /**
   * Get the X position for a replica
   */
  private getReplicaX(replica: Replica): number {
    return this.STAGE_X.model + 70;
  }

  /**
   * Get the Y position for a replica
   * Dynamically calculates spacing based on replica count to fit all replicas
   * Uses sorted replica IDs for stable positioning
   */
  private getReplicaY(replica: Replica): number {
    const activeReplicas = this.state.replicas
      .filter((r) => r.state !== 'stopped')
      .sort((a, b) => a.id - b.id);  // Sort by ID for stable positioning
    const index = activeReplicas.findIndex((r) => r.id === replica.id);
    const count = activeReplicas.length;

    // Calculate dynamic spacing based on replica count
    const availableHeight = this.MODEL_ZONE_BOTTOM - this.MODEL_ZONE_TOP - 80; // Leave padding
    const spacing = count > 1
      ? Math.min(this.MAX_REPLICA_SPACING, Math.max(this.MIN_REPLICA_SPACING, availableHeight / (count - 1)))
      : 0;

    const totalHeight = (count - 1) * spacing;
    return this.CENTER_Y - totalHeight / 2 + index * spacing;
  }

  /**
   * Get the Y position for a specific request on a replica
   * Offsets requests vertically when multiple are on the same replica
   */
  private getReplicaYForRequest(replica: Replica, requestId: string): number {
    const baseY = this.getReplicaY(replica);
    const index = replica.currentRequestIds.indexOf(requestId);
    const count = replica.currentRequestIds.length;

    if (count <= 1) return baseY;

    // Stack requests vertically with small offset
    const offset = 12;
    const totalOffset = (count - 1) * offset;
    return baseY - totalOffset / 2 + index * offset;
  }

  /**
   * Get dynamic replica spacing for external use (renderer)
   */
  getReplicaSpacing(): number {
    const activeReplicas = this.state.replicas.filter(
      (r) => r.state !== 'stopped'
    );
    const count = activeReplicas.length;
    if (count <= 1) return this.MAX_REPLICA_SPACING;

    const availableHeight = this.MODEL_ZONE_BOTTOM - this.MODEL_ZONE_TOP - 80;
    return Math.min(this.MAX_REPLICA_SPACING, Math.max(this.MIN_REPLICA_SPACING, availableHeight / (count - 1)));
  }

  /**
   * Get the center Y position for external use (renderer)
   */
  getCenterY(): number {
    return this.CENTER_Y;
  }

  /**
   * Find an available ready replica using round-robin distribution.
   * Returns null if no ready replica is available.
   * Respects concurrencyTarget - replicas can handle multiple concurrent requests.
   */
  private findReadyReplicaRoundRobin(): Replica | null {
    const concurrencyTarget = this.state.config.concurrencyTarget;
    const availableReplicas = this.state.replicas
      .filter((r) => (r.state === 'ready' || r.state === 'busy') &&
                     r.currentRequestIds.length < concurrencyTarget)
      .sort((a, b) => a.id - b.id);

    if (availableReplicas.length === 0) return null;

    // Find the next available replica using round-robin
    const startIndex = this.roundRobinIndex % availableReplicas.length;
    const replica = availableReplicas[startIndex];

    // Advance round-robin for next request
    this.roundRobinIndex = (this.roundRobinIndex + 1) % Math.max(availableReplicas.length, 1);

    return replica;
  }

  /**
   * Handle autoscaling based on queue/waiting state
   * Based on Baseten's autoscaling logic:
   * - Scale up when requests exceed concurrency_target * replicas
   * - Scale down after scale_down_delay of inactivity
   */
  private handleAutoscaling(): void {
    const config = this.state.config;

    // Count waiting requests: queued (async), waiting_capacity (sync), or waiting_for_model (both)
    const waitingCount = this.state.requests.filter(
      (r) => r.state === 'queued' || r.state === 'waiting_capacity' || r.state === 'waiting_for_model'
    ).length;

    const processingCount = this.state.requests.filter(
      (r) => r.state === 'processing'
    ).length;

    const activeReplicas = this.state.replicas.filter(
      (r) => r.state === 'ready' || r.state === 'busy'
    ).length;

    const startingReplicas = this.state.replicas.filter(
      (r) => r.state === 'starting'
    ).length;

    const totalReplicas = activeReplicas + startingReplicas;
    const currentCapacity = totalReplicas * config.concurrencyTarget;

    // Scale up logic:
    // If (waiting + processing) exceeds capacity, scale up
    if (waitingCount + processingCount > currentCapacity && totalReplicas < config.maxReplicas) {
      const needed = Math.ceil((waitingCount + processingCount) / config.concurrencyTarget);
      const target = Math.min(needed, config.maxReplicas);
      if (target > this.state.targetReplicas) {
        console.log(`[autoscale] Scaling up: load=${waitingCount + processingCount}, capacity=${currentCapacity}, target=${target}`);
        this.setTargetReplicas(target);
      }
    }

    // Scale up if we have waiting requests and no replicas at all
    if ((waitingCount > 0 || processingCount > 0) && totalReplicas === 0) {
      console.log(`[autoscale] Scaling from zero: waitingCount=${waitingCount}`);
      this.setTargetReplicas(Math.max(1, config.minReplicas));
    }

    // Scale down logic:
    // If idle for scale_down_delay, scale down toward min_replicas
    const idleTime = this.state.tick - this.lastActivityTick;
    const allIdle = this.state.replicas.every(
      (r) => r.state === 'ready' || r.state === 'stopped'
    );
    const noRequests = this.state.requests.filter(
      (r) => r.state !== 'exiting' && r.state !== 'completed' && r.state !== 'failed' && r.state !== 'rate_limited'
    ).length === 0;

    if (allIdle && noRequests && idleTime > config.scaleDownDelayMs) {
      if (this.state.targetReplicas > config.minReplicas) {
        console.log(`[autoscale] Scaling down: idle for ${idleTime}ms, target=${config.minReplicas}`);
        this.setTargetReplicas(config.minReplicas);
      }
    }

    // Reconcile actual replicas with target
    this.reconcileReplicas();
  }

  /**
   * Reconcile actual replicas with target count
   */
  private reconcileReplicas(): void {
    const activeReplicas = this.state.replicas.filter(
      (r) => r.state !== 'stopped'
    );

    // Scale up
    while (activeReplicas.length < this.state.targetReplicas) {
      const stoppedReplica = this.state.replicas.find(
        (r) => r.state === 'stopped'
      );

      if (stoppedReplica) {
        stoppedReplica.state = 'starting';
        stoppedReplica.startingAt = this.state.tick;
        stoppedReplica.currentRequestIds = [];
        activeReplicas.push(stoppedReplica);
      } else if (this.state.replicas.length < this.state.config.maxReplicas) {
        const newReplica: Replica = {
          id: this.nextReplicaId++,
          state: 'starting',
          startingAt: this.state.tick,
          currentRequestIds: [],
        };
        this.state.replicas.push(newReplica);
        activeReplicas.push(newReplica);
      } else {
        break;
      }
    }

    // Scale down (only stop ready replicas with no active requests)
    while (activeReplicas.length > this.state.targetReplicas) {
      // Find a ready replica that's not already stopping
      const readyReplica = this.state.replicas.find(
        (r) => r.state === 'ready' && r.currentRequestIds.length === 0
      );

      if (readyReplica) {
        // Start the stopping animation
        readyReplica.state = 'stopping';
        readyReplica.stoppingAt = this.state.tick;
        readyReplica.startingAt = undefined;
        readyReplica.currentRequestIds = [];
        activeReplicas.splice(activeReplicas.indexOf(readyReplica), 1);
        console.log(`[replica] Replica ${readyReplica.id} is stopping`);
      } else {
        break; // Don't stop busy or starting replicas, or replicas with active requests
      }
    }
  }

  /**
   * Try to assign queued requests to available replicas.
   * Uses round-robin distribution to evenly distribute load across replicas,
   * matching how Kubernetes/Istio load balances traffic.
   * Respects concurrencyTarget - each replica can handle multiple concurrent requests.
   */
  private tryAssignToReplicas(): void {
    const concurrencyTarget = this.state.config.concurrencyTarget;

    // Get queued requests sorted by priority then creation time
    const waiting = this.state.requests
      .filter((r) => r.state === 'queued')
      .sort((a, b) => {
        // Priority-based queue (lower number = higher priority)
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });

    // Get all active replicas (not stopped) sorted by ID for consistent round-robin
    const activeReplicas = this.state.replicas
      .filter((r) => r.state === 'ready' || r.state === 'busy')
      .sort((a, b) => a.id - b.id);

    if (waiting.length > 0) {
      console.log(`[tryAssign] waiting: ${waiting.length}, activeReplicas: ${activeReplicas.length}, concurrencyTarget: ${concurrencyTarget}`);
    }

    if (activeReplicas.length === 0) {
      // No active replicas - check for starting replicas
      this.assignToStartingReplicas(waiting);
      return;
    }

    // Assign requests using round-robin across ALL active replicas
    for (const request of waiting) {
      // Find next available replica using round-robin
      let assigned = false;
      const startIndex = this.roundRobinIndex;

      // Try each replica starting from round-robin position
      for (let i = 0; i < activeReplicas.length; i++) {
        const replicaIndex = (startIndex + i) % activeReplicas.length;
        const replica = activeReplicas[replicaIndex];

        // Check if replica has capacity (respects concurrencyTarget)
        if (replica.currentRequestIds.length < concurrencyTarget) {
          // Assign to this replica
          request.state = 'processing';
          request.processStartedAt = this.state.tick;
          request.processorPickedAt = this.state.tick;
          request.assignedReplica = replica.id;
          replica.currentRequestIds.push(request.id);

          // Update replica state based on capacity
          replica.state = replica.currentRequestIds.length >= concurrencyTarget ? 'busy' : 'ready';

          request.targetX = this.getReplicaX(replica);
          request.targetY = this.getReplicaYForRequest(replica, request.id);

          // Move round-robin index to next replica
          this.roundRobinIndex = (replicaIndex + 1) % activeReplicas.length;
          assigned = true;

          this.repositionQueue();
          break;
        }
      }

      // If no replica available, stop assigning
      if (!assigned) break;
    }

    // Handle requests waiting for starting replicas
    const stillWaiting = this.state.requests.filter((r) => r.state === 'queued');
    this.assignToStartingReplicas(stillWaiting);
  }

  /**
   * Assign queued requests to starting replicas (cold start scenario)
   */
  private assignToStartingReplicas(queued: Request[]): void {
    if (queued.length === 0) return;

    const startingReplicas = this.state.replicas
      .filter((r) => r.state === 'starting')
      .sort((a, b) => a.id - b.id);

    console.log(`[assignToStarting] queued: ${queued.length}, startingReplicas: ${startingReplicas.length}`);

    if (startingReplicas.length === 0) return;

    // Distribute waiting requests across starting replicas using round-robin
    let startingIndex = 0;
    for (const request of queued) {
      // Find a starting replica that doesn't have too many waiting requests
      const replica = startingReplicas[startingIndex % startingReplicas.length];

      // Count how many requests are already waiting for this replica
      const waitingForThisReplica = this.state.requests.filter(
        (r) => r.assignedReplica === replica.id && r.state === 'waiting_for_model'
      ).length;

      // Limit waiting requests per starting replica to distribute evenly
      if (waitingForThisReplica < Math.ceil(queued.length / startingReplicas.length) + 1) {
        request.state = 'waiting_for_model';
        request.processorPickedAt = this.state.tick;
        request.assignedReplica = replica.id;
        request.targetX = this.STAGE_X.model - 20 - (waitingForThisReplica * 25);
        request.targetY = this.getReplicaY(replica);
        this.repositionQueue();
      }

      startingIndex++;
    }
  }

  /**
   * Reposition all queued requests in order
   */
  private repositionQueue(): void {
    const queued = this.state.requests
      .filter((r) => r.state === 'queued')
      .sort((a, b) => {
        // Sort by priority first, then by creation time
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });

    const queueWidth = this.STAGE_X.queueEnd - this.STAGE_X.queue;
    const spacing = Math.min(35, queueWidth / Math.max(queued.length, 1));

    queued.forEach((request, index) => {
      request.targetX = this.STAGE_X.queue + index * spacing;
      request.targetY = this.CENTER_Y;
    });
  }

  /**
   * Update metrics based on current state
   */
  private updateMetrics(): void {
    const requests = this.state.requests;
    const replicas = this.state.replicas;

    // Count queued/waiting_capacity + waiting_for_model as "queued"
    this.state.metrics.queued = requests.filter(
      (r) => r.state === 'queued' || r.state === 'waiting_capacity' || r.state === 'waiting_for_model'
    ).length;
    this.state.metrics.processing = requests.filter(
      (r) => r.state === 'processing'
    ).length;
    this.state.metrics.replicas = replicas.filter(
      (r) => r.state !== 'stopped'
    ).length;
    this.state.metrics.readyReplicas = replicas.filter(
      (r) => r.state === 'ready'
    ).length;
  }

  // === Public API ===

  /**
   * Add a new request to the system
   */
  addRequest(priority: 0 | 1 | 2 = 1): string {
    const id = `req-${this.nextId++}`;

    const request: Request = {
      id,
      state: 'entering',
      priority,
      createdAt: this.state.tick,
      x: this.STAGE_X.enter,
      y: this.CENTER_Y,
      targetX: this.STAGE_X.gateway,
      targetY: this.CENTER_Y,
      scale: 1,
      alpha: 1,
    };

    this.state.requests.push(request);
    this.lastActivityTick = this.state.tick;
    return id;
  }

  /**
   * Add multiple requests in a burst
   */
  addBurst(count: number, priority: 0 | 1 | 2 = 1): void {
    for (let i = 0; i < count; i++) {
      // Stagger the entry slightly
      setTimeout(() => this.addRequest(priority), i * 100 / this.speed);
    }
  }

  /**
   * Set target replica count
   */
  setTargetReplicas(count: number): void {
    this.state.targetReplicas = Math.max(0, Math.min(count, this.state.config.maxReplicas));
    this.lastActivityTick = this.state.tick; // Reset idle timer on manual scale
  }

  /**
   * Get target replica count
   */
  getTargetReplicas(): number {
    return this.state.targetReplicas;
  }

  /**
   * Set simulation speed multiplier
   */
  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, Math.min(10, speed));
  }

  /**
   * Pause/unpause the simulation
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * Toggle pause state
   */
  togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  /**
   * Reset the simulation to initial state
   */
  reset(): void {
    this.state.tick = 0;
    this.state.requests = [];
    this.state.replicas = [];
    this.state.metrics = this.initialMetrics();
    this.state.targetReplicas = this.state.config.minReplicas;
    this.nextId = 0;
    this.nextReplicaId = 0;
    this.lastActivityTick = 0;
    this.roundRobinIndex = 0;

    // Initialize with min replicas if > 0
    if (this.state.config.minReplicas > 0) {
      this.setTargetReplicas(this.state.config.minReplicas);
    }
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<SimulationConfig>): void {
    Object.assign(this.state.config, config);
  }

  /**
   * Get current state (read-only for renderer)
   */
  getState(): SimulationState {
    return this.state;
  }

  /**
   * Get current speed
   */
  getSpeed(): number {
    return this.speed;
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Record a completed request in metrics
   */
  recordCompleted(): void {
    this.state.metrics.completed++;
  }

  /**
   * Record a failed request in metrics
   */
  recordFailed(): void {
    this.state.metrics.failed++;
  }

  /**
   * Record an expired request in metrics
   */
  recordExpired(): void {
    this.state.metrics.expired++;
  }
}
