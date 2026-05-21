import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// State Management
let graphData = { nodes: [], links: [] };
let filteredData = { nodes: [], links: [] };
let activeFilters = {
  namespaces: new Set(),
  types: new Set(),
};
let selectedNode = null;
let hoveredNode = null;
const highlightNodes = new Set();
const highlightLinks = new Set();
let lockIconsUpright = true;

// 3D Graph Instance
let Graph = null;
let podModel = null;
let deploymentModel = null;
let isOrbiting = false;
let angle = 0;
let orbitInterval = null;

// UI Elements
const searchInput = document.getElementById('search-input');
const orbitBtn = document.getElementById('orbit-btn');
const resetBtn = document.getElementById('reset-btn');
const mockBtn = document.getElementById('mock-btn');
const loadBtn = document.getElementById('load-btn');
const inspector = document.getElementById('inspector-panel');
const closeInspectorBtn = document.getElementById('close-inspector');
const namespaceFiltersContainer = document.getElementById('namespace-filters');
const typeFiltersContainer = document.getElementById('type-filters');
const legendList = document.getElementById('legend-list');

// Statistics Elements
const statNodes = document.getElementById('stat-nodes');
const statLinks = document.getElementById('stat-links');
const statNamespaces = document.getElementById('stat-namespaces');
const statPods = document.getElementById('stat-pods');
const statusMessage = document.getElementById('status-message');
const dataSourceIndicator = document.getElementById('data-source-indicator');

// Node Styling Configurations
const resourceConfig = {
  namespace: { color: '#f43f5e', name: 'Namespace', size: 14, geo: 'torus' },
  node: { color: '#64748b', name: 'Node (Host)', size: 16, geo: 'box' },
  pod: { color: '#2496ed', name: 'Pod', size: 8, geo: 'sphere' },
  service: { color: '#ff6b00', name: 'Service', size: 15, geo: 'cylinder' },
  deployment: { color: '#8b5cf6', name: 'Deployment', size: 12, geo: 'box' },
  replicaset: { color: '#a78bfa', name: 'ReplicaSet', size: 9, geo: 'box' },
  statefulset: { color: '#f59e0b', name: 'StatefulSet', size: 12, geo: 'cone' },
  daemonset: { color: '#ec4899', name: 'DaemonSet', size: 12, geo: 'dodecahedron' },
  ingress: { color: '#eab308', name: 'Ingress', size: 10, geo: 'torus' },
  gateway: { color: '#ef4444', name: 'Istio Gateway', size: 12, geo: 'torus' },
  virtualservice: { color: '#06b6d4', name: 'VirtualService', size: 10, geo: 'octahedron' },
  destinationrule: { color: '#14b8a6', name: 'DestinationRule', size: 9, geo: 'tetrahedron' },
  serviceaccount: { color: '#d946ef', name: 'ServiceAccount', size: 6, geo: 'user' },
  pvc: { color: '#10b981', name: 'PersistentVolumeClaim', size: 9, geo: 'cylinder' },
};

// Global error monitoring to output errors directly to the status bar for debugging
window.addEventListener('error', event => {
  console.error('Caught global error:', event.error);
  const statusEl = document.getElementById('status-message');
  if (statusEl) {
    statusEl.innerHTML = `<span style="color: #f87171; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">⚠️ Script Error: ${event.message} (${event.filename.split('/').pop()}:${event.lineno})</span>`;
  }
});

// Global array to track rotating parts of custom composite nodes
let animatingMeshes = [];

// Starts the tick animation loop for rotating meshes
function startAnimationLoop() {
  function tick() {
    requestAnimationFrame(tick);

    // Purge elements that are no longer part of the active scene (e.g. filtered out or re-created)
    animatingMeshes = animatingMeshes.filter(item => {
      if (!item.mesh) {
        return false;
      }

      // Traverse up the parent chain to see if the element is connected to the Scene.
      // Simply checking .parent is not enough because discarded node groups still have their children attached,
      // creating a massive memory leak and CPU freeze.
      let isAttached = false;
      let obj = item.mesh;
      while (obj.parent) {
        if (obj.parent.type === 'Scene') {
          isAttached = true;
          break;
        }
        obj = obj.parent;
      }

      if (!isAttached) {
        return false; // Discard and stop animating
      }

      // Apply billboarding if registered
      if (item.billboard) {
        const camera = Graph.camera();
        if (camera) {
          if (lockIconsUpright) {
            // Cylindrical billboarding: always point straight up in world +Y (sky)
            const meshPos = item.mesh.position;
            const camPos = camera.position;
            const dir = new THREE.Vector3().subVectors(camPos, meshPos);
            dir.y = 0; // Lock vertical axis
            dir.normalize();

            if (dir.lengthSq() > 0) {
              const angle = Math.atan2(dir.x, dir.z);
              item.mesh.rotation.set(0, angle, 0);
            }
          } else {
            // Spherical billboarding: copy camera quaternion directly
            item.mesh.quaternion.copy(camera.quaternion);
          }
        }
      }

      // Apply rotation step
      if (item.rotateX) item.mesh.rotation.x += item.rotateX;
      if (item.rotateY) item.mesh.rotation.y += item.rotateY;
      if (item.rotateZ) item.mesh.rotation.z += item.rotateZ;

      return true; // Keep tracking
    });

    // Style link directional arrows to use self-luminous MeshBasicMaterial to prevent rendering black
    if (Graph) {
      const scene = Graph.scene();
      if (scene) {
        scene.traverse(child => {
          if (
            child.isMesh &&
            (child.__linkThreeObjType === 'arrow' ||
              (child.geometry && child.geometry.type === 'ConeGeometry'))
          ) {
            let isLinkArrow = false;
            let linkObj = null;
            let parent = child; // Start checking from the child itself as __data is bound to the arrow mesh
            while (parent) {
              if (
                parent.__data &&
                parent.__data.source !== undefined &&
                parent.__data.target !== undefined
              ) {
                isLinkArrow = true;
                linkObj = parent.__data;
                break;
              }
              parent = parent.parent;
            }
            if (isLinkArrow && linkObj) {
              let colorVal = '#3b82f6';
              if (highlightLinks.has(linkObj)) colorVal = '#818cf8';
              else if (linkObj.type === 'secures') colorVal = '#10b981';
              else if (linkObj.type === 'manages') colorVal = '#a78bfa';
              else if (linkObj.protocol === 'grpc') colorVal = '#22d3ee';
              else if (linkObj.protocol === 'http') colorVal = '#fbbf24';

              if (!(child.material instanceof THREE.MeshBasicMaterial)) {
                if (child.material && typeof child.material.dispose === 'function') {
                  child.material.dispose();
                }
                child.material = new THREE.MeshBasicMaterial({
                  color: colorVal,
                  fog: false,
                  transparent: true,
                  opacity: 0.85,
                });
              } else {
                const hexStr = colorVal.replace('#', '').toLowerCase();
                if (child.material.color.getHexString() !== hexStr) {
                  child.material.color.set(colorVal);
                }
              }
            }
          }
        });
      }
    }
  }
  tick();
}

// ==========================================================================
// Initialization & Loading Data
// ==========================================================================

window.addEventListener('DOMContentLoaded', () => {
  initUI();
  loadPodModel();
  loadDeploymentModel();
  initGraph();
  startAnimationLoop();
  loadData();
});

function loadPodModel() {
  const loader = new GLTFLoader();
  loader.load(
    '/models/moby_dock.glb',
    gltf => {
      podModel = gltf.scene;
      console.log('Successfully loaded custom Moby Dock model from Sketchfab!');
      // Refresh the graph's node 3D objects to display the loaded model
      if (Graph) {
        Graph.nodeThreeObject(Graph.nodeThreeObject());
      }
    },
    undefined,
    _error => {
      console.warn(
        'Custom pod model "/models/moby_dock.glb" not found. Falling back to procedural Docker whale.'
      );
    }
  );
}

function loadDeploymentModel() {
  const loader = new GLTFLoader();
  loader.load(
    '/models/ship_3d_icon.glb',
    gltf => {
      deploymentModel = gltf.scene;
      console.log('Successfully loaded custom Deployment model (ship_3d_icon.glb)!');
      // Refresh the graph's node 3D objects to display the loaded model
      if (Graph) {
        Graph.nodeThreeObject(Graph.nodeThreeObject());
      }
    },
    undefined,
    _error => {
      console.warn(
        'Custom deployment model "/models/ship_3d_icon.glb" not found. Falling back to procedural deployment cube.'
      );
    }
  );
}

function initUI() {
  // Setup tabs
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const paneId = tab.dataset.tab;
      document.getElementById(paneId).classList.add('active');
    });
  });

  // Action Button Listeners
  orbitBtn.addEventListener('click', toggleOrbit);
  resetBtn.addEventListener('click', resetCamera);
  mockBtn.addEventListener('click', () => loadMockData(true));
  loadBtn.addEventListener('click', () => loadData(true));
  closeInspectorBtn.addEventListener('click', closeInspector);

  // Namespace quick actions
  document.getElementById('ns-all-btn').addEventListener('click', () => toggleAllNamespaces(true));
  document
    .getElementById('ns-none-btn')
    .addEventListener('click', () => toggleAllNamespaces(false));

  // Search input matching
  searchInput.addEventListener('input', handleSearch);

  // Billboard upright toggle
  const uprightChk = document.getElementById('billboard-upright-chk');
  if (uprightChk) {
    uprightChk.checked = lockIconsUpright;
    uprightChk.addEventListener('change', e => {
      lockIconsUpright = e.target.checked;
      statusMessage.textContent = lockIconsUpright
        ? 'Upright (cylindrical) billboarding active.'
        : 'Screen-space (spherical) billboarding active.';
    });
  }

  // Render Legend
  renderLegend();
}

function initGraph() {
  const container = document.getElementById('graph-3d');
  Graph = ForceGraph3D()(container)
    .backgroundColor('#000000')
    .showNavInfo(false)
    .nodeRelSize(1)
    .nodeVal(node => resourceConfig[node.type]?.size || 8)
    .nodeLabel(node => {
      const nsText = node.namespace ? ` [${node.namespace}]` : '';
      const statusText = node.status ? ` - Status: ${node.status}` : '';
      return `<div class="graph-tooltip-title">${node.name}${nsText}</div>
              <div class="graph-tooltip-desc">Type: ${resourceConfig[node.type]?.name || node.type}${statusText}</div>`;
    })
    .nodeThreeObject(node => createCustomNodeObject(node))
    .nodeThreeObjectExtend(false) // Replace default sphere completely
    .linkWidth(link => {
      if (highlightLinks.has(link)) return 1.2;
      return 0.35; // Thinner cyberpunk wire lines
    })
    .linkOpacity(link => {
      if (highlightLinks.size > 0 && !highlightLinks.has(link)) return 0.05;
      return 0.4; // Lower opacity for default links to keep them subtle
    })
    .linkCurvature(0) // Strictly straight connections
    .linkColor(link => {
      if (highlightLinks.has(link)) return '#818cf8'; // Glowing indigo highlight
      // Color-code link based on protocol/type
      if (link.type === 'secures') return '#10b981'; // green for security
      if (link.type === 'manages') return '#a78bfa'; // purple for workload tree
      if (link.protocol === 'grpc') return '#22d3ee'; // glowing cyan
      if (link.protocol === 'http') return '#fbbf24'; // glowing amber
      return '#3b82f6'; // default blue
    })
    .linkDirectionalParticles(link => {
      // Return particle count based on connectivity
      if (highlightLinks.has(link)) return 4; // Reduced particle count
      if (['routes-to', 'exposes'].includes(link.type)) {
        return 2; // Reduced traffic flow particles
      }
      return 0; // No traffic flows on static config/management links
    })
    .linkDirectionalParticleWidth(link => (highlightLinks.has(link) ? 1.6 : 0.9))
    .linkDirectionalParticleColor(link => {
      // Bright, fully saturated neon emissive colors for traffic particles (so they don't look dark)
      if (highlightLinks.has(link)) return '#ffffff'; // White hot highlight
      if (link.protocol === 'grpc') return '#22d3ee'; // Electric cyan
      if (link.protocol === 'http') return '#fbbf24'; // Electric amber
      return '#60a5fa'; // Bright blue
    })
    .linkDirectionalParticleThreeObject(link => {
      // Create a bright, self-luminous neon glowing sphere for the traffic particles
      // MeshBasicMaterial does not require scene lighting and is 100% bright,
      // and we set fog: false so they stay fully visible at any zoom distance!
      let colorVal = '#60a5fa'; // Bright blue default
      if (highlightLinks.has(link))
        colorVal = '#ffffff'; // White hot highlight
      else if (link.protocol === 'grpc')
        colorVal = '#22d3ee'; // Electric cyan
      else if (link.protocol === 'http') colorVal = '#fbbf24'; // Electric amber

      const size = highlightLinks.has(link) ? 1.6 : 0.9;
      const geometry = new THREE.SphereGeometry(size, 8, 8);
      const material = new THREE.MeshBasicMaterial({
        color: colorVal,
        fog: false,
      });
      return new THREE.Mesh(geometry, material);
    })
    .linkDirectionalParticleSpeed(link => {
      if (link.protocol === 'grpc') return 0.025; // gRPC is fast!
      if (link.protocol === 'http') return 0.012; // HTTP is medium
      return 0.006; // standard TCP
    })
    .linkDirectionalArrowLength(link => {
      // Traffic arrows for active networking routes
      if (['routes-to', 'exposes'].includes(link.type)) return 2.8;
      return 0;
    })
    .linkDirectionalArrowRelPos(0.55) // Position arrows in the middle of links
    .linkDirectionalArrowColor(link => {
      if (highlightLinks.has(link)) return '#818cf8';
      if (link.protocol === 'grpc') return '#22d3ee';
      if (link.protocol === 'http') return '#fbbf24';
      return '#3b82f6';
    })
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick);

  // Configure custom physics engine forces for object spacing
  Graph.d3Force('link').distance(link => {
    // Obtain source/target node references (either object or by finding in graphData)
    const sourceNode =
      typeof link.source === 'object'
        ? link.source
        : Graph.graphData().nodes.find(n => n.id === link.source);
    const targetNode =
      typeof link.target === 'object'
        ? link.target
        : Graph.graphData().nodes.find(n => n.id === link.target);

    if (!sourceNode || !targetNode) return 40;

    // Namespace containment links - space them out so objects sit outside the bounding boxes
    if (sourceNode.type === 'namespace' || targetNode.type === 'namespace') {
      return 120;
    }
    // Service nodes - space out from connected pods/routing endpoints to prevent overlapping cogs
    if (sourceNode.type === 'service' || targetNode.type === 'service') {
      return 68;
    }
    // Node physical hosts - separate physical infrastructure from workloads
    if (sourceNode.type === 'node' || targetNode.type === 'node') {
      return 75;
    }
    // Default link distance for other workloads and controllers
    return 45;
  });

  // Repel larger nodes more strongly to prevent clusters overlapping
  Graph.d3Force('charge').strength(node => {
    if (node.type === 'namespace') return -1000;
    if (node.type === 'node') return -600;
    if (node.type === 'service') return -400;
    return -120; // default d3 charge strength is usually -30, we boost it to -120 to space out everything nicely
  });

  // Add Cyberpunk 3D Scene Elements
  const scene = Graph.scene();

  // 1. Grid Floor removed per user settings

  // 2. Floating Digital Coordinate Particles (Digital Dust)
  const particleCount = 450;
  const particleGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount * 3; i += 3) {
    positions[i] = (Math.random() - 0.5) * 1400; // X
    positions[i + 1] = (Math.random() - 0.5) * 900 + 100; // Y (centered above grid)
    positions[i + 2] = (Math.random() - 0.5) * 1400; // Z
  }
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  // Custom glowing round texture using canvas
  const createParticleTexture = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    grad.addColorStop(0, 'rgba(34, 211, 238, 1)'); // Cyan core
    grad.addColorStop(0.3, 'rgba(34, 211, 238, 0.7)');
    grad.addColorStop(1, 'rgba(34, 211, 238, 0)'); // fade out
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 16);
    return new THREE.CanvasTexture(canvas);
  };

  const particleMaterial = new THREE.PointsMaterial({
    color: 0x22d3ee,
    size: 2.5,
    transparent: true,
    opacity: 0.5,
    map: createParticleTexture(),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const digitalDust = new THREE.Points(particleGeometry, particleMaterial);
  scene.add(digitalDust);

  // Animate the dust rotation very slowly
  animatingMeshes.push({ mesh: digitalDust, rotateY: 0.0003, rotateX: 0.0001 });

  // Add custom lights directly to the scene to brighten everything up and introduce colored specular cyberpunk highlights.
  // AmbientLight provides a high baseline brightness so nodes never look dark.
  const ambientLight = new THREE.AmbientLight('#ffffff', 0.95);
  scene.add(ambientLight);

  // Directional lights from opposing sides with cyan and magenta colors to create awesome cyberpunk bi-color edge specular highlights
  const neonBlueLight = new THREE.DirectionalLight('#00ffff', 1.8);
  neonBlueLight.position.set(200, 400, 200);
  scene.add(neonBlueLight);

  const neonPinkLight = new THREE.DirectionalLight('#ff007f', 1.8);
  neonPinkLight.position.set(-200, -400, -200);
  scene.add(neonPinkLight);

  // 3. Fog (Distant nodes/links fade into dark cyberpunk atmosphere)
  // Using linear THREE.Fog with wide range to prevent the graph from blacking out when zoomed out
  scene.fog = new THREE.Fog('#000000', 4500, 25000);

  // 4. Safe UnrealBloomPass post-processing initialization (deferred to prevent setup blocking)
  setTimeout(() => {
    try {
      const composer = Graph.postProcessingComposer();
      if (composer) {
        const bloomPass = new UnrealBloomPass(
          new THREE.Vector2(window.innerWidth, window.innerHeight),
          0.85, // softened bloom strength from 1.4 for a clean look
          0.35, // tighter radius to keep edges glowing but clean
          0.15 // bloom threshold
        );
        composer.addPass(bloomPass);
        console.log('Cyberpunk UnrealBloomPass initialized successfully.');
      } else {
        console.warn('PostProcessingComposer not available on Graph instance.');
      }
    } catch (err) {
      console.error('Error during UnrealBloomPass setup:', err);
    }
  }, 150);

  // 5. Safe OrbitControls configuration (damping for premium fluid feel, retried until loaded)
  let controlsAttempts = 0;
  const configureControls = () => {
    try {
      const controls = Graph.controls();
      if (controls) {
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        console.log('OrbitControls damping configured successfully.');
      } else if (controlsAttempts < 10) {
        controlsAttempts++;
        setTimeout(configureControls, 150);
      } else {
        console.warn('OrbitControls not available after maximum retry attempts.');
      }
    } catch (err) {
      console.error('Error configuring OrbitControls:', err);
    }
  };
  setTimeout(configureControls, 150);

  // Resize handler
  window.addEventListener('resize', () => {
    Graph.width(container.clientWidth);
    Graph.height(container.clientHeight);
  });
}

// Helper to draw a procedural gear/cog shape in 2D
function createCogShape(innerRadius, outerRadius, teethCount) {
  const shape = new THREE.Shape();
  const toothAngle = (Math.PI * 2) / teethCount;

  for (let i = 0; i < teethCount; i++) {
    const angle = i * toothAngle;

    // Four coordinates per tooth to make a blocky, mechanical cog profile
    const a1 = angle - toothAngle * 0.25;
    const a2 = angle - toothAngle * 0.12;
    const a3 = angle + toothAngle * 0.12;
    const a4 = angle + toothAngle * 0.25;

    const x1 = Math.cos(a1) * innerRadius;
    const y1 = Math.sin(a1) * innerRadius;
    const x2 = Math.cos(a2) * outerRadius;
    const y2 = Math.sin(a2) * outerRadius;
    const x3 = Math.cos(a3) * outerRadius;
    const y3 = Math.sin(a3) * outerRadius;
    const x4 = Math.cos(a4) * innerRadius;
    const y4 = Math.sin(a4) * innerRadius;

    if (i === 0) {
      shape.moveTo(x1, y1);
    } else {
      shape.lineTo(x1, y1);
    }
    shape.lineTo(x2, y2);
    shape.lineTo(x3, y3);
    shape.lineTo(x4, y4);
  }

  shape.closePath();

  // Cut a hollow axle hole in the center of the cog
  const holePath = new THREE.Path();
  holePath.absarc(0, 0, innerRadius * 0.45, 0, Math.PI * 2, true);
  shape.holes.push(holePath);

  return shape;
}

// Custom 3D Object builders for nodes
function createCustomNodeObject(node) {
  const config = resourceConfig[node.type] || { color: '#94a3b8', size: 8 };
  const size = config.size;
  let color = config.color;

  // Highlights/Dimming adjustments
  let isDimmed = false;
  if (highlightNodes.size > 0 && !highlightNodes.has(node)) {
    color = '#1e293b'; // dim slate color
    isDimmed = true;
  }

  // Create group for composite shapes
  const group = new THREE.Group();

  // Create shared material helpers
  const isHealthy = ['Running', 'Ready', 'Active'].includes(node.status);
  const isFailed = ['Failed', 'NotReady', 'Degraded'].includes(node.status);

  let material;
  if (highlightNodes.has(node) || node === selectedNode) {
    material = new THREE.MeshPhongMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 2.2, // Boosted glow for selected/highlighted nodes
      shininess: 50,
      transparent: true,
      opacity: 1.0,
    });
  } else if (isDimmed) {
    material = new THREE.MeshPhongMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.1, // very low emissive when dimmed
      shininess: 5,
      transparent: true,
      opacity: 0.15,
    });
  } else {
    // Give all non-dimmed nodes a baseline self-luminous neon glow so they never get pitch-black
    let baseEmissiveColor = color;
    let baseEmissiveIntensity = 0.75; // baseline emissive for namespaces, config, deployments etc.

    // Customize based on Pod or Service health status if applicable
    if (node.type === 'pod' || node.type === 'service') {
      baseEmissiveColor = isHealthy ? color : isFailed ? '#ef4444' : color;
      baseEmissiveIntensity = isHealthy ? 1.0 : isFailed ? 1.8 : 0.7;
    }

    material = new THREE.MeshPhongMaterial({
      color: color,
      emissive: baseEmissiveColor,
      emissiveIntensity: baseEmissiveIntensity,
      shininess: 30,
      transparent: true,
      opacity: 0.9, // Slightly increased opacity from 0.85
    });
  }

  // Dedicated basic wireframe material for self-luminous neon glow (independent of scene lighting)
  const wireMaterial = new THREE.MeshBasicMaterial({
    color: color,
    wireframe: true,
    transparent: true,
    opacity: isDimmed ? 0.04 : 0.65,
  });

  // Build composite geometry based on resource type
  switch (node.type) {
    case 'pod': {
      if (podModel) {
        // Clone the loaded Moby Dock 3D model
        const modelClone = podModel.clone();

        // Traverse the model to apply our theme-compliant materials
        modelClone.traverse(child => {
          if (child.isMesh) {
            child.material = material;
          }
        });

        // Normalize scaling and position
        const box = new THREE.Box3().setFromObject(modelClone);
        const sizeVec = new THREE.Vector3();
        box.getSize(sizeVec);
        const maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z);
        if (maxDim > 0) {
          const scaleFactor = 7.5 / maxDim;
          modelClone.scale.set(scaleFactor, scaleFactor, scaleFactor);
        }

        const center = new THREE.Vector3();
        box.getCenter(center);
        modelClone.position.sub(center.multiplyScalar(modelClone.scale.x));

        group.add(modelClone);

        // 3. A single glowing cargo container box on the whale's back
        const boxGeo = new THREE.BoxGeometry(2.0, 1.4, 1.4);
        const boxColor = isDimmed ? '#1e293b' : isFailed ? '#ef4444' : '#22d3ee';

        const boxMat = new THREE.MeshPhongMaterial({
          color: boxColor,
          emissive: isDimmed ? '#000000' : boxColor,
          emissiveIntensity: isDimmed ? 0 : 1.4,
          shininess: 40,
          transparent: true,
          opacity: isDimmed ? 0.15 : 0.95,
        });

        const boxMesh = new THREE.Mesh(boxGeo, boxMat);
        boxMesh.position.set(0, 2.5, 0); // elevated to sit on its back
        group.add(boxMesh);

        // Glowing container wireframe cage
        if (!isDimmed) {
          const wireMat = new THREE.MeshBasicMaterial({
            color: '#ffffff',
            wireframe: true,
            transparent: true,
            opacity: 0.8,
          });
          const wireMesh = new THREE.Mesh(boxGeo, wireMat);
          wireMesh.position.set(0, 2.5, 0);
          group.add(wireMesh);
        }
      } else {
        // Fallback: 1. Stylized 3D Docker Whale Body (ellipsoid)
        const whaleBodyGeo = new THREE.SphereGeometry(2.4, 16, 12);
        whaleBodyGeo.scale(1.7, 1.0, 1.0); // stretch along X-axis
        const whaleBodyMesh = new THREE.Mesh(whaleBodyGeo, material);
        group.add(whaleBodyMesh);

        // Fallback: 2. Whale Tail (Fluke)
        const tailGeo = new THREE.ConeGeometry(0.9, 2.5, 4);
        tailGeo.rotateZ(-Math.PI / 4); // tilt tail upwards
        const tailMesh = new THREE.Mesh(tailGeo, material);
        tailMesh.position.set(-3.5, 1.2, 0);
        group.add(tailMesh);

        // Fallback: Tail Fins (fluke fin)
        const finGeo = new THREE.BoxGeometry(0.4, 1.2, 2.6);
        const finMesh = new THREE.Mesh(finGeo, material);
        finMesh.position.set(-4.8, 2.0, 0);
        finMesh.rotation.z = Math.PI / 6;
        group.add(finMesh);

        // Fallback: 3. A single glowing cargo container box on the whale's back
        const boxGeo = new THREE.BoxGeometry(2.0, 1.4, 1.4);
        const boxColor = isDimmed ? '#1e293b' : isFailed ? '#ef4444' : '#22d3ee'; // bright neon cyan when healthy, red when failed

        const boxMat = new THREE.MeshPhongMaterial({
          color: boxColor,
          emissive: isDimmed ? '#000000' : boxColor,
          emissiveIntensity: isDimmed ? 0 : 1.4,
          shininess: 40,
          transparent: true,
          opacity: isDimmed ? 0.15 : 0.95,
        });

        const boxMesh = new THREE.Mesh(boxGeo, boxMat);
        boxMesh.position.set(-0.2, 2.9, 0);
        group.add(boxMesh);

        // Glowing container wireframe cage
        if (!isDimmed) {
          const wireMat = new THREE.MeshBasicMaterial({
            color: '#ffffff',
            wireframe: true,
            transparent: true,
            opacity: 0.8,
          });
          const wireMesh = new THREE.Mesh(boxGeo, wireMat);
          wireMesh.position.set(-0.2, 2.9, 0);
          group.add(wireMesh);
        }
      }

      // Orthogonal rotating orbit rings if meshed (Istio)
      if (node.details?.meshed && !isDimmed) {
        const ringGeo = new THREE.TorusGeometry(6.2, 0.28, 6, 24); // scaled up slightly to orbit the whale body
        const ringMat = new THREE.MeshBasicMaterial({
          color: '#22d3ee',
          transparent: true,
          opacity: 0.75,
        });

        const ring1 = new THREE.Mesh(ringGeo, ringMat);
        ring1.rotation.x = Math.PI / 2;
        group.add(ring1);
        animatingMeshes.push({ mesh: ring1, rotateY: 0.02, rotateX: 0.005 });

        const ring2 = new THREE.Mesh(ringGeo, ringMat);
        ring2.rotation.y = Math.PI / 2;
        group.add(ring2);
        animatingMeshes.push({ mesh: ring2, rotateX: -0.02, rotateY: 0.005 });
      }
      break;
    }
    case 'service': {
      // Extruded 3D mechanical cog shape - sized up to emphasize service gateways
      const cogShape = createCogShape(3.5, 5.4, 8);
      const extrudeSettings = {
        depth: 2.8,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.22,
        bevelThickness: 0.22,
      };
      const cogGeo = new THREE.ExtrudeGeometry(cogShape, extrudeSettings);
      cogGeo.center(); // Center the geometry around its local origin

      const cogGroup = new THREE.Group();

      const cogMesh = new THREE.Mesh(cogGeo, material);
      cogGroup.add(cogMesh);

      // Wireframe overlay for technical styling parity
      const wireGeo = new THREE.ExtrudeGeometry(cogShape, extrudeSettings);
      wireGeo.center();
      const wireMesh = new THREE.Mesh(wireGeo, wireMaterial);
      cogGroup.add(wireMesh);

      group.add(cogGroup);

      if (!isDimmed) {
        animatingMeshes.push({ mesh: cogGroup, rotateZ: 0.015 }); // Spin around Z axis (front dial spinning)
      }
      break;
    }
    case 'statefulset': {
      // Stack of three database disk trays (represents persistent state)
      const diskGeo = new THREE.CylinderGeometry(3.5, 3.5, 1.2, 8);

      const diskGroup = new THREE.Group();

      const disk1 = new THREE.Mesh(diskGeo, material);
      disk1.position.y = 2.0;
      diskGroup.add(disk1);

      const disk2 = new THREE.Mesh(diskGeo, material);
      disk2.position.y = 0;
      diskGroup.add(disk2);

      const disk3 = new THREE.Mesh(diskGeo, material);
      disk3.position.y = -2.0;
      diskGroup.add(disk3);

      group.add(diskGroup);

      if (!isDimmed) {
        animatingMeshes.push({ mesh: diskGroup, rotateY: 0.008 }); // Spin disks locally
      }
      break;
    }
    case 'deployment': {
      if (deploymentModel) {
        // Clone the loaded ship model
        const modelClone = deploymentModel.clone();

        // Traverse the model to apply our theme-compliant materials
        modelClone.traverse(child => {
          if (child.isMesh) {
            child.material = material;
          }
        });

        // Normalize scaling and position
        const box = new THREE.Box3().setFromObject(modelClone);
        const sizeVec = new THREE.Vector3();
        box.getSize(sizeVec);
        const maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z);
        if (maxDim > 0) {
          // Adjust scale to fit the cluster layout nicely (25% larger from 7.0 to 8.75)
          const scaleFactor = 8.75 / maxDim;
          modelClone.scale.set(scaleFactor, scaleFactor, scaleFactor);
        }

        const center = new THREE.Vector3();
        box.getCenter(center);
        modelClone.position.sub(center.multiplyScalar(modelClone.scale.x));

        group.add(modelClone);
      } else {
        // Fallback procedural layout: Solid center box (25% larger from 4.8 to 6.0)
        const boxGeo = new THREE.BoxGeometry(6.0, 6.0, 6.0);
        const boxMesh = new THREE.Mesh(boxGeo, material);
        group.add(boxMesh);
      }
      break;
    }
    case 'replicaset': {
      // Simple nested workload box
      const boxGeo = new THREE.BoxGeometry(4.2, 4.2, 4.2);
      const boxMesh = new THREE.Mesh(boxGeo, material);
      group.add(boxMesh);
      break;
    }
    case 'daemonset': {
      const dodecaGeo = new THREE.DodecahedronGeometry(3);
      const dodecaMesh = new THREE.Mesh(dodecaGeo, material);
      group.add(dodecaMesh);

      const outerGeo = new THREE.DodecahedronGeometry(4.5);
      const outerMesh = new THREE.Mesh(outerGeo, wireMaterial);
      group.add(outerMesh);

      if (!isDimmed) {
        animatingMeshes.push({ mesh: outerMesh, rotateY: 0.008, rotateZ: 0.003 });
      }
      break;
    }
    case 'gateway':
    case 'virtualservice':
    case 'destinationrule': {
      // Istio Sail: two 3D pyramids (Cones with 4 radial segments)
      const sailsGroup = new THREE.Group();

      // Sail 1 (Main sail): Large pyramid shape tilted back
      const sail1Geo = new THREE.ConeGeometry(2.5, 6.0, 4);
      sail1Geo.rotateY(Math.PI / 4); // Align flat faces with axes so it's a square pyramid
      const sail1 = new THREE.Mesh(sail1Geo, material);
      sail1.position.set(-1.0, 0.4, 0);
      sail1.rotation.z = -0.12; // tilt back slightly
      sail1.rotation.x = 0.05;
      sailsGroup.add(sail1);

      // Sail 2 (Jib/Fore sail): Smaller pyramid shape offset to the side/front
      const sail2Geo = new THREE.ConeGeometry(1.6, 4.0, 4);
      sail2Geo.rotateY(Math.PI / 4);
      const sail2 = new THREE.Mesh(sail2Geo, material);
      sail2.position.set(1.4, -0.6, 0.2); // Offset to side/front
      sail2.rotation.z = 0.15; // tilt forward
      sail2.rotation.x = -0.05;
      sailsGroup.add(sail2);

      // Wireframe overlays for tech detail aesthetic
      const wireSail1 = new THREE.Mesh(sail1Geo, wireMaterial);
      wireSail1.position.copy(sail1.position);
      wireSail1.rotation.copy(sail1.rotation);
      sailsGroup.add(wireSail1);

      const wireSail2 = new THREE.Mesh(sail2Geo, wireMaterial);
      wireSail2.position.copy(sail2.position);
      wireSail2.rotation.copy(sail2.rotation);
      sailsGroup.add(wireSail2);

      group.add(sailsGroup);

      if (!isDimmed) {
        animatingMeshes.push({ mesh: sailsGroup, rotateY: 0.012 }); // Spin sails locally
      }
      break;
    }
    case 'ingress': {
      // Ingress ring
      const ringTorus = new THREE.TorusGeometry(4, 0.6, 6, 20);
      const ringMesh = new THREE.Mesh(ringTorus, material);
      group.add(ringMesh);
      break;
    }
    case 'pvc': {
      // PVC: short wide cylinder representing a storage platter/volume
      const cylGeo = new THREE.CylinderGeometry(3.6, 3.6, 1.8, 16);

      const pvcGroup = new THREE.Group();

      const cylMesh = new THREE.Mesh(cylGeo, material);
      pvcGroup.add(cylMesh);

      // Wireframe overlay for modern aesthetic
      const wireCyl = new THREE.Mesh(cylGeo, wireMaterial);
      pvcGroup.add(wireCyl);

      // Add a couple of horizontal outer ring bands for a technical detail
      const ringGeo = new THREE.CylinderGeometry(3.7, 3.7, 0.2, 16);
      const ringMesh = new THREE.Mesh(ringGeo, wireMaterial);
      pvcGroup.add(ringMesh);

      group.add(pvcGroup);

      if (!isDimmed) {
        animatingMeshes.push({ mesh: pvcGroup, rotateY: 0.01 }); // Spin volume locally
      }
      break;
    }
    case 'node': {
      // Host VM: solid execution core
      const coreGeo = new THREE.BoxGeometry(3.5, 3.5, 3.5);
      const coreMesh = new THREE.Mesh(coreGeo, material);
      group.add(coreMesh);

      // Large hosting frame
      const frameGeo = new THREE.BoxGeometry(11, 11, 11);
      const frameMesh = new THREE.Mesh(frameGeo, wireMaterial);
      group.add(frameMesh);
      break;
    }
    case 'namespace': {
      // Logical Namespace boundary box (with double-dashed lines and a glowing core)
      const nsGroup = new THREE.Group();

      // Outer dashed box
      const boxGeoOuter = new THREE.BoxGeometry(22, 22, 22);
      const edgesOuter = new THREE.EdgesGeometry(boxGeoOuter);
      const lineMatOuter = new THREE.LineDashedMaterial({
        color: color,
        dashSize: 2.5,
        gapSize: 1.5,
        transparent: true,
        opacity: isDimmed ? 0.08 : 0.95,
        linewidth: 2.5,
      });
      const lineMeshOuter = new THREE.LineSegments(edgesOuter, lineMatOuter);
      lineMeshOuter.computeLineDistances();
      lineMeshOuter.userData = { type: 'dashed-outer' };
      nsGroup.add(lineMeshOuter);

      // Inner dashed box (nested offset to simulate thickness and high-tech layering)
      const boxGeoInner = new THREE.BoxGeometry(21.4, 21.4, 21.4);
      const edgesInner = new THREE.EdgesGeometry(boxGeoInner);
      const lineMatInner = new THREE.LineDashedMaterial({
        color: color,
        dashSize: 1.8,
        gapSize: 1.2,
        transparent: true,
        opacity: isDimmed ? 0.04 : 0.65,
        linewidth: 1.5,
      });
      const lineMeshInner = new THREE.LineSegments(edgesInner, lineMatInner);
      lineMeshInner.computeLineDistances();
      lineMeshInner.userData = { type: 'dashed-inner' };
      nsGroup.add(lineMeshInner);

      // Subtle glowing core at the center of the namespace to give it volume and presence
      const coreGeo = new THREE.BoxGeometry(7, 7, 7);
      const coreMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: isDimmed ? 0.02 : 0.18,
        wireframe: false,
      });
      const coreMesh = new THREE.Mesh(coreGeo, coreMat);
      coreMesh.userData = { type: 'core' };
      nsGroup.add(coreMesh);

      // Wireframe overlay on the core for extra detail
      const coreWireGeo = new THREE.BoxGeometry(7.1, 7.1, 7.1);
      const coreWireEdges = new THREE.EdgesGeometry(coreWireGeo);
      const coreWireMat = new THREE.LineBasicMaterial({
        color: color,
        transparent: true,
        opacity: isDimmed ? 0.03 : 0.4,
      });
      const coreWireMesh = new THREE.LineSegments(coreWireEdges, coreWireMat);
      coreWireMesh.userData = { type: 'core-wire' };
      nsGroup.add(coreWireMesh);

      group.add(nsGroup);

      if (!isDimmed) {
        animatingMeshes.push({ mesh: nsGroup, rotateY: 0.002, rotateX: 0.001 });
      }
      break;
    }
    case 'serviceaccount': {
      // 3D User Icon: Sphere (head) on a Cone (torso) representing a standard user avatar
      const headGeo = new THREE.SphereGeometry(1.4, 16, 16);
      const torsoGeo = new THREE.ConeGeometry(2.2, 3.2, 16);
      torsoGeo.center();

      const avatarGroup = new THREE.Group();

      const headMesh = new THREE.Mesh(headGeo, material);
      headMesh.position.y = 1.8; // Sit head on top of the torso

      const torsoMesh = new THREE.Mesh(torsoGeo, material);
      torsoMesh.position.y = -0.6; // Torso body offset

      avatarGroup.add(headMesh);
      avatarGroup.add(torsoMesh);

      // Wireframe outlines for styling consistency
      const headWire = new THREE.Mesh(headGeo, wireMaterial);
      headWire.position.copy(headMesh.position);

      const torsoWire = new THREE.Mesh(torsoGeo, wireMaterial);
      torsoWire.position.copy(torsoMesh.position);

      avatarGroup.add(headWire);
      avatarGroup.add(torsoWire);

      group.add(avatarGroup);

      if (!isDimmed) {
        animatingMeshes.push({ mesh: avatarGroup, rotateY: 0.015 }); // Spin avatar locally
      }
      break;
    }
    default: {
      const geo = new THREE.SphereGeometry(size / 2, 16, 16);
      const fallbackMesh = new THREE.Mesh(geo, material);
      group.add(fallbackMesh);
      break;
    }
  }

  // Apply billboarding to keep 3D workload/networking icons always pointing up/facing the camera
  const billboardTypes = [
    'pod',
    'service',
    'serviceaccount',
    'pvc',
    'ingress',
    'gateway',
    'virtualservice',
    'destinationrule',
    'statefulset',
    'deployment',
    'replicaset',
    'daemonset',
  ];
  if (billboardTypes.includes(node.type)) {
    animatingMeshes.push({ mesh: group, billboard: true });
  }

  return group;
}

// ==========================================================================
// Data Operations & Parsing
// ==========================================================================

async function loadData(forceReload = false) {
  statusMessage.textContent = 'Fetching cluster-graph.json...';
  try {
    const url = forceReload ? `/cluster-graph.json?t=${Date.now()}` : '/cluster-graph.json';
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('File not found');
    }
    const data = await response.json();
    if (!data.nodes || data.nodes.length === 0) {
      throw new Error('Graph data is empty');
    }

    graphData = data;
    dataSourceIndicator.textContent = 'Live Cluster';
    dataSourceIndicator.className = 'badge live';
    statusMessage.textContent = `Loaded ${graphData.nodes.length} nodes from cluster-graph.json.`;

    processLoadedData();
  } catch (error) {
    console.warn(
      'Failed to load live cluster-graph.json. Generating interactive mock data...',
      error
    );
    loadMockData(false);
  }
}

function processLoadedData() {
  // Extract all unique namespaces
  const namespaces = new Set();
  const types = new Set();

  graphData.nodes.forEach(node => {
    if (node.namespace) namespaces.add(node.namespace);
    if (node.type) types.add(node.type);
  });

  // Set default filters
  activeFilters.namespaces = new Set(namespaces);
  activeFilters.types = new Set(types);

  // Render filter lists
  renderFilters(Array.from(namespaces).sort(), Array.from(types).sort());

  // Apply filtering
  applyFilters();
}

function renderFilters(namespaces, types) {
  // Namespaces
  namespaceFiltersContainer.innerHTML = '';
  if (namespaces.length === 0) {
    namespaceFiltersContainer.innerHTML = '<p class="placeholder-text">Cluster-scoped only.</p>';
  } else {
    namespaces.forEach(ns => {
      const count = graphData.nodes.filter(n => n.namespace === ns).length;

      const div = document.createElement('label');
      div.className = 'checkbox-item';
      div.innerHTML = `
        <input type="checkbox" value="${ns}" checked>
        <span class="label">${ns}</span>
        <span class="badge">${count}</span>
      `;
      div.querySelector('input').addEventListener('change', e => {
        if (e.target.checked) {
          activeFilters.namespaces.add(ns);
        } else {
          activeFilters.namespaces.delete(ns);
        }
        applyFilters();
      });
      namespaceFiltersContainer.appendChild(div);
    });
  }

  // Resource Types
  typeFiltersContainer.innerHTML = '';
  types.forEach(type => {
    const count = graphData.nodes.filter(n => n.type === type).length;
    const config = resourceConfig[type] || { color: '#fff', name: type };

    const div = document.createElement('label');
    div.className = 'checkbox-item';
    div.innerHTML = `
      <input type="checkbox" value="${type}" checked>
      <span class="legend-color" style="color: ${config.color}; background-color: ${config.color}"></span>
      <span class="label">${config.name}</span>
      <span class="badge">${count}</span>
    `;
    div.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) {
        activeFilters.types.add(type);
      } else {
        activeFilters.types.delete(type);
      }
      applyFilters();
    });
    typeFiltersContainer.appendChild(div);
  });
}

function toggleAllNamespaces(checked) {
  const inputs = namespaceFiltersContainer.querySelectorAll('input');
  inputs.forEach(input => {
    input.checked = checked;
    if (checked) {
      activeFilters.namespaces.add(input.value);
    } else {
      activeFilters.namespaces.delete(input.value);
    }
  });
  applyFilters();
}

function applyFilters() {
  // Filter nodes
  const filteredNodes = graphData.nodes.filter(node => {
    // Keep cluster-scoped nodes (like physical node or namespace node itself) or match namespace filter
    const matchesNamespace = !node.namespace || activeFilters.namespaces.has(node.namespace);
    const matchesType = activeFilters.types.has(node.type);
    return matchesNamespace && matchesType;
  });

  const nodeIds = new Set(filteredNodes.map(n => n.id));

  // Filter links (only keep if source and target nodes exist in filtered list)
  const filteredLinks = graphData.links.filter(link => {
    // 3d-force-graph parses link source/target objects or strings
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    return nodeIds.has(sourceId) && nodeIds.has(targetId);
  });

  filteredData = {
    nodes: filteredNodes,
    links: filteredLinks,
  };

  // Update statistics
  statNodes.textContent = filteredNodes.length;
  statLinks.textContent = filteredLinks.length;
  statNamespaces.textContent = new Set(filteredNodes.map(n => n.namespace).filter(Boolean)).size;
  statPods.textContent = filteredNodes.filter(n => n.type === 'pod').length;

  // Load into Graph
  Graph.graphData(filteredData);
}

function renderLegend() {
  legendList.innerHTML = '';
  Object.keys(resourceConfig).forEach(type => {
    const conf = resourceConfig[type];
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <span class="legend-color" style="color: ${conf.color}; background-color: ${conf.color}"></span>
      <span>${conf.name}</span>
    `;
    legendList.appendChild(item);
  });
}

// ==========================================================================
// Interactions & Animations
// ==========================================================================

function handleNodeHover(node) {
  // Clear highlights if nothing hovered
  if ((!node && hoveredNode) || (node && node === hoveredNode)) {
    if (!node) {
      hoveredNode = null;
      highlightNodes.clear();
      highlightLinks.clear();
      updateNodeVisualStates();
      // Trigger link updates to restore normal links
      if (Graph) {
        Graph.linkWidth(Graph.linkWidth())
          .linkOpacity(Graph.linkOpacity())
          .linkDirectionalParticles(Graph.linkDirectionalParticles());
      }
    }
    return;
  }

  hoveredNode = node;
  highlightNodes.clear();
  highlightLinks.clear();

  if (node) {
    highlightNodes.add(node);

    // Find connected links and nodes
    filteredData.links.forEach(link => {
      const source = link.source;
      const target = link.target;
      const sourceId = typeof source === 'object' ? source.id : source;
      const targetId = typeof target === 'object' ? target.id : target;

      if (sourceId === node.id) {
        highlightLinks.add(link);
        // Find node matching target
        const targetNode = filteredData.nodes.find(n => n.id === targetId);
        if (targetNode) highlightNodes.add(targetNode);
      } else if (targetId === node.id) {
        highlightLinks.add(link);
        // Find node matching source
        const sourceNode = filteredData.nodes.find(n => n.id === sourceId);
        if (sourceNode) highlightNodes.add(sourceNode);
      }
    });
  }

  updateNodeVisualStates();
  // Trigger link updates
  if (Graph) {
    Graph.linkWidth(Graph.linkWidth())
      .linkOpacity(Graph.linkOpacity())
      .linkDirectionalParticles(Graph.linkDirectionalParticles());
  }
}

function handleNodeClick(node) {
  // Close details if clicking same node
  if (selectedNode === node) {
    closeInspector();
    return;
  }

  selectedNode = node;
  openInspector(node);

  // Focus camera on node (Fly to it)
  const distance = 80;
  const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);

  if (Graph) {
    Graph.cameraPosition(
      { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio }, // new position
      node, // lookAt
      2000 // transition ms
    );
  }

  // Update node rendering to highlight clicked node without rebuilding meshes
  updateNodeVisualStates();
}

function updateNodeVisualStates() {
  if (!Graph) return;
  const nodes = Graph.graphData().nodes;
  const hasHighlights = highlightNodes.size > 0;

  nodes.forEach(node => {
    const group = node.__threeObj;
    if (!group) return;

    const isDimmed = hasHighlights && !highlightNodes.has(node);
    const isHighlighted = highlightNodes.has(node);
    const isSelected = node === selectedNode;

    group.traverse(child => {
      if (child.isMesh || child.isLineSegments || child.isLine || child.isPoints) {
        if (child.material) {
          // Cache original values on material if not already present
          if (!child.material.userData) child.material.userData = {};
          if (child.material.userData.originalColor === undefined) {
            child.material.userData.originalColor = child.material.color
              ? child.material.color.clone()
              : null;
            child.material.userData.originalEmissive = child.material.emissive
              ? child.material.emissive.clone()
              : null;
            child.material.userData.originalEmissiveIntensity =
              child.material.emissiveIntensity !== undefined
                ? child.material.emissiveIntensity
                : 0.75;
            child.material.userData.originalOpacity =
              child.material.opacity !== undefined ? child.material.opacity : 1.0;
          }

          const orig = child.material.userData;

          if (isDimmed) {
            // Apply dimming opacity reduction
            if (child.userData?.type === 'dashed-outer') {
              child.material.opacity = 0.08;
            } else if (child.userData?.type === 'dashed-inner') {
              child.material.opacity = 0.04;
            } else if (child.userData?.type === 'core') {
              child.material.opacity = 0.02;
            } else if (child.userData?.type === 'core-wire') {
              child.material.opacity = 0.03;
            } else if (child.material.wireframe) {
              child.material.opacity = 0.04;
            } else {
              child.material.opacity = 0.15;
            }

            if (child.material.color && orig.originalColor) {
              child.material.color.set('#1a2333');
            }
            if (child.material.emissive && orig.originalEmissive) {
              child.material.emissive.set('#000000');
            }
            if (child.material.emissiveIntensity !== undefined) {
              child.material.emissiveIntensity = 0.02;
            }
          } else if (isHighlighted || isSelected) {
            // Restore color and boost brightness
            if (child.material.color && orig.originalColor) {
              child.material.color.copy(orig.originalColor);
            }
            if (child.material.emissive && orig.originalEmissive) {
              child.material.emissive.copy(orig.originalEmissive);
            }

            // Adjust opacity for highlights
            if (child.userData?.type === 'dashed-outer') {
              child.material.opacity = 0.95;
            } else if (child.userData?.type === 'dashed-inner') {
              child.material.opacity = 0.65;
            } else if (child.userData?.type === 'core') {
              child.material.opacity = 0.35; // keep core somewhat translucent
            } else if (child.userData?.type === 'core-wire') {
              child.material.opacity = 0.6;
            } else {
              child.material.opacity =
                orig.originalOpacity < 0.5 ? Math.min(0.5, orig.originalOpacity * 1.2) : 1.0;
            }

            if (child.material.emissiveIntensity !== undefined) {
              child.material.emissiveIntensity = isSelected ? 2.5 : 1.8;
            }
          } else {
            // Restore normal state
            if (child.material.color && orig.originalColor) {
              child.material.color.copy(orig.originalColor);
            }
            if (child.material.emissive && orig.originalEmissive) {
              child.material.emissive.copy(orig.originalEmissive);
            }
            child.material.opacity = orig.originalOpacity;
            if (child.material.emissiveIntensity !== undefined) {
              child.material.emissiveIntensity = orig.originalEmissiveIntensity;
            }
          }
        }
      }
    });
  });
}

function openInspector(node) {
  const badge = document.getElementById('inspect-type-badge');
  const name = document.getElementById('inspect-name');
  const namespace = document.getElementById('inspect-namespace');
  const statusDot = document.getElementById('inspect-status-dot');
  const statusText = document.getElementById('inspect-status-text');
  const labelsContainer = document.getElementById('inspect-labels');
  const propertiesTable = document.getElementById('inspect-properties');
  const connectionsList = document.getElementById('inspect-connections');
  const rawCode = document.getElementById('inspect-json-code');

  // Fill Header
  badge.textContent = node.type;
  badge.style.backgroundColor = resourceConfig[node.type]?.color || '#94a3b8';
  badge.style.color = '#fff';

  name.textContent = node.name;
  namespace.textContent = node.namespace ? `Namespace: ${node.namespace}` : 'Cluster-Scoped';

  // Fill Status
  const isHealthy = ['Running', 'Ready', 'Active'].includes(node.status);
  const isFailed = ['Failed', 'NotReady', 'Degraded'].includes(node.status);

  statusDot.className = 'status-dot ' + (isHealthy ? 'green' : isFailed ? 'red' : 'yellow');
  statusText.textContent = node.status || 'Active';

  // Fill Labels
  labelsContainer.innerHTML = '';
  const labels = node.labels || {};
  if (Object.keys(labels).length === 0) {
    labelsContainer.innerHTML = '<span class="placeholder-text">No labels configured.</span>';
  } else {
    Object.keys(labels).forEach(key => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = `${key}=${labels[key]}`;
      labelsContainer.appendChild(span);
    });
  }

  // If pod is meshed, add Istio special tag
  if (node.type === 'pod' && node.details?.meshed) {
    const span = document.createElement('span');
    span.className = 'tag istio-tag';
    span.textContent = 'Istio Mesh (Sidecar)';
    labelsContainer.appendChild(span);
  }

  // Fill Properties
  propertiesTable.innerHTML = '';
  const details = node.details || {};

  // Add common fields
  addPropertyRow(propertiesTable, 'Resource ID', node.id);
  addPropertyRow(propertiesTable, 'Status', node.status || 'Active');

  Object.keys(details).forEach(key => {
    let val = details[key];
    if (Array.isArray(val)) {
      val = val.join(', ');
    } else if (typeof val === 'object') {
      val = JSON.stringify(val);
    }

    // Format camelCase keys into spaces
    const labelKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    addPropertyRow(propertiesTable, labelKey, val);
  });

  // Fill Connections
  connectionsList.innerHTML = '';
  const connections = [];

  // Look in links
  filteredData.links.forEach(link => {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;

    if (sourceId === node.id) {
      // Outbound connection
      const targetNode = filteredData.nodes.find(n => n.id === targetId);
      if (targetNode) {
        connections.push({
          node: targetNode,
          type: 'outbound',
          relation: link.type,
          protocol: link.protocol,
        });
      }
    } else if (targetId === node.id) {
      // Inbound connection
      const sourceNode = filteredData.nodes.find(n => n.id === sourceId);
      if (sourceNode) {
        connections.push({
          node: sourceNode,
          type: 'inbound',
          relation: link.type,
          protocol: link.protocol,
        });
      }
    }
  });

  if (connections.length === 0) {
    connectionsList.innerHTML =
      '<li class="placeholder-text">No connected nodes found in current filters.</li>';
  } else {
    connections.forEach(conn => {
      const li = document.createElement('li');
      li.className = 'connection-item';
      const arrow = conn.type === 'outbound' ? '➔' : '🠠';
      const proto = conn.protocol ? ` (${conn.protocol.toUpperCase()})` : '';
      const badgeColor = resourceConfig[conn.node.type]?.color || '#94a3b8';

      li.innerHTML = `
        <div class="conn-name">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background-color:${badgeColor}; margin-right:6px"></span>
          <span>${conn.node.name}</span>
        </div>
        <span class="conn-relation">${arrow} ${conn.relation}${proto}</span>
      `;
      li.addEventListener('click', () => {
        handleNodeClick(conn.node);
      });
      connectionsList.appendChild(li);
    });
  }

  // Fill JSON Tab
  rawCode.textContent = JSON.stringify(node, null, 2);

  // Open sidebar
  inspector.classList.remove('closed');
  statusMessage.textContent = `Inspecting ${node.type}: ${node.name}`;
}

function addPropertyRow(table, key, value) {
  if (value === undefined || value === null || value === '') return;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="prop-name">${key}</td>
    <td class="prop-val">${value}</td>
  `;
  table.appendChild(tr);
}

function closeInspector() {
  selectedNode = null;
  inspector.classList.add('closed');
  statusMessage.textContent = 'Ready. Click a node to inspect.';
  updateNodeVisualStates(); // Clear clicked highlight without rebuilding meshes
}

function resetCamera() {
  Graph.zoomToFit(1200, 100);
  statusMessage.textContent = 'Camera view reset.';
}

function toggleOrbit() {
  isOrbiting = !isOrbiting;
  if (isOrbiting) {
    orbitBtn.classList.add('active');
    orbitBtn.textContent = 'Orbit On';
    statusMessage.textContent = 'Auto orbiting camera active.';

    // Rotate camera around node center
    const distance = 350;
    orbitInterval = setInterval(() => {
      angle += 0.003;
      Graph.cameraPosition({
        x: distance * Math.sin(angle),
        z: distance * Math.cos(angle),
      });
    }, 10);
  } else {
    orbitBtn.classList.remove('active');
    orbitBtn.textContent = 'Orbit Off';
    statusMessage.textContent = 'Auto orbit disabled.';
    if (orbitInterval) {
      clearInterval(orbitInterval);
      orbitInterval = null;
    }
  }
}

function handleSearch(e) {
  const query = e.target.value.toLowerCase().trim();
  if (!query) {
    highlightNodes.clear();
    highlightLinks.clear();
    updateNodeVisualStates();
    if (Graph) {
      Graph.linkWidth(Graph.linkWidth())
        .linkOpacity(Graph.linkOpacity())
        .linkDirectionalParticles(Graph.linkDirectionalParticles());
    }
    return;
  }

  // Search by name, type, namespace, or labels
  const matches = filteredData.nodes.filter(node => {
    const matchName = node.name.toLowerCase().includes(query);
    const matchType = node.type.toLowerCase().includes(query);
    const matchNs = node.namespace && node.namespace.toLowerCase().includes(query);
    const matchLabels = Object.entries(node.labels || {}).some(
      ([k, v]) => k.toLowerCase().includes(query) || v.toLowerCase().includes(query)
    );
    return matchName || matchType || matchNs || matchLabels;
  });

  highlightNodes.clear();
  highlightLinks.clear();

  matches.forEach(node => highlightNodes.add(node));
  updateNodeVisualStates();
  if (Graph) {
    Graph.linkWidth(Graph.linkWidth())
      .linkOpacity(Graph.linkOpacity())
      .linkDirectionalParticles(Graph.linkDirectionalParticles());
  }

  if (matches.length === 1) {
    // If exact one match, focus camera on it!
    const target = matches[0];
    Graph.cameraPosition({ x: target.x * 1.5, y: target.y * 1.5, z: target.z * 1.5 }, target, 1500);
    openInspector(target);
  }

  statusMessage.textContent = `Found ${matches.length} matching resources.`;
}

// ==========================================================================
// Mock Data Generator (Standard Istio Cluster Architecture)
// ==========================================================================

function loadMockData(verbose = false) {
  console.log('Generating high-quality mock cluster data...');
  dataSourceIndicator.textContent = 'Demo Cluster';
  dataSourceIndicator.className = 'badge demo';

  const nodes = [];
  const links = [];

  // Helper to push node
  const addNode = n => nodes.push(n);
  const addLink = l => links.push(l);

  // 1. Cluster Physical Hosts (Nodes)
  addNode({
    id: 'node/aks-nodepool-1',
    name: 'aks-nodepool-1',
    type: 'node',
    status: 'Ready',
    labels: { agentpool: 'main', 'kubernetes.io/os': 'linux' },
    details: { internalIP: '10.240.0.4', cpu: '8', memory: '32Gi' },
  });
  addNode({
    id: 'node/aks-nodepool-2',
    name: 'aks-nodepool-2',
    type: 'node',
    status: 'Ready',
    labels: { agentpool: 'main', 'kubernetes.io/os': 'linux' },
    details: { internalIP: '10.240.0.5', cpu: '8', memory: '32Gi' },
  });

  // 2. Namespaces
  const nss = ['kube-system', 'istio-system', 'default', 'dev', 'prod'];
  nss.forEach(ns => {
    addNode({
      id: `namespace/${ns}`,
      name: ns,
      type: 'namespace',
      status: 'Active',
      labels: {},
      details: {},
    });
  });

  // Helper for generating standard microservices stack in a namespace
  function createMicroserviceStack(ns, prefix, healthy = true) {
    const replicaCount = healthy ? 2 : 1;
    const podStatus = healthy ? 'Running' : 'Degraded';

    // Istio Gateway
    const gwId = `gateway/${ns}/${prefix}-gateway`;
    addNode({
      id: gwId,
      name: `${prefix}-gateway`,
      type: 'gateway',
      namespace: ns,
      status: 'Active',
      labels: { app: `${prefix}-ingress` },
      details: { servers: ['80/HTTP (*)', '443/HTTPS (*)'] },
    });
    addLink({ source: `namespace/${ns}`, target: gwId, type: 'contains' });

    // Istio VirtualService
    const vsId = `virtualservice/${ns}/${prefix}-vs`;
    addNode({
      id: vsId,
      name: `${prefix}-vs`,
      type: 'virtualservice',
      namespace: ns,
      status: 'Active',
      labels: {},
      details: { hosts: [`${prefix}.mycompany.com`], gateways: [`${prefix}-gateway`] },
    });
    addLink({ source: `namespace/${ns}`, target: vsId, type: 'contains' });
    addLink({ source: gwId, target: vsId, type: 'routes-to', protocol: 'http' });

    // FrontEnd Service
    const frontSvcId = `service/${ns}/${prefix}-frontend`;
    addNode({
      id: frontSvcId,
      name: `${prefix}-frontend`,
      type: 'service',
      namespace: ns,
      status: 'Active',
      labels: { app: `${prefix}-frontend` },
      details: { serviceType: 'ClusterIP', clusterIP: '10.0.124.12', ports: ['80/TCP (http)'] },
    });
    addLink({ source: `namespace/${ns}`, target: frontSvcId, type: 'contains' });
    addLink({ source: vsId, target: frontSvcId, type: 'routes-to', protocol: 'http' });

    // FrontEnd Deployment
    const frontDepId = `deployment/${ns}/${prefix}-frontend`;
    addNode({
      id: frontDepId,
      name: `${prefix}-frontend`,
      type: 'deployment',
      namespace: ns,
      status: healthy ? 'Running' : 'Degraded',
      labels: { app: `${prefix}-frontend` },
      details: { replicas: `${replicaCount}/${replicaCount}` },
    });
    addLink({ source: `namespace/${ns}`, target: frontDepId, type: 'contains' });

    // FrontEnd ReplicaSet
    const frontRsId = `replicaset/${ns}/${prefix}-frontend-xyz56`;
    addNode({
      id: frontRsId,
      name: `${prefix}-frontend-xyz56`,
      type: 'replicaset',
      namespace: ns,
      status: 'Running',
      labels: { app: `${prefix}-frontend`, 'pod-template-hash': 'xyz56' },
      details: { replicas: `${replicaCount}/${replicaCount}` },
    });
    addLink({ source: `namespace/${ns}`, target: frontRsId, type: 'contains' });
    addLink({ source: frontDepId, target: frontRsId, type: 'manages' });

    // ServiceAccount
    const saId = `serviceaccount/${ns}/${prefix}-sa`;
    addNode({
      id: saId,
      name: `${prefix}-sa`,
      type: 'serviceaccount',
      namespace: ns,
      status: 'Active',
      labels: { app: prefix },
      details: { secrets: [`default-token-${prefix}`] },
    });
    addLink({ source: `namespace/${ns}`, target: saId, type: 'contains' });

    // FrontEnd Pods
    for (let i = 0; i < replicaCount; i++) {
      const podId = `pod/${ns}/${prefix}-frontend-xyz56-p${i}`;
      const physicalHost = `node/aks-nodepool-${(i % 2) + 1}`;

      addNode({
        id: podId,
        name: `${prefix}-frontend-xyz56-p${i}`,
        type: 'pod',
        namespace: ns,
        status: podStatus,
        labels: { app: `${prefix}-frontend`, env: ns },
        details: {
          podIP: `10.244.1.${10 + i}`,
          nodeName: physicalHost.split('/')[1],
          meshed: true,
        },
      });
      addLink({ source: `namespace/${ns}`, target: podId, type: 'contains' });
      addLink({ source: frontRsId, target: podId, type: 'manages' });
      addLink({ source: physicalHost, target: podId, type: 'hosts' });
      addLink({ source: frontSvcId, target: podId, type: 'routes-to', protocol: 'http' });
      addLink({ source: saId, target: podId, type: 'binds' });
    }

    // Backend gRPC Service
    const backSvcId = `service/${ns}/${prefix}-backend`;
    addNode({
      id: backSvcId,
      name: `${prefix}-backend`,
      type: 'service',
      namespace: ns,
      status: 'Active',
      labels: { app: `${prefix}-backend` },
      details: { serviceType: 'ClusterIP', clusterIP: '10.0.124.15', ports: ['9000/TCP (grpc)'] },
    });
    addLink({ source: `namespace/${ns}`, target: backSvcId, type: 'contains' });

    // Connect Frontend Pods to Backend Service (gRPC protocol)
    for (let i = 0; i < replicaCount; i++) {
      addLink({
        source: `pod/${ns}/${prefix}-frontend-xyz56-p${i}`,
        target: backSvcId,
        type: 'routes-to',
        protocol: 'grpc',
      });
    }

    // Backend StatefulSet
    const backStsId = `statefulset/${ns}/${prefix}-backend`;
    addNode({
      id: backStsId,
      name: `${prefix}-backend`,
      type: 'statefulset',
      namespace: ns,
      status: 'Running',
      labels: { app: `${prefix}-backend` },
      details: { replicas: '2/2', serviceName: `${prefix}-backend` },
    });
    addLink({ source: `namespace/${ns}`, target: backStsId, type: 'contains' });
    addLink({ source: backStsId, target: backSvcId, type: 'routes-to' });

    // Backend PVC
    const pvcId = `pvc/${ns}/${prefix}-backend-pvc`;
    addNode({
      id: pvcId,
      name: `${prefix}-backend-pvc`,
      type: 'pvc',
      namespace: ns,
      status: 'Bound',
      labels: { app: `${prefix}-backend` },
      details: {
        volumeName: `pvc-vol-${prefix}`,
        storageClass: 'managed-premium',
        capacity: '10Gi',
        status: 'Bound',
      },
    });
    addLink({ source: `namespace/${ns}`, target: pvcId, type: 'contains' });

    // Backend Pods
    for (let i = 0; i < 2; i++) {
      const podId = `pod/${ns}/${prefix}-backend-${i}`;
      const physicalHost = `node/aks-nodepool-${((i + 1) % 2) + 1}`;

      addNode({
        id: podId,
        name: `${prefix}-backend-${i}`,
        type: 'pod',
        namespace: ns,
        status: 'Running',
        labels: { app: `${prefix}-backend`, env: ns },
        details: {
          podIP: `10.244.2.${20 + i}`,
          nodeName: physicalHost.split('/')[1],
          meshed: true,
        },
      });
      addLink({ source: `namespace/${ns}`, target: podId, type: 'contains' });
      addLink({ source: backStsId, target: podId, type: 'manages' });
      addLink({ source: physicalHost, target: podId, type: 'hosts' });
      addLink({ source: backSvcId, target: podId, type: 'routes-to', protocol: 'grpc' });
      addLink({ source: podId, target: pvcId, type: 'claims-volume' });
      addLink({ source: saId, target: podId, type: 'binds' });
    }

    // Istio DestinationRule for backend (defines load balancing and mTLS)
    const drId = `destinationrule/${ns}/${prefix}-backend-dr`;
    addNode({
      id: drId,
      name: `${prefix}-backend-dr`,
      type: 'destinationrule',
      namespace: ns,
      status: 'Active',
      labels: {},
      details: { host: `${prefix}-backend`, subsets: ['v1'], trafficPolicy: 'LEAST_CONN' },
    });
    addLink({ source: `namespace/${ns}`, target: drId, type: 'contains' });
    addLink({ source: drId, target: backSvcId, type: 'configures' });

    // Istio PeerAuthentication (Enforces strict mTLS in namespace)
    const paId = `peerauthentication/${ns}/${prefix}-strict-pa`;
    addNode({
      id: paId,
      name: `${prefix}-strict-pa`,
      type: 'peerauthentication',
      namespace: ns,
      status: 'Active',
      labels: {},
      details: { mtlsMode: 'STRICT' },
    });
    addLink({ source: paId, target: `namespace/${ns}`, type: 'secures' });
  }

  // Create two distinct application environments
  createMicroserviceStack('dev', 'dev-app', true);
  createMicroserviceStack('prod', 'prod-app', true);

  // Add standard monitoring system to kube-system/monitoring namespace
  addNode({
    id: 'service/kube-system/kube-dns',
    name: 'kube-dns',
    type: 'service',
    namespace: 'kube-system',
    status: 'Active',
    labels: { 'k8s-app': 'kube-dns' },
    details: { serviceType: 'ClusterIP', clusterIP: '10.0.0.10', ports: ['53/UDP', '53/TCP'] },
  });
  addLink({
    source: 'namespace/kube-system',
    target: 'service/kube-system/kube-dns',
    type: 'contains',
  });

  // Add core system pods
  for (let i = 1; i <= 2; i++) {
    const podId = `pod/kube-system/coredns-${i}`;
    addNode({
      id: podId,
      name: `coredns-${i}`,
      type: 'pod',
      namespace: 'kube-system',
      status: 'Running',
      labels: { 'k8s-app': 'kube-dns' },
      details: { podIP: `10.244.0.${2 + i}`, nodeName: `aks-nodepool-${i}`, meshed: false },
    });
    addLink({ source: 'namespace/kube-system', target: podId, type: 'contains' });
    addLink({ source: `node/aks-nodepool-${i}`, target: podId, type: 'hosts' });
    addLink({
      source: 'service/kube-system/kube-dns',
      target: podId,
      type: 'routes-to',
      protocol: 'tcp',
    });
  }

  graphData = { nodes, links };
  if (verbose) {
    statusMessage.textContent = 'Generated interactive demo cluster graph.';
  }
  processLoadedData();
}
