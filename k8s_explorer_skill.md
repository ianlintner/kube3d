# Kubernetes 3D Cluster Explorer Skill

This skill guides an AI agent to explore a Kubernetes cluster, identify the core resources, extract their structural relationships (using standard 90/10 Kubernetes and Istio patterns), and output a structured `cluster-graph.json` file. The output will be consumed by a Three.js 3D Web Dashboard.

---

## 1. Goal & Objectives

The agent's objective is to build a complete node-link topology of a target Kubernetes cluster. The focus is on the most common architectural patterns:

- **Workloads**: Namespaces, Nodes, Deployments, ReplicaSets, StatefulSets, DaemonSets, and Pods.
- **Networking**: Ingresses, Services, Endpoints, and Ports.
- **Storage**: PersistentVolumeClaims (PVCs).
- **Istio Service Mesh**: Gateways, VirtualServices, DestinationRules, ServiceEntries, and Sidecars.
- **Security & Authorization**: ServiceAccounts, PeerAuthentications, and AuthorizationPolicies.
- **Protocols**: Mapping gRPC, HTTP/REST, and TCP communication paths based on service naming or configuration.

---

## 2. Resource & Relationship Discovery Heuristics

To build an accurate graph, use the following rules to connect resources (nodes) with links:

### A. Workload Parent-Child Hierarchies

Workload components manage Pods in a hierarchical tree. Establish direct link relationships:

1. **Deployment ➔ ReplicaSet**: Check the ReplicaSet's `ownerReferences` to link it to its managing Deployment.
2. **ReplicaSet ➔ Pod**: Check the Pod's `ownerReferences` to link it to its ReplicaSet.
3. **StatefulSet ➔ Pod**: Check the Pod's `ownerReferences` to link it directly to the StatefulSet.
4. **DaemonSet ➔ Pod**: Check the Pod's `ownerReferences` to link it directly to the DaemonSet.

_Link Types_: `"manages"`

### B. Core Kubernetes Networking

Services route traffic to Pods using label selectors.

1. **Service ➔ Pod**:
   - Fetch the Service's `.spec.selector`.
   - Match these selectors against the `.metadata.labels` of Pods in the same namespace.
   - Create links from the Service to all matching Pods.
2. **Ingress ➔ Service**:
   - Inspect the Ingress rules (`.spec.rules[*].http.paths[*].backend.service.name`).
   - Create a link from the Ingress to the targeted Service.

_Link Types_: `"routes-to"`, `"exposes"`

### C. Istio Service Mesh Routing

Istio intercepts ingress and service-to-service communication.

1. **Istio Gateway ➔ VirtualService**:
   - In a `VirtualService`, inspect `.spec.gateways`. If it refers to an Istio `Gateway` name, create a link from the Gateway to the VirtualService.
2. **VirtualService ➔ Service**:
   - In a `VirtualService`, inspect `.spec.http[*].route[*].destination.host`.
   - Resolve the destination host (e.g., `frontend`, `frontend.default`, `frontend.default.svc.cluster.local`) to the corresponding Kubernetes Service in the correct namespace.
   - Create a link from the VirtualService to the target Service.
3. **DestinationRule ➔ Service**:
   - In a `DestinationRule`, inspect `.spec.host`.
   - Match this host to the target Service and link the DestinationRule to the Service.
4. **Pod Meshed Status**:
   - Check if a Pod is part of the mesh by inspecting if it contains a container named `istio-proxy`.
   - Mark the node property `meshed: true` if found.

_Link Types_: `"routes-to"`, `"configures"`, `"secures"`

### D. Security & Identity

Security resources control network boundaries and service identity.

1. **ServiceAccount ➔ Pod**:
   - Inspect the Pod's `.spec.serviceAccountName`.
   - Link the ServiceAccount to the Pod.
2. **PeerAuthentication ➔ Service / Namespace**:
   - Inspect `.spec.mtls.mode` (e.g., `STRICT`, `PERMISSIVE`).
   - If the PeerAuthentication applies to a namespace (no selector), attach its security parameters to the Namespace node.
   - If it has a selector (`.spec.selector.matchLabels`), link it to the matching Workload (Deployment/StatefulSet) to represent mTLS constraints.

_Link Types_: `"binds"`, `"secures"`

### E. Persistent Volumes & Storage

1. **Pod ➔ PVC (PersistentVolumeClaim)**:
   - Inspect the Pod's `.spec.volumes[*]`.
   - If a volume defines a `.persistentVolumeClaim.claimName`, link the Pod to the corresponding PVC.

_Link Types_: `"claims-volume"`

### F. Protocol Heuristics

Analyze port configurations to identify protocols (important for Three.js visual styling like speed of particle flow):

- Check Service port names and Pod container port names.
- If name starts with `grpc`, protocol is `gRPC`.
- If name starts with `http`, protocol is `HTTP`.
- If name starts with `mysql`, `postgres`, `redis`, label appropriately.
- Default to `TCP` if unspecified.

---

## 3. Command Execution Guide

When exploring the cluster, run commands in a structured, read-only manner.

### Phase 1: Context & Scope Discovery

```bash
# Get active namespaces
kubectl get namespaces -o json

# Get cluster nodes to see physical footprint
kubectl get nodes -o json
```

### Phase 2: Workloads & Core Objects

```bash
# Get all workloads across namespaces
kubectl get deployments,replicasets,statefulsets,daemonsets,pods -A -o json

# Get core networking and storage resources
kubectl get services,ingresses,persistentvolumeclaims -A -o json
```

### Phase 3: Istio Mesh Assets (If CRDs exist)

```bash
# Verify CRD existence
kubectl get crds | grep -E 'istio.io'

# Fetch Istio configuration
kubectl get gateways.networking.istio.io,virtualservices.networking.istio.io,destinationrules.networking.istio.io,peerauthentications.security.istio.io -A -o json
```

---

## 4. Graph Output JSON Schema

Write the compiled cluster topology to `cluster-graph.json` in the following format:

```json
{
  "nodes": [
    {
      "id": "node-unique-id", // Format: {type}/{namespace}/{name} or {type}/{name} (e.g., "pod/default/frontend-7bc8f-8d9e2")
      "name": "resource-name", // Display name (e.g., "frontend-7bc8f-8d9e2")
      "type": "namespace|node|pod|service|deployment|replicaset|statefulset|daemonset|ingress|gateway|virtualservice|destinationrule|serviceaccount|pvc",
      "namespace": "namespace-name", // Optional (omit for cluster-scoped like 'node' or 'namespace')
      "status": "Running|Pending|Failed|Active|Terminating|Bound", // Status indicator
      "labels": {
        "key": "value"
      },
      "details": {
        "podIP": "10.244.0.1", // Resource-specific details for the inspector
        "ports": [80, 443],
        "images": ["nginx:alpine"],
        "mtls": "STRICT"
      }
    }
  ],
  "links": [
    {
      "source": "source-node-id", // id of source node
      "target": "target-node-id", // id of target node
      "type": "manages|routes-to|exposes|configures|binds|secures|claims-volume",
      "protocol": "http|grpc|tcp|tls" // Optional, for networking connections
    }
  ]
}
```

---

## 5. Automation Warning

If the `explore.js` script is present in the repository root, you should execute it to collect the graph JSON automatically:

```bash
node explore.js
```

The script will perform all of the above mappings dynamically and output the graph directly. You can inspect `cluster-graph.json` to verify its syntax.

---

## 6. Dashboard Visual Specifications & Aesthetics

To maintain a futuristic, premium glassmorphic/cybernetic theme in the 3D Web Dashboard:

- **Bloom Glow**: Use `UnrealBloomPass` with a softened strength of `0.85` (radius `0.35`, threshold `0.15`) for high-fidelity halo effects.
- **Node Visual State Updates**: Update material opacities and emissive intensities dynamically via traversal (`updateNodeVisualStates()`) instead of triggering full mesh reconstruction on hover/search/inspector closing. This preserves real-time spinning and billboarding animations without causing meshes to flicker or disappear.
- **Deployment Nodes**: Scale Deployments 25% larger than default workloads (using a scale factor of `8.75` for the custom `ship_3d_icon.glb` or box size `6.0` for procedural fallback). Render them without any outer wireframe cube to let the ship float cleanly in space.
- **Logical Boundaries (Namespaces)**: Render as nested, double-layered dashed box wireframes (size `22` and `21.4`) with a glowing central 3D core cube (`0.18` base opacity).
- **Service Cogs**: Sized up to `15` and colored neon orange (`#ff6b00`), spinning on the Z-axis.
- **Istio Sails**: Rendered as two offset angled pyramids representing sails catching wind, rotating on the Y-axis.
- **Workload Billboarding**: Pods, Services, PVCs, Ingresses, Istio sails, Deployments, ReplicaSets, StatefulSets, DaemonSets, and ServiceAccounts must support Cylindrical (Upright) billboarding, keeping icons oriented towards the camera while locked upright.
