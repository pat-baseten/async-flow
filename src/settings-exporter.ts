import { Simulation } from './simulation';
import { SimulationConfig } from './types';

/**
 * Generates exportable configuration snippets for Baseten settings
 */
export class SettingsExporter {
  private simulation: Simulation;
  private configYamlEl: HTMLElement;
  private autoscalingCurlEl: HTMLElement;

  constructor(simulation: Simulation) {
    this.simulation = simulation;
    this.configYamlEl = document.getElementById('config-yaml')!;
    this.autoscalingCurlEl = document.getElementById('autoscaling-curl')!;

    this.setupToggle();
    this.setupCopyButtons();
    this.update();

    // Update settings display periodically
    setInterval(() => this.update(), 500);
  }

  private setupToggle(): void {
    const header = document.querySelector('.settings-header');
    const content = document.getElementById('settings-content');
    const toggle = document.getElementById('settings-toggle');

    if (header && content && toggle) {
      header.addEventListener('click', () => {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        toggle.textContent = isHidden ? '▲' : '▼';
      });
    }
  }

  private setupCopyButtons(): void {
    const copyButtons = document.querySelectorAll('.copy-btn');
    copyButtons.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const target = (btn as HTMLElement).dataset.target;
        if (!target) return;

        const el = document.getElementById(target);
        if (!el) return;

        try {
          await navigator.clipboard.writeText(el.textContent || '');
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        } catch {
          console.error('Failed to copy');
        }
      });
    });
  }

  /**
   * Update the settings display with current simulation config
   */
  update(): void {
    const state = this.simulation.getState();
    const config = state.config;

    this.configYamlEl.textContent = this.generateConfigYaml(config);
    this.autoscalingCurlEl.textContent = this.generateAutoscalingCurl(config);
  }

  /**
   * Generate config.yaml snippet for Truss
   */
  private generateConfigYaml(config: SimulationConfig): string {
    // Convert simulation time to real Baseten values
    const processingTimeSec = config.modelProcessingTimeMs / 1000;
    const coldStartSec = config.coldStartTimeMs / 1000;

    return `# Truss config.yaml
model_name: "my-model"
runtime:
  # Concurrent requests inside model container
  predict_concurrency: ${config.predictConcurrency}

resources:
  # Adjust based on your model's needs
  cpu: "2"
  memory: "8Gi"
  # use_gpu: true
  # accelerator: A10G

# Model processing time is determined by your model code
# Cold start time depends on model size and dependencies
# Estimated inference time: ~${processingTimeSec.toFixed(1)}s
# Estimated cold start: ~${coldStartSec.toFixed(1)}s`;
  }

  /**
   * Generate autoscaling API curl command
   * Uses REAL Baseten defaults, not the shortened demo values
   */
  private generateAutoscalingCurl(config: SimulationConfig): string {
    // Map demo values to real Baseten defaults for production use
    // Demo uses shortened times for visualization, but exported config should use real values
    const realScaleDownDelay = 900;    // Real default: 900 seconds (15 min)
    const realAutoscalingWindow = 60;  // Real default: 60 seconds

    return `# Set autoscaling via Baseten API
# Note: Demo uses shortened times for visualization
# These are the REAL Baseten defaults for production
curl -X PATCH \\
  "https://api.baseten.co/v1/models/YOUR_MODEL_ID/deployments/production/autoscaling" \\
  -H "Authorization: Api-Key $BASETEN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "min_replica": ${config.minReplicas},
    "max_replica": ${config.maxReplicas},
    "concurrency_target": ${config.concurrencyTarget},
    "scale_down_delay": ${realScaleDownDelay},
    "autoscaling_window": ${realAutoscalingWindow}
  }'

# Baseten defaults (for reference):
# - min_replica: 0 (scale to zero)
# - max_replica: 1 (contact support to increase to 10)
# - concurrency_target: 1
# - scale_down_delay: 900 (15 minutes)
# - autoscaling_window: 60 (1 minute)`;
  }
}
