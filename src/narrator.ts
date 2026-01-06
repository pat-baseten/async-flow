import { Simulation } from './simulation';
import { Request, RequestState } from './types';

/**
 * Generates madlib-style narration explaining what's happening in the simulation
 */
export class Narrator {
  private simulation: Simulation;
  private container: HTMLElement;
  private lastNarration: string = '';
  private trackedRequestId: string | null = null;

  constructor(simulation: Simulation) {
    this.simulation = simulation;
    this.container = document.getElementById('narration-content')!;
  }

  /**
   * Update the narration based on current simulation state
   */
  update(): void {
    const state = this.simulation.getState();

    // Find the most interesting request to narrate
    const request = this.findRequestToNarrate();

    if (!request) {
      // No active requests - show idle state
      this.renderIdleState(state.replicas.filter(r => r.state !== 'stopped').length);
      return;
    }

    // Track this request
    this.trackedRequestId = request.id;

    // Generate narration for this request
    const narration = this.generateNarration(request);

    if (narration !== this.lastNarration) {
      this.container.innerHTML = narration;
      this.lastNarration = narration;
    }
  }

  /**
   * Find the most interesting request to narrate about
   */
  private findRequestToNarrate(): Request | null {
    const state = this.simulation.getState();
    const requests = state.requests;

    // Priority order for what's most interesting to narrate:
    // 1. Currently tracked request (if still active)
    // 2. Request in an "active" state (processing, delivering, responding)
    // 3. Request waiting (queued, parking, waiting_for_model)
    // 4. Request entering
    // 5. Most recently completed/failed

    // Check if tracked request is still interesting
    if (this.trackedRequestId) {
      const tracked = requests.find(r => r.id === this.trackedRequestId);
      if (tracked && !['exiting', 'completed', 'failed', 'expired'].includes(tracked.state)) {
        return tracked;
      }
      // If tracked request finished, show its completion briefly
      if (tracked && ['completed', 'failed', 'expired'].includes(tracked.state)) {
        return tracked;
      }
    }

    // Find most interesting active request
    const stateOrder: RequestState[] = [
      'processing',
      'delivering',
      'waiting_for_model',
      'queued',
      'validating',
      'entering',
      'completed',
      'failed',
      'expired',
      'rate_limited',
    ];

    for (const targetState of stateOrder) {
      const found = requests.find(r => r.state === targetState);
      if (found) return found;
    }

    return null;
  }

  /**
   * Generate madlib-style narration for a request (async flow)
   */
  private generateNarration(request: Request): string {
    const state = this.simulation.getState();
    const priorityLabel = this.getPriorityLabel(request.priority);
    const replicaCount = state.replicas.filter(r => r.state !== 'stopped').length;
    const readyCount = state.replicas.filter(r => r.state === 'ready').length;

    switch (request.state) {
      case 'entering':
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">1</span>
            Your <span class="highlight">${priorityLabel} request</span> is entering the system...
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">2</span>
            Next: Request validation
          </div>
        `);

      case 'validating':
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">1</span>
            Validating your request and preparing to queue it.
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">2</span>
            Next: Added to <span class="highlight">async queue</span>
          </div>
        `);

      case 'queued':
        const queuePosition = this.getQueuePosition(request);
        const timeInQueue = Math.round((state.tick - (request.queuedAt || 0)) / 1000);
        const maxConcurrentRequests = state.config.maxReplicas * state.config.concurrencyTarget;
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">📥</span>
            Your request is <span class="highlight">queued</span> for processing.
            ${queuePosition > 0 ? `Position: <span class="stage">#${queuePosition}</span>` : ''}
            ${request.priority === 0 ? '<span class="badge high-priority">High Priority</span>' : ''}
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">⏱</span>
            Waiting: <span class="highlight">${timeInQueue}s</span>
            (max_time_in_queue: ${Math.round(state.config.maxTimeInQueueMs / 1000)}s)
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">💡</span>
            ${replicaCount === 0
              ? `Queue is <span class="highlight">decoupled from autoscaling</span>—request waits while model scales up.`
              : readyCount === 0
                ? `Waiting for a replica to become ready...`
                : `Request will be assigned to an <span class="action">available replica</span>`}
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">📈</span>
            Autoscaling: up to <span class="highlight">${maxConcurrentRequests}</span> concurrent requests
            (max_replicas × concurrency_target = ${state.config.maxReplicas} × ${state.config.concurrencyTarget})
          </div>
        `);

      case 'waiting_for_model':
        const replica = state.replicas.find(r => r.id === request.assignedReplica);
        const coldStartProgress = replica?.startingAt
          ? Math.round(((state.tick - replica.startingAt) / state.config.coldStartTimeMs) * 100)
          : 0;
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">❄</span>
            <span class="warning">Cold start</span> in progress!
            Replica ${request.assignedReplica} is starting up.
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">%</span>
            Progress: <span class="highlight">${Math.min(coldStartProgress, 100)}%</span>
            (${Math.round(state.config.coldStartTimeMs / 1000)}s total)
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">→</span>
            Your request will process once the model is <span class="action">loaded</span>.
          </div>
        `);

      case 'processing':
        const processingTime = Math.round((state.tick - (request.processStartedAt || 0)) / 1000);
        const modelTime = Math.round(state.config.modelProcessingTimeMs / 1000);
        const progress = Math.round((processingTime / modelTime) * 100);
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">⚡</span>
            <span class="stage">Replica ${request.assignedReplica}</span> is processing your request!
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">%</span>
            Progress: <span class="highlight">${Math.min(progress, 100)}%</span>
            (${processingTime}s / ${modelTime}s)
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">→</span>
            Next: Deliver result via <span class="action">webhook</span>
          </div>
        `);

      case 'delivering':
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">📤</span>
            Delivering result to your <span class="highlight">webhook endpoint</span>...
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">🔄</span>
            Retry policy: <span class="highlight">3 attempts</span> with exponential backoff (1s → 4s)
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">⚠</span>
            <span class="warning">Important:</span> Baseten doesn't store results—if webhook fails, data is lost!
          </div>
        `);

      case 'completed':
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">✓</span>
            <span class="action">Success!</span> Your request completed.
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">📊</span>
            Result delivered via webhook to your endpoint.
          </div>
        `);

      case 'failed':
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">✗</span>
            <span class="warning">Webhook delivery failed!</span>
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">💡</span>
            The model processed successfully, but we couldn't reach your webhook.
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">→</span>
            Save results in your model's <code>postprocess()</code> to avoid data loss.
          </div>
        `);

      case 'expired':
        return this.template(`
          <div class="narration-step active">
            <span class="narration-step-icon">⏱</span>
            <span class="warning">Request expired!</span> TTL exceeded.
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">💡</span>
            The request waited too long in the queue.
          </div>
          <div class="narration-step">
            <span class="narration-step-icon">→</span>
            Consider <span class="action">scaling up replicas</span> or increasing queue TTL.
          </div>
        `);

      default:
        return '';
    }
  }

  /**
   * Render idle state narration with scale-down info
   */
  private renderIdleState(replicaCount: number): void {
    const state = this.simulation.getState();
    const scaleDownDelaySec = Math.round(state.config.scaleDownDelayMs / 1000);

    const narration = this.template(`
      <div class="narration-empty">
        ${replicaCount === 0
          ? `Model is at <span class="warning">0 replicas</span>. Send a request to trigger scale-up.`
          : `<span class="highlight">${replicaCount} replica${replicaCount > 1 ? 's' : ''}</span> ready. Send a request to see the async flow.`}
      </div>
      ${replicaCount > 0 ? this.template(`
        <div class="narration-step" style="margin-top: 8px; opacity: 0.7;">
          <span class="narration-step-icon">📉</span>
          Replicas will <span class="highlight">scale down</span> after ${scaleDownDelaySec}s of inactivity
          (scale_down_delay: ${scaleDownDelaySec}s)
        </div>
      `) : ''}
    `);

    if (narration !== this.lastNarration) {
      this.container.innerHTML = narration;
      this.lastNarration = narration;
      this.trackedRequestId = null;
    }
  }

  /**
   * Get priority label
   */
  private getPriorityLabel(priority: 0 | 1 | 2): string {
    switch (priority) {
      case 0: return 'high-priority';
      case 1: return 'normal';
      case 2: return 'low-priority';
    }
  }

  /**
   * Get queue position for a request
   */
  private getQueuePosition(request: Request): number {
    const state = this.simulation.getState();
    const queued = state.requests
      .filter(r => r.state === 'queued')
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });
    return queued.findIndex(r => r.id === request.id) + 1;
  }

  /**
   * Clean up template string
   */
  private template(html: string): string {
    return html.trim().replace(/\s+/g, ' ').replace(/>\s+</g, '><');
  }
}
