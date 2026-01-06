# Async Inference Flow Visualization

An interactive visualization showing how async requests flow through Baseten's infrastructure: **Client → Queue → Model Replicas → Webhook**.

## Overview

This visualization demonstrates key concepts of Baseten's async inference system:

- **Queue decoupling**: Requests queue while model replicas scale independently
- **Cold start delays**: Visual representation of replica startup time when scaling from zero
- **Parallel processing**: Multiple replicas can process requests concurrently
- **Webhook delivery**: Success and failure outcomes for webhook callbacks

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm

### Installation

```bash
npm install
```

### Development

Start the development server with hot reload:

```bash
npm run dev
```

Then open `http://localhost:3000` in your browser (or use `npx serve .` in another terminal).

### Build

Build the production bundle:

```bash
npm run build
```

### Serve

Serve the built files:

```bash
npm run serve
```

## Project Structure

```
async-flow/
├── src/
│   ├── index.ts           # Main entry point
│   ├── simulation.ts      # Core simulation logic
│   ├── renderer.ts        # Pixi.js rendering
│   ├── controls.ts        # UI controls
│   ├── narrator.ts        # Text descriptions
│   ├── settings-exporter.ts # Config/curl generator
│   └── types.ts           # TypeScript types
├── out/                   # Build output (generated)
├── index.html             # HTML entry point
├── package.json
└── tsconfig.json
```

## Configuration

The simulation uses Baseten-accurate defaults that match actual infrastructure behavior:

- **Model processing time**: 2 seconds
- **Cold start delay**: 3 seconds
- **Autoscaling**: 0-10 replicas, scale-to-zero enabled
- **Queue capacity**: 20 requests
- **Webhook delivery**: 500ms

All parameters can be adjusted via the interactive controls in the UI.

## Technologies

- **TypeScript**: Type-safe development
- **Pixi.js**: High-performance 2D rendering
- **esbuild**: Fast bundling and minification
