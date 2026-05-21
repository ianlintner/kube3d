# CLAUDE.md - Developer Guide

This file provides information on the commands, environment configurations, and coding guidelines for the Kube3D project.

## Developer Commands

### Environment & Setup

- **Install workspace dependencies**: `npm install`
- **Install dashboard dependencies**: `cd dashboard && npm install`

### Live Data Collection

- **Extract cluster topology**: `node explore.js` _(Requires active Kubernetes context via `kubectl`)_

### Local Development & Verification

- **Run dev dashboard server**: `cd dashboard && npm run dev` _(Vite dev server)_
- **Preview production build**: `cd dashboard && npm run preview`
- **Build dashboard**: `cd dashboard && npm run build` _(Compiles code into `dashboard/dist/`)_

### Linting & Formatting

- **Check formatting (Prettier)**: `npm run format:check`
- **Fix formatting (Prettier)**: `npm run format`
- **Run ESLint checks**: `npm run lint`

---

## Coding Guidelines

### Core Architectural Separation

1. **Backend Collector (`explore.js`)**:
   - Platform: Node.js (CommonJS, `require`/`module.exports`).
   - Function: Runs `kubectl` commands synchronously, parses outputs, links resources using relationship heuristics, and writes graph files.
2. **Frontend Dashboard (`dashboard/`)**:
   - Platform: Browser-compatible ES Modules (Vite, `import`/`export`).
   - Function: Renders relationships dynamically in 3D using Three.js and `3d-force-graph`.

### Style and Structure

- **Code Styling**: Standardize on Prettier rules (semi-colons, single quotes, 2-space indentation).
- **Naming Conventions**: Use `camelCase` for variable and function names. Use `spinal-case` for file paths and CSS selectors.
- **Error Handling**:
  - In `explore.js`, catch errors individually for each kubectl query type to allow partial collections if some CRDs are missing in the target cluster.
  - In `dashboard/app.js`, handle missing or corrupt `cluster-graph.json` files gracefully by logging warning states and offering demo load fallbacks.
- **Aesthetic Guidelines**:
  - Maintain the premium cybernetic glassmorphic look (blur, transparency, outfit font, UnrealBloomPass glow).
  - Use Cylindrical (Upright) billboarding for 3D sprites/labels.
