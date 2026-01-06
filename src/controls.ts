import { Simulation } from './simulation';

/**
 * UI Controls for the async flow visualization
 */
export class Controls {
  private simulation: Simulation;
  private container: HTMLElement;
  private pauseButton?: HTMLButtonElement;
  private replicaSlider?: HTMLInputElement;
  private replicaValueEl?: HTMLSpanElement;
  private sliders: Map<string, { slider: HTMLInputElement; valueEl: HTMLSpanElement; unit: string }> = new Map();

  constructor(simulation: Simulation) {
    this.simulation = simulation;
    this.container = document.getElementById('controls')!;
    this.setup();
  }

  private setup(): void {
    // Request buttons
    this.addButton('Send Request', () => {
      this.simulation.addRequest(1);
    }, 'primary', 'Send a single async request to the queue');

    this.addButton('Send Burst (5)', () => {
      this.simulation.addBurst(5, 1);
    }, 'secondary', 'Send 5 requests in quick succession');

    // Priority buttons (async queue supports priority)
    this.addButton('High Priority', () => {
      this.simulation.addRequest(0);
    }, 'danger', 'High priority requests are processed first');

    this.addButton('Low Priority', () => {
      this.simulation.addRequest(2);
    }, 'secondary', 'Low priority requests wait for higher priority ones');

    // Simulation controls
    this.pauseButton = this.addButton('Pause', () => {
      const isPaused = this.simulation.togglePause();
      this.pauseButton!.textContent = isPaused ? 'Resume' : 'Pause';
    }, 'secondary');

    this.addButton('Reset', () => {
      this.simulation.reset();
      // Reset metrics display
      ['queued', 'processing', 'completed', 'failed', 'expired', 'replicas'].forEach((key) => {
        const el = document.getElementById(`metric-${key}`);
        if (el) el.textContent = '0';
      });
      // Reset replica slider
      if (this.replicaSlider && this.replicaValueEl) {
        this.replicaSlider.value = '0';
        this.replicaValueEl.textContent = '0';
      }
      // Reset all config sliders to match simulation state
      this.resetSliders();
    }, 'secondary');

    // Separator
    this.addSeparator();

    // Get current config to initialize sliders with actual values
    const config = this.simulation.getState().config;

    // Replica controls (increased max to 10 for realistic scenarios)
    const { slider, valueEl } = this.addSlider('Replicas', 0, 10, this.simulation.getTargetReplicas(), 1, (value) => {
      this.simulation.setTargetReplicas(value);
      // Also set minReplicas so autoscaling won't scale below the manual setting
      this.simulation.setConfig({ minReplicas: value });
    }, '', undefined, 'Minimum replicas to keep running. Set to 0 for scale-to-zero.');
    this.replicaSlider = slider;
    this.replicaValueEl = valueEl;

    // Speed control
    this.addSlider('Speed', 0.25, 4, this.simulation.getSpeed(), 0.25, (value) => {
      this.simulation.setSpeed(value);
    }, 'x', 'speed', 'Simulation speed multiplier');

    // Separator
    this.addSeparator();

    // Model processing time (increased max for long-running models like LLMs)
    this.addSlider('Model Time', 500, 30000, config.modelProcessingTimeMs, 500, (value) => {
      this.simulation.setConfig({ modelProcessingTimeMs: value });
    }, 'ms', 'modelProcessingTimeMs', 'Time for the model to process each request. LLMs typically take 2-30 seconds.');

    // Cold start time (increased for large models)
    this.addSlider('Cold Start', 1000, 60000, config.coldStartTimeMs, 1000, (value) => {
      this.simulation.setConfig({ coldStartTimeMs: value });
    }, 'ms', 'coldStartTimeMs', 'Time to start a new replica from stopped state. Larger models take longer.');

    // Queue timeout
    this.addSlider('Queue TTL', 2000, 30000, config.maxTimeInQueueMs, 1000, (value) => {
      this.simulation.setConfig({ maxTimeInQueueMs: value });
    }, 'ms', 'maxTimeInQueueMs', 'Maximum time a request can wait in the queue before expiring.');

    // Concurrency target (triggers autoscaling)
    this.addSlider('Concurrency', 1, 5, config.concurrencyTarget, 1, (value) => {
      this.simulation.setConfig({ concurrencyTarget: value });
    }, ' req/replica', 'concurrencyTarget', 'Concurrent requests per replica. Autoscaling triggers when this is exceeded.');

    // Scale down delay (demo values, shorter than real defaults for visualization)
    this.addSlider('Scale Down', 5000, 60000, config.scaleDownDelayMs, 5000, (value) => {
      this.simulation.setConfig({ scaleDownDelayMs: value });
    }, 'ms', 'scaleDownDelayMs', 'Time to wait before scaling down idle replicas. Real default is 15 minutes.');

    // Update replica slider display periodically
    setInterval(() => this.updateReplicaDisplay(), 200);
  }


  private addButton(
    label: string,
    onClick: () => void,
    style: 'primary' | 'secondary' | 'danger' = 'primary',
    tooltip?: string
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (style !== 'primary') {
      btn.className = style;
    }
    if (tooltip) {
      btn.classList.add('has-tooltip');
      const tooltipEl = document.createElement('span');
      tooltipEl.className = 'tooltip';
      tooltipEl.textContent = tooltip;
      btn.appendChild(tooltipEl);
    }
    btn.addEventListener('click', onClick);
    this.container.appendChild(btn);
    return btn;
  }

  private addSeparator(): void {
    const sep = document.createElement('div');
    sep.className = 'separator';
    sep.style.width = '1px';
    sep.style.height = '24px';
    sep.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
    sep.style.margin = '0 8px';
    this.container.appendChild(sep);
  }

  private addSlider(
    label: string,
    min: number,
    max: number,
    initial: number,
    step: number,
    onChange: (value: number) => void,
    unit: string = '',
    configKey?: string,
    tooltip?: string
  ): { slider: HTMLInputElement; valueEl: HTMLSpanElement; group: HTMLDivElement } {
    const group = document.createElement('div');
    group.className = 'control-group';
    if (tooltip) {
      group.classList.add('has-tooltip');
      const tooltipEl = document.createElement('span');
      tooltipEl.className = 'tooltip';
      tooltipEl.textContent = tooltip;
      group.appendChild(tooltipEl);
    }

    const labelEl = document.createElement('label');
    labelEl.textContent = label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(initial);

    const valueEl = document.createElement('span');
    valueEl.className = 'value';
    valueEl.textContent = `${initial}${unit}`;

    slider.addEventListener('input', () => {
      const value = parseFloat(slider.value);
      valueEl.textContent = `${value}${unit}`;
      onChange(value);
    });

    group.appendChild(labelEl);
    group.appendChild(slider);
    group.appendChild(valueEl);
    this.container.appendChild(group);

    // Store reference for reset functionality
    if (configKey) {
      this.sliders.set(configKey, { slider, valueEl, unit });
    }

    return { slider, valueEl, group };
  }

  /**
   * Update replica slider to reflect actual state (for auto-scaling)
   */
  private updateReplicaDisplay(): void {
    if (!this.replicaSlider || !this.replicaValueEl) return;

    const state = this.simulation.getState();
    const activeReplicas = state.replicas.filter((r) => r.state !== 'stopped').length;

    // Update display without triggering change event
    this.replicaValueEl.textContent = String(activeReplicas);
  }

  /**
   * Reset all sliders to match current simulation config
   */
  private resetSliders(): void {
    const config = this.simulation.getState().config;

    // Reset speed slider
    const speedSlider = this.sliders.get('speed');
    if (speedSlider) {
      const speed = this.simulation.getSpeed();
      speedSlider.slider.value = String(speed);
      speedSlider.valueEl.textContent = `${speed}${speedSlider.unit}`;
    }

    // Reset config sliders
    const configKeys: (keyof typeof config)[] = [
      'modelProcessingTimeMs',
      'coldStartTimeMs',
      'maxTimeInQueueMs',
      'concurrencyTarget',
      'scaleDownDelayMs',
    ];

    for (const key of configKeys) {
      const sliderData = this.sliders.get(key);
      if (sliderData) {
        const value = config[key];
        sliderData.slider.value = String(value);
        sliderData.valueEl.textContent = `${value}${sliderData.unit}`;
      }
    }
  }
}
