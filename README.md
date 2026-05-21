# 🪐 Kube3D - Kubernetes 3D Cluster Explorer

Kube3D is a premium, interactive **3D force-directed graph visualizer** for Kubernetes clusters. By queries of live cluster state, it automatically discovers workloads, networking resources, storage volumes, and Istio Service Mesh configurations, representing their architecture in a responsive, glowing cybernetic space.

---

## Live Demo
[Kube3D Live Web Demo](ianlintner.github.io/kube3d/)

## 📺 Interactive Video Demo

[![Kube3D Demo Video](https://img.youtube.com/vi/HjOjzAvanLw/0.jpg)](https://youtu.be/HjOjzAvanLw)

_Click the preview image above to watch the interactive Kube3D YouTube demo._

---

## ✨ Features

- **Futuristic Glassmorphic Interface**: Sleek UI design using modern CSS, Outfit typography, backdrop filters, and custom control grids.
- **Auto-Discovery Backend**: Root level `explore.js` extracts cluster definitions via `kubectl -o json` and compiles nodes & link relationships.
- **Intelligent Relationship Mapping**:
  - **Workloads**: Connects `Deployments` ➔ `ReplicaSets` ➔ `Pods`, `StatefulSets` ➔ `Pods`, and `DaemonSets` ➔ `Pods`.
  - **Networking**: Maps `Ingress` ➔ `Service` and routes `Service` ➔ `Pods` via label selectors.
  - **Istio Service Mesh**: Details paths from `Gateways` ➔ `VirtualServices` ➔ `Services`, and represents `DestinationRules` and `PeerAuthentications`.
  - **Storage & Security**: Shows volume binds (`Pod` ➔ `PVC`) and service account bindings (`ServiceAccount` ➔ `Pod`).
- **Interactive 3D Visual Controls**:
  - Real-time auto-orbit animation.
  - Quick Search filters matching names, types, or labels.
  - Filter checklists by Namespace or Resource Type.
  - Complete details inspector side-panel with raw YAML/JSON views and relative connections list.
  - UnrealBloomPass bloom glow effects.

---

## 📂 Repository Structure

- `explore.js`: Aggregates live cluster data and exports topology JSON.
- `k8s_explorer_skill.md`: Source of truth documentation containing relationship heuristics and JSON schemas.
- `dashboard/`: Vite project containing the 3D application.
  - `index.html`: Layout container.
  - `app.js`: Three.js / `3d-force-graph` canvas configuration.
  - `style.css`: Premium cybernetic typography and glass panel layouts.
- `.github/`: CI workflows and AI agent instructions.
- `CLAUDE.md`: Quick instructions for building, running, and formatting code.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js**: v18 or higher.
- **Kubernetes context**: A configured `kubectl` pointing to an active cluster.

### Step 1: Collect Cluster Topology

To build the 3D graph of your live cluster:

```bash
# Run the node collector
node explore.js
```

This script queries resources in your cluster, maps their connections, and generates `cluster-graph.json` at the root and dashboard directories.

### Step 2: Start the 3D Dashboard

Launch the Vite local web development server:

```bash
# Move to dashboard, install, and run
cd dashboard
npm install
npm run dev
```

Open **`http://localhost:5173`** (or the port specified in terminal) in your browser.

> [!TIP]
> **No active Kubernetes cluster?** Don't worry! Open the dashboard, click **"Load Demo"**, and explore a pre-packaged mock cluster topology with over 120 nodes.

---

## ⚓ Relationship Discovery Rules

Kube3D is built on structural topology heuristics that relate objects together:

1. **Workloads**: Nodes represent actual cluster workloads. They are connected via ownership links (`"manages"`) checked from owner references.
2. **Networking**: Services query active pods in the same namespace and link directly (`"routes-to"`) to pods matching their label selector. Ingresses trace backing rules and link (`"exposes"`) to targeted services.
3. **Istio Service Mesh**: Integrates VirtualServices routing paths (`"routes-to"`) using resolved Service hosts, connects Gateways to VirtualServices, and matches mTLS settings (`PeerAuthentication`) to Namespaces or specific Workloads.
4. **Storage & Security**: Connects pods to PVCs (`"claims-volume"`) and maps Pods to ServiceAccounts.

---

## 🎨 Visual Aesthetics & Specifications

The 3D space uses precise dimensions and colors to group cluster components:

- **Bloom Pass Glow**: Customized UnrealBloomPass for a neon sci-fi aesthetic.
- **Deployments**: Rendered as larger floating spaceship icons without outer container wireframes.
- **Services**: Sized up and colored neon orange (`#ff6b00`), spinning continuously.
- **Istio Sails**: Offset double-pyramids representing sails, rotating on the Y-axis.
- **Logical Namespaces**: Encapsulated within double-layered dashed box boundaries.
- **Upright Billboarding**: Node sprite tags lock upright to face the camera.

---

## 🛠️ Development & Quality Scripts

We use ESLint and Prettier to keep code consistent. Run the scripts below before committing changes:

```bash
# Check formatting
npm run format:check

# Auto-format all code
npm run format

# Run code linter
npm run lint

# Build production bundle
cd dashboard && npm run build
```

These checks are also run in GitHub Actions on every pull request and push.
