# AI Agent Instructions for Kube3D

Welcome! You are working on **Kube3D**, a 3D visualization dashboard for Kubernetes clusters.
Below are guidelines and design rules you must follow when editing this codebase.

---

## 📂 Project Overview & Structure

- **Root Level**:
  - `explore.js`: Node.js script that runs `kubectl` commands, aggregates cluster data, maps workload/network relationships, and outputs `cluster-graph.json`.
  - `k8s_explorer_skill.md`: A detailed specification document outlining resource relationships (parent-child ownership, service-to-pod selectors, Istio routing), the required JSON schema, and visualization specifications.
- **`dashboard/`**:
  - A Vite-based static HTML/JS/CSS frontend.
  - `app.js`: Contains all the 3D visualization logic using `3d-force-graph` and Three.js.
  - `style.css`: Contains CSS rules, supporting glassmorphism styling, layout, typography, animations, and inspector tabs.
  - `index.html`: Layout containing the 3D canvas mount point, filter sidebars, legend, and details inspector.

---

## 🛠️ Commands & Workflow

Before making edits, ensure you run the appropriate task command from the project root:

- **Linting & Formatting**:
  - Check formatting: `npm run format:check`
  - Automatically fix formatting: `npm run format`
  - Lint files: `npm run lint`
- **Dashboard Development**:
  - Install dependencies: `cd dashboard && npm install`
  - Start Vite dev server: `npm run dev` (run within `dashboard/`)
  - Build dashboard: `npm run build` (run within `dashboard/`)
- **Backend Exploration**:
  - Query active cluster and write graph data: `node explore.js` (requires active `kubectl` context).

---

## 🎨 Design Aesthetics & 3D Rules

If you are modifying the 3D dashboard interface or style, you **must** preserve a premium cybernetic feel:

1. **Glassmorphism**: Use backing CSS grids with backdrop filters (`blur(12px)`), semi-transparent borders, and high contrast typography (Outfit font).
2. **Bloom Glow**: Maintain the bloom configuration (`UnrealBloomPass` with strength `0.85`, radius `0.35`, threshold `0.15`) to create beautiful neon halos.
3. **No Flashes or Mesh Reconstructions**: When updating node highlights or search states, traverse node meshes via `updateNodeVisualStates()` to dynamically adjust emissive values or opacities. Do not recreate the 3D elements, as this causes visual flickering.
4. **Upright Billboarding**: Icons and labels must billboard cylindrically (locked upright on the Y-axis), staying readable as the camera rotates.
5. **Color & Scale Rules**:
   - Deployments: 25% larger than default, box size `6.0` or icon scale `8.75` (no wireframe container box).
   - Services: neon orange (`#ff6b00`) spinning cogs.
   - Namespaces: double-layered dashed wireframe boundaries (size `22` and `21.4`).
   - Istio Gateways/VirtualServices: rotating double-pyramid sails.

---

## 🤖 Behavior and Quality Checklist

- **Preserve Skill Guidelines**: Always cross-reference your modifications with `k8s_explorer_skill.md`. It acts as the source of truth for the network routing mechanics and schema specification.
- **Maintain Schema Integrity**: If you edit `explore.js` to extract new attributes, make sure they fit inside the `.details` object schema in `k8s_explorer_skill.md` so the dashboard's details inspector can render them gracefully.
- **Verify before completion**: Always run formatting/linting scripts and verify that Vite builds without errors before ending your turn.
