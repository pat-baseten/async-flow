import * as PIXI from 'pixi.js';
import { Simulation } from './simulation';
import { Request, RequestState, Replica, ReplicaState, Zone, Metrics } from './types';

/**
 * Color palette matching the visualization style
 * Updated to match new CSS custom properties
 */
const COLORS = {
  background: 0x12121f,  // --bg-secondary

  // Request states (matching CSS variables)
  entering: 0x4ecdc4,           // --state-queued
  validating: 0x4ecdc4,         // --state-queued (was in_beefeater)
  queued: 0x4ecdc4,             // --state-queued
  waiting_capacity: 0xa78bfa,   // --state-waiting (purple)
  waiting_for_model: 0xfb923c,  // --state-coldstart
  processing: 0xfbbf24,         // --state-processing
  delivering: 0x34d399,         // --state-completed
  responding: 0x34d399,         // --state-completed
  completed: 0x34d399,          // --state-completed
  failed: 0xf87171,             // --state-failed
  expired: 0x64748b,            // --state-expired
  rate_limited: 0xf59e0b,       // --accent-warning
  exiting: 0x64748b,            // --state-expired

  // Priority colors (border)
  priority0: 0xef4444,  // High priority - --accent-danger
  priority1: 0xf0f0f5,  // Normal - --text-primary
  priority2: 0x4a4a6e,  // Low priority - subtle border

  // Replica states (matching CSS variables)
  replica_stopped: 0x1a1a2e,    // --bg-tertiary
  replica_starting: 0xfb923c,   // --replica-starting
  replica_ready: 0x4ecdc4,      // --replica-ready
  replica_busy: 0xfbbf24,       // --replica-busy

  // UI elements (updated for new theme)
  zone: 0x1a1a2e,               // --bg-tertiary
  zoneBorder: 0x2a2a4a,         // Subtle border
  zoneLabel: 0x606070,          // --text-tertiary
  arrow: 0x2a2a4a,              // Subtle arrow
  text: 0xf0f0f5,               // --text-primary
};

/**
 * Layout constants for the visualization
 * Updated to support up to 10 replicas
 */
const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 450;
const CENTER_Y = 225;

/**
 * Zone layout for async flow visualization
 * Updated with taller zones to accommodate more replicas
 */
const ZONES: Zone[] = [
  { id: 'queue', label: 'Queue', sublabel: 'Async', x: 140, y: 50, width: 200, height: 350 },
  { id: 'model', label: 'Model', sublabel: 'Replicas', x: 390, y: 50, width: 220, height: 350 },
  { id: 'results', label: 'Results', sublabel: 'Via webhook', x: 680, y: 50, width: 130, height: 350 },
];

/**
 * Renderer using PixiJS to visualize the simulation state
 */
export class Renderer {
  private app: PIXI.Application;
  private simulation: Simulation;
  private sprites: Map<string, PIXI.Container> = new Map();
  private replicaSprites: Map<number, PIXI.Container> = new Map();
  private stageContainer: PIXI.Container;
  private replicaContainer: PIXI.Container;
  private backgroundContainer: PIXI.Container;
  private metricsCallback?: (metrics: Record<string, number>) => void;
  private prevMetrics: Record<string, number> = {};
  private prevCompletedIds: Set<string> = new Set();
  private prevFailedIds: Set<string> = new Set();
  private prevExpiredIds: Set<string> = new Set();

  constructor(simulation: Simulation) {
    this.app = new PIXI.Application();
    this.simulation = simulation;
    this.stageContainer = new PIXI.Container();
    this.replicaContainer = new PIXI.Container();
    this.backgroundContainer = new PIXI.Container();
  }

  /**
   * Initialize the renderer
   */
  async init(): Promise<void> {
    await this.app.init({
      canvas: document.getElementById('canvas') as HTMLCanvasElement,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      backgroundColor: COLORS.background,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    // Add background container first
    this.app.stage.addChild(this.backgroundContainer);

    // Draw static elements for current mode
    this.drawBackground();

    // Add replica container (behind requests)
    this.app.stage.addChild(this.replicaContainer);

    // Add main container for requests
    this.app.stage.addChild(this.stageContainer);

    // Start render loop
    this.app.ticker.add((ticker) => this.render(ticker.deltaMS));
  }

  /**
   * Set callback for metrics updates
   */
  onMetricsUpdate(callback: (metrics: Record<string, number>) => void): void {
    this.metricsCallback = callback;
  }

  /**
   * Draw static background elements for async flow
   */
  private drawBackground(): void {
    // Clear existing background
    this.backgroundContainer.removeChildren();

    // Draw zones
    for (const zone of ZONES) {
      const zoneGraphics = new PIXI.Graphics();

      // Zone background
      zoneGraphics
        .roundRect(zone.x, zone.y, zone.width, zone.height, 8)
        .fill({ color: COLORS.zone, alpha: 0.6 })
        .stroke({ color: COLORS.zoneBorder, width: 2 });

      this.backgroundContainer.addChild(zoneGraphics);

      // Zone label
      const label = new PIXI.Text({
        text: zone.label,
        style: {
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 13,
          fill: COLORS.zoneLabel,
          fontWeight: '600',
        },
      });
      label.x = zone.x + 12;
      label.y = zone.y + 10;
      this.backgroundContainer.addChild(label);

      // Zone sublabel
      if (zone.sublabel) {
        const sublabel = new PIXI.Text({
          text: zone.sublabel,
          style: {
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: 10,
            fill: COLORS.zoneLabel,
            fontStyle: 'italic',
          },
        });
        sublabel.x = zone.x + 12;
        sublabel.y = zone.y + 26;
        this.backgroundContainer.addChild(sublabel);
      }
    }

    // Draw flow arrows: Client -> Queue -> Model -> Webhook -> Done
    this.drawArrow(this.backgroundContainer, 90, CENTER_Y, 130, CENTER_Y);    // Client -> Queue
    this.drawArrow(this.backgroundContainer, 350, CENTER_Y, 380, CENTER_Y);   // Queue -> Model
    this.drawArrow(this.backgroundContainer, 620, CENTER_Y, 670, CENTER_Y);   // Model -> Webhook
    this.drawArrow(this.backgroundContainer, 820, CENTER_Y, 870, CENTER_Y);   // Webhook -> Exit

    // Client label
    const clientLabel = new PIXI.Text({
      text: 'Client',
      style: { fontFamily: 'sans-serif', fontSize: 11, fill: COLORS.zoneLabel },
    });
    clientLabel.x = 30;
    clientLabel.y = CENTER_Y - 8;
    this.backgroundContainer.addChild(clientLabel);

    // Done label
    const exitLabel = new PIXI.Text({
      text: 'Done',
      style: { fontFamily: 'sans-serif', fontSize: 11, fill: COLORS.zoneLabel },
    });
    exitLabel.x = 890;
    exitLabel.y = CENTER_Y - 8;
    this.backgroundContainer.addChild(exitLabel);
  }

  /**
   * Draw an arrow between two points
   */
  private drawArrow(
    container: PIXI.Container,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): void {
    const arrow = new PIXI.Graphics();

    // Line
    arrow.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: COLORS.arrow, width: 2 });

    // Arrowhead
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLength = 8;
    arrow
      .moveTo(x2, y2)
      .lineTo(
        x2 - headLength * Math.cos(angle - Math.PI / 6),
        y2 - headLength * Math.sin(angle - Math.PI / 6)
      )
      .moveTo(x2, y2)
      .lineTo(
        x2 - headLength * Math.cos(angle + Math.PI / 6),
        y2 - headLength * Math.sin(angle + Math.PI / 6)
      )
      .stroke({ color: COLORS.arrow, width: 2 });

    container.addChild(arrow);
  }

  /**
   * Main render loop
   */
  private render(deltaMs: number): void {
    // Advance simulation
    this.simulation.tick(deltaMs);

    const state = this.simulation.getState();
    const currentIds = new Set(state.requests.map((r) => r.id));

    // Remove sprites for requests that no longer exist
    for (const [id, sprite] of this.sprites) {
      if (!currentIds.has(id)) {
        this.stageContainer.removeChild(sprite);
        this.sprites.delete(id);
      }
    }

    // Update or create sprites for each request
    for (const request of state.requests) {
      let sprite = this.sprites.get(request.id);

      if (!sprite) {
        sprite = this.createRequestSprite(request);
        this.sprites.set(request.id, sprite);
        this.stageContainer.addChild(sprite);
      }

      this.updateRequestSprite(sprite, request);

      // Track completed/failed/expired for metrics (only count once)
      if (request.state === 'completed' && !this.prevCompletedIds.has(request.id)) {
        this.simulation.recordCompleted();
        this.prevCompletedIds.add(request.id);
      } else if (request.state === 'failed' && !this.prevFailedIds.has(request.id)) {
        this.simulation.recordFailed();
        this.prevFailedIds.add(request.id);
      } else if (request.state === 'expired' && !this.prevExpiredIds.has(request.id)) {
        this.simulation.recordExpired();
        this.prevExpiredIds.add(request.id);
      }
    }

    // Render replicas
    this.renderReplicas(state.replicas);

    // Update metrics display
    this.updateMetrics(state.metrics);
  }

  /**
   * Render all replicas
   * Uses dynamic spacing that scales with replica count
   * Positions are based on sorted replica IDs for stability
   */
  private renderReplicas(replicas: Replica[]): void {
    const activeReplicas = replicas.filter((r) => r.state !== 'stopped');
    const currentIds = new Set(activeReplicas.map((r) => r.id));

    // Remove sprites for replicas that are stopped
    for (const [id, sprite] of this.replicaSprites) {
      if (!currentIds.has(id)) {
        this.replicaContainer.removeChild(sprite);
        this.replicaSprites.delete(id);
      }
    }

    // Layout constants
    const modelZone = ZONES.find((z) => z.id === 'model')!;
    const centerX = modelZone.x + modelZone.width / 2;

    // Dynamic spacing: get from simulation or calculate
    const spacing = this.simulation.getReplicaSpacing();
    const centerY = this.simulation.getCenterY();

    // Sort replicas by ID for stable positioning
    const sortedReplicas = [...activeReplicas].sort((a, b) => a.id - b.id);

    // Update or create sprites for each active replica
    sortedReplicas.forEach((replica, index) => {
      let sprite = this.replicaSprites.get(replica.id);

      if (!sprite) {
        sprite = this.createReplicaSprite(replica);
        this.replicaSprites.set(replica.id, sprite);
        this.replicaContainer.addChild(sprite);
      }

      // Calculate position with dynamic spacing (based on sorted index)
      const totalHeight = (sortedReplicas.length - 1) * spacing;
      const y = centerY - totalHeight / 2 + index * spacing;

      this.updateReplicaSprite(sprite, replica, centerX, y);
    });
  }

  /**
   * Create a sprite for a replica
   */
  private createReplicaSprite(replica: Replica): PIXI.Container {
    const container = new PIXI.Container();

    // Background box
    const box = new PIXI.Graphics();
    box.roundRect(-35, -20, 70, 40, 6)
      .fill({ color: this.getReplicaColor(replica.state), alpha: 0.3 })
      .stroke({ color: this.getReplicaColor(replica.state), width: 2 });

    // Label
    const label = new PIXI.Text({
      text: this.getReplicaLabel(replica.state),
      style: {
        fontFamily: 'sans-serif',
        fontSize: 9,
        fill: COLORS.text,
      },
    });
    label.anchor.set(0.5);
    label.y = 0;

    container.addChild(box);
    container.addChild(label);

    return container;
  }

  /**
   * Update a replica sprite
   */
  private updateReplicaSprite(
    sprite: PIXI.Container,
    replica: Replica,
    x: number,
    y: number
  ): void {
    // Smooth position interpolation
    const lerpFactor = 0.1;
    sprite.x += (x - sprite.x) * lerpFactor;
    sprite.y += (y - sprite.y) * lerpFactor;

    // Update box color
    const box = sprite.children[0] as PIXI.Graphics;
    const color = this.getReplicaColor(replica.state);
    box.clear()
      .roundRect(-35, -20, 70, 40, 6)
      .fill({ color, alpha: 0.3 })
      .stroke({ color, width: 2 });

    // Update label
    const label = sprite.children[1] as PIXI.Text;
    label.text = this.getReplicaLabel(replica.state);

    // Pulsing animation for starting replicas
    if (replica.state === 'starting') {
      const pulse = 1 + Math.sin(Date.now() * 0.005) * 0.1;
      sprite.scale.set(pulse);
    } else {
      sprite.scale.set(1);
    }
  }

  /**
   * Get color for replica state
   */
  private getReplicaColor(state: ReplicaState): number {
    switch (state) {
      case 'stopped':
        return COLORS.replica_stopped;
      case 'starting':
        return COLORS.replica_starting;
      case 'ready':
        return COLORS.replica_ready;
      case 'busy':
        return COLORS.replica_busy;
      default:
        return COLORS.replica_ready;
    }
  }

  /**
   * Get label for replica state
   */
  private getReplicaLabel(state: ReplicaState): string {
    switch (state) {
      case 'stopped':
        return 'Stopped';
      case 'starting':
        return 'Starting...';
      case 'ready':
        return 'Ready';
      case 'busy':
        return 'Processing';
      default:
        return '';
    }
  }

  /**
   * Create a sprite for a request
   */
  private createRequestSprite(request: Request): PIXI.Container {
    const container = new PIXI.Container();

    // Main circle
    const circle = new PIXI.Graphics();
    circle.circle(0, 0, 14).fill(this.getStateColor(request.state));

    // Priority border
    const border = new PIXI.Graphics();
    border
      .circle(0, 0, 16)
      .stroke({ color: this.getPriorityColor(request.priority), width: 2 });

    // Priority indicator text
    const priorityText = new PIXI.Text({
      text: String(request.priority),
      style: {
        fontFamily: 'sans-serif',
        fontSize: 10,
        fill: 0x1a1a2e,
        fontWeight: 'bold',
      },
    });
    priorityText.anchor.set(0.5);

    container.addChild(border);
    container.addChild(circle);
    container.addChild(priorityText);

    return container;
  }

  /**
   * Update a request sprite's position and appearance
   */
  private updateRequestSprite(sprite: PIXI.Container, request: Request): void {
    // Position
    sprite.x = request.x;
    sprite.y = request.y;

    // Scale
    sprite.scale.set(request.scale);

    // Alpha
    sprite.alpha = request.alpha;

    // Update circle color based on state
    const circle = sprite.children[1] as PIXI.Graphics;
    circle.clear().circle(0, 0, 14).fill(this.getStateColor(request.state));

    // Update border based on priority
    const border = sprite.children[0] as PIXI.Graphics;
    border
      .clear()
      .circle(0, 0, 16)
      .stroke({ color: this.getPriorityColor(request.priority), width: 2 });
  }

  /**
   * Get color for a request state
   */
  private getStateColor(state: RequestState): number {
    return COLORS[state] || COLORS.queued;
  }

  /**
   * Get border color for priority
   */
  private getPriorityColor(priority: 0 | 1 | 2): number {
    switch (priority) {
      case 0:
        return COLORS.priority0;
      case 1:
        return COLORS.priority1;
      case 2:
        return COLORS.priority2;
      default:
        return COLORS.priority1;
    }
  }

  /**
   * Update the metrics display
   */
  private updateMetrics(metrics: Metrics): void {
    // Update DOM elements
    const elements: Record<string, HTMLElement | null> = {
      queued: document.getElementById('metric-queued'),
      processing: document.getElementById('metric-processing'),
      completed: document.getElementById('metric-completed'),
      failed: document.getElementById('metric-failed'),
      expired: document.getElementById('metric-expired'),
      replicas: document.getElementById('metric-replicas'),
    };

    const metricsRecord = metrics as unknown as Record<string, number>;

    for (const [key, el] of Object.entries(elements)) {
      if (el && metricsRecord[key] !== undefined) {
        const newValue = metricsRecord[key];
        const oldValue = this.prevMetrics[key] || 0;

        if (newValue !== oldValue) {
          el.textContent = String(newValue);
          // Flash animation
          el.style.transform = 'scale(1.2)';
          setTimeout(() => {
            el.style.transform = 'scale(1)';
          }, 150);
        }
      }
    }

    this.prevMetrics = { ...metricsRecord };

    // Callback for external listeners
    if (this.metricsCallback) {
      this.metricsCallback(metricsRecord);
    }
  }
}
