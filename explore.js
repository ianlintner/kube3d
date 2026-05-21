const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Helper to run kubectl commands and parse JSON
function getKubectlJson(resource, args = '') {
  try {
    const cmd = `kubectl get ${resource} ${args} -o json`;
    console.log(`Executing: ${cmd}`);
    const output = execSync(cmd, { 
      stdio: ['ignore', 'pipe', 'ignore'], 
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer
    });
    return JSON.parse(output);
  } catch (error) {
    console.warn(`⚠️  Failed to fetch ${resource}. It might not exist or be accessible in this cluster. Error: ${error.message}`);
    return { items: [] };
  }
}

// Check if a CRD exists in the cluster
function hasCrd(crdName) {
  try {
    const output = execSync(`kubectl get crd ${crdName} -o name`, { 
      stdio: ['ignore', 'pipe', 'ignore'], 
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });
    return output.trim().length > 0;
  } catch (error) {
    return false;
  }
}

// Helper to parse hostnames to find the correct service and namespace
function resolveServiceHost(host, defaultNamespace) {
  if (!host) return null;
  const parts = host.split('.');
  const name = parts[0];
  let namespace = defaultNamespace;
  
  if (parts.length > 1) {
    // If it is something like svc-name.namespace or svc-name.namespace.svc...
    if (parts[1] !== 'svc' && parts[1] !== 'cluster') {
      namespace = parts[1];
    }
  }
  return { name, namespace };
}

function main() {
  console.log('🚀 Starting Kubernetes cluster exploration...');

  // Initialize output graph structure
  const nodes = [];
  const links = [];
  const nodeMap = new Map(); // Track registered node IDs to prevent duplicates

  function addNode(node) {
    if (!node.id) return;
    if (nodeMap.has(node.id)) {
      // Merge details/status if needed
      const existing = nodeMap.get(node.id);
      Object.assign(existing.details, node.details);
      if (node.status) existing.status = node.status;
      return;
    }
    nodes.push(node);
    nodeMap.set(node.id, node);
  }

  function addLink(link) {
    // Only add link if source and target are not empty
    if (!link.source || !link.target) return;
    
    // Check if link already exists
    const exists = links.some(l => 
      l.source === link.source && 
      l.target === link.target && 
      l.type === link.type
    );
    if (!exists) {
      links.push(link);
    }
  }

  // 1. Fetch Namespaces
  console.log('📦 Querying Namespaces...');
  const namespaceData = getKubectlJson('namespaces');
  namespaceData.items.forEach(ns => {
    const name = ns.metadata.name;
    const status = ns.status?.phase || 'Active';
    addNode({
      id: `namespace/${name}`,
      name: name,
      type: 'namespace',
      status: status,
      labels: ns.metadata.labels || {},
      details: {
        creationTimestamp: ns.metadata.creationTimestamp,
        uid: ns.metadata.uid
      }
    });
  });

  // 2. Fetch Nodes (Physical/Virtual VM hosts)
  console.log('🖥️  Querying Cluster Nodes...');
  const nodeData = getKubectlJson('nodes');
  nodeData.items.forEach(node => {
    const name = node.metadata.name;
    const readyCond = node.status?.conditions?.find(c => c.type === 'Ready');
    const status = readyCond?.status === 'True' ? 'Ready' : 'NotReady';
    const internalIP = node.status?.addresses?.find(a => a.type === 'InternalIP')?.address || '';
    
    addNode({
      id: `node/${name}`,
      name: name,
      type: 'node',
      status: status,
      labels: node.metadata.labels || {},
      details: {
        kubeletVersion: node.status?.nodeInfo?.kubeletVersion || '',
        osImage: node.status?.nodeInfo?.osImage || '',
        internalIP: internalIP,
        cpu: node.status?.capacity?.cpu || '',
        memory: node.status?.capacity?.memory || ''
      }
    });
  });

  // 3. Fetch Workloads
  console.log('⚙️  Querying Workloads (Deployments, StatefulSets, DaemonSets, ReplicaSets)...');
  const deployments = getKubectlJson('deployments', '-A');
  const replicasets = getKubectlJson('replicasets', '-A');
  const statefulsets = getKubectlJson('statefulsets', '-A');
  const daemonsets = getKubectlJson('daemonsets', '-A');

  // Map Deployments
  deployments.items.forEach(dep => {
    const name = dep.metadata.name;
    const ns = dep.metadata.namespace;
    const id = `deployment/${ns}/${name}`;
    const desired = dep.spec?.replicas ?? 1;
    const available = dep.status?.availableReplicas ?? 0;
    const status = available >= desired ? 'Running' : 'Degraded';

    addNode({
      id,
      name,
      type: 'deployment',
      namespace: ns,
      status,
      labels: dep.metadata.labels || {},
      details: {
        replicas: `${available}/${desired}`,
        strategy: dep.spec?.strategy?.type || 'RollingUpdate'
      }
    });
    // Link to namespace
    addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });
  });

  // Map StatefulSets
  statefulsets.items.forEach(sts => {
    const name = sts.metadata.name;
    const ns = sts.metadata.namespace;
    const id = `statefulset/${ns}/${name}`;
    const desired = sts.spec?.replicas ?? 1;
    const ready = sts.status?.readyReplicas ?? 0;
    const status = ready >= desired ? 'Running' : 'Degraded';

    addNode({
      id,
      name,
      type: 'statefulset',
      namespace: ns,
      status,
      labels: sts.metadata.labels || {},
      details: {
        replicas: `${ready}/${desired}`,
        serviceName: sts.spec?.serviceName || ''
      }
    });
    addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });
    
    // If it refers to a serviceName, let's link the StatefulSet to the Service
    if (sts.spec?.serviceName) {
      addLink({
        source: id,
        target: `service/${ns}/${sts.spec.serviceName}`,
        type: 'routes-to'
      });
    }
  });

  // Map DaemonSets
  daemonsets.items.forEach(ds => {
    const name = ds.metadata.name;
    const ns = ds.metadata.namespace;
    const id = `daemonset/${ns}/${name}`;
    const desired = ds.status?.desiredNumberScheduled ?? 0;
    const ready = ds.status?.numberReady ?? 0;
    const status = ready >= desired ? 'Running' : 'Degraded';

    addNode({
      id,
      name,
      type: 'daemonset',
      namespace: ns,
      status,
      labels: ds.metadata.labels || {},
      details: {
        replicas: `${ready}/${desired}`
      }
    });
    addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });
  });

  // Map ReplicaSets and link to Deployments
  replicasets.items.forEach(rs => {
    const name = rs.metadata.name;
    const ns = rs.metadata.namespace;
    const id = `replicaset/${ns}/${name}`;
    const desired = rs.spec?.replicas ?? 0;
    const ready = rs.status?.readyReplicas ?? 0;
    const status = ready >= desired ? 'Running' : 'Degraded';

    // Only add ReplicaSets that actually have desired replicas (filter out old history replica sets for clean graph)
    if (desired > 0 || ready > 0) {
      addNode({
        id,
        name,
        type: 'replicaset',
        namespace: ns,
        status,
        labels: rs.metadata.labels || {},
        details: { replicas: `${ready}/${desired}` }
      });
      addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });

      // OwnerReference check to Deployment
      const owner = rs.metadata.ownerReferences?.find(o => o.kind === 'Deployment');
      if (owner) {
        addLink({
          source: `deployment/${ns}/${owner.name}`,
          target: id,
          type: 'manages'
        });
      }
    }
  });

  // 4. Fetch Pods
  console.log('🛸 Querying Pods...');
  const podData = getKubectlJson('pods', '-A');
  
  // Track pod IPs and labels for service matching
  const podList = [];

  podData.items.forEach(pod => {
    const name = pod.metadata.name;
    const ns = pod.metadata.namespace;
    const id = `pod/${ns}/${name}`;
    const status = pod.status?.phase || 'Unknown';
    const podIP = pod.status?.podIP || '';
    const nodeName = pod.spec?.nodeName || '';
    
    // Check if meshed (Istio proxy container)
    const isMeshed = pod.spec?.containers?.some(c => c.name === 'istio-proxy') || false;
    const containers = pod.spec?.containers?.map(c => c.name) || [];

    const podNode = {
      id,
      name,
      type: 'pod',
      namespace: ns,
      status,
      labels: pod.metadata.labels || {},
      details: {
        podIP,
        nodeName,
        containers,
        meshed: isMeshed,
        serviceAccount: pod.spec?.serviceAccountName || 'default'
      }
    };
    
    addNode(podNode);
    addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });

    // Save for Service-to-Pod label matching
    podList.push({
      id,
      namespace: ns,
      labels: pod.metadata.labels || {}
    });

    // Link Pod to Node (hosts relationship)
    if (nodeName) {
      addLink({
        source: `node/${nodeName}`,
        target: id,
        type: 'hosts'
      });
    }

    // Owner Reference check (ReplicaSet, StatefulSet, DaemonSet, Job, etc.)
    const owner = pod.metadata.ownerReferences?.find(o => 
      ['ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job'].includes(o.kind)
    );
    if (owner) {
      const ownerKind = owner.kind.toLowerCase();
      addLink({
        source: `${ownerKind}/${ns}/${owner.name}`,
        target: id,
        type: 'manages'
      });
    }

    // Link Pod to PVC (volume mount relationship)
    if (pod.spec?.volumes) {
      pod.spec.volumes.forEach(vol => {
        if (vol.persistentVolumeClaim?.claimName) {
          const claimName = vol.persistentVolumeClaim.claimName;
          addLink({
            source: id,
            target: `pvc/${ns}/${claimName}`,
            type: 'claims-volume'
          });
        }
      });
    }

    // Link ServiceAccount
    if (pod.spec?.serviceAccountName) {
      const saId = `serviceaccount/${ns}/${pod.spec.serviceAccountName}`;
      addNode({
        id: saId,
        name: pod.spec.serviceAccountName,
        type: 'serviceaccount',
        namespace: ns,
        status: 'Active',
        labels: {},
        details: {}
      });
      addLink({
        source: saId,
        target: id,
        type: 'binds'
      });
    }
  });

  // 5. Fetch Services & Core Networking
  console.log('🔌 Querying Services & Ingresses...');
  const serviceData = getKubectlJson('services', '-A');
  const ingressData = getKubectlJson('ingresses', '-A');

  serviceData.items.forEach(svc => {
    const name = svc.metadata.name;
    const ns = svc.metadata.namespace;
    const id = `service/${ns}/${name}`;
    const type = svc.spec?.type || 'ClusterIP';
    const clusterIP = svc.spec?.clusterIP || '';
    const externalIP = svc.status?.loadBalancer?.ingress?.map(i => i.ip || i.hostname).join(', ') || '';
    const ports = svc.spec?.ports?.map(p => `${p.port}/${p.protocol} (${p.name || 'unnamed'})`) || [];
    
    addNode({
      id,
      name,
      type: 'service',
      namespace: ns,
      status: 'Active',
      labels: svc.metadata.labels || {},
      details: {
        serviceType: type,
        clusterIP,
        externalIP,
        ports
      }
    });
    addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });

    // Link Service to Pods via Label Selector
    const selector = svc.spec?.selector;
    if (selector && Object.keys(selector).length > 0) {
      // Find pods in the same namespace that match all selectors
      const selectorKeys = Object.keys(selector);
      podList.forEach(pod => {
        if (pod.namespace === ns) {
          const matches = selectorKeys.every(key => pod.labels[key] === selector[key]);
          if (matches) {
            // Find if there is a specific protocol based on port names
            let protocol = 'tcp';
            const portsList = svc.spec?.ports || [];
            for (const p of portsList) {
              const portName = (p.name || '').toLowerCase();
              if (portName.startsWith('grpc')) protocol = 'grpc';
              else if (portName.startsWith('http')) protocol = 'http';
              else if (portName.startsWith('tls') || portName.startsWith('https')) protocol = 'tls';
            }

            addLink({
              source: id,
              target: pod.id,
              type: 'routes-to',
              protocol
            });
          }
        }
      });
    }
  });

  // Map Ingresses
  ingressData.items.forEach(ing => {
    const name = ing.metadata.name;
    const ns = ing.metadata.namespace;
    const id = `ingress/${ns}/${name}`;
    const hosts = ing.spec?.rules?.map(r => r.host).filter(Boolean) || [];
    const loadBalancer = ing.status?.loadBalancer?.ingress?.map(i => i.ip || i.hostname).join(', ') || '';

    addNode({
      id,
      name,
      type: 'ingress',
      namespace: ns,
      status: 'Active',
      labels: ing.metadata.labels || {},
      details: {
        hosts,
        loadBalancer
      }
    });
    addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });

    // Parse Ingress rules to find backend Services
    if (ing.spec?.rules) {
      ing.spec.rules.forEach(rule => {
        if (rule.http?.paths) {
          rule.http.paths.forEach(pathObj => {
            const svcName = pathObj.backend?.service?.name;
            if (svcName) {
              addLink({
                source: id,
                target: `service/${ns}/${svcName}`,
                type: 'exposes',
                protocol: 'http'
              });
            }
          });
        }
      });
    }
    // Fallback: Default backend
    const defBackendSvc = ing.spec?.defaultBackend?.service?.name;
    if (defBackendSvc) {
      addLink({
        source: id,
        target: `service/${ns}/${defBackendSvc}`,
        type: 'exposes',
        protocol: 'http'
      });
    }
  });

  // 5.5. Fetch PersistentVolumeClaims (PVCs)
  console.log('💾 Querying PersistentVolumeClaims...');
  const pvcData = getKubectlJson('pvc', '-A');
  pvcData.items.forEach(pvc => {
    const name = pvc.metadata.name;
    const ns = pvc.metadata.namespace;
    const id = `pvc/${ns}/${name}`;
    const status = pvc.status?.phase || 'Bound';
    const volumeName = pvc.spec?.volumeName || '';
    const storageClass = pvc.spec?.storageClassName || '';
    const capacity = pvc.status?.capacity?.storage || '';

    addNode({
      id,
      name,
      type: 'pvc',
      namespace: ns,
      status,
      labels: pvc.metadata.labels || {},
      details: {
        volumeName,
        storageClass,
        capacity,
        status
      }
    });
    addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });
  });

  // 6. Check and Fetch Istio Resources
  const istioGatewayCrd = 'gateways.networking.istio.io';
  const istioVirtualSvcCrd = 'virtualservices.networking.istio.io';
  const istioDestRuleCrd = 'destinationrules.networking.istio.io';
  const istioPeerAuthCrd = 'peerauthentications.security.istio.io';

  console.log('⛵ Probing for Istio Custom Resource Definitions...');
  const hasGateway = hasCrd(istioGatewayCrd);
  const hasVirtualSvc = hasCrd(istioVirtualSvcCrd);
  const hasDestRule = hasCrd(istioDestRuleCrd);
  const hasPeerAuth = hasCrd(istioPeerAuthCrd);

  if (hasGateway) {
    console.log('⚓ Querying Istio Gateways...');
    const gatewayData = getKubectlJson('gateways.networking.istio.io', '-A');
    gatewayData.items.forEach(gw => {
      const name = gw.metadata.name;
      const ns = gw.metadata.namespace;
      const id = `gateway/${ns}/${name}`;
      const servers = gw.spec?.servers?.map(s => `${s.port?.number}/${s.port?.protocol} (${s.hosts?.join(',')})`) || [];
      
      addNode({
        id,
        name,
        type: 'gateway',
        namespace: ns,
        status: 'Active',
        labels: gw.metadata.labels || {},
        details: { servers }
      });
      addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });
    });
  }

  if (hasVirtualSvc) {
    console.log('🛣️  Querying Istio VirtualServices...');
    const vsData = getKubectlJson('virtualservices.networking.istio.io', '-A');
    vsData.items.forEach(vs => {
      const name = vs.metadata.name;
      const ns = vs.metadata.namespace;
      const id = `virtualservice/${ns}/${name}`;
      const hosts = vs.spec?.hosts || [];
      const gatewayRefs = vs.spec?.gateways || [];

      addNode({
        id,
        name,
        type: 'virtualservice',
        namespace: ns,
        status: 'Active',
        labels: vs.metadata.labels || {},
        details: { hosts, gateways: gatewayRefs }
      });
      addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });

      // Link Gateway references to this VirtualService
      gatewayRefs.forEach(gwRef => {
        // Resolve gateway reference namespace (defaults to VirtualService namespace)
        let gwName = gwRef;
        let gwNs = ns;
        if (gwRef.includes('/')) {
          const parts = gwRef.split('/');
          gwNs = parts[0];
          gwName = parts[1];
        }
        
        // Skip default mesh sidecar traffic routing
        if (gwRef !== 'mesh') {
          addLink({
            source: `gateway/${gwNs}/${gwName}`,
            target: id,
            type: 'routes-to',
            protocol: 'http'
          });
        }
      });

      // Link VirtualService to Destination Services
      const parseRoutes = (routes) => {
        if (!routes) return;
        routes.forEach(route => {
          const dest = route.destination;
          if (dest && dest.host) {
            const resolved = resolveServiceHost(dest.host, ns);
            if (resolved) {
              // Guess protocol
              let protocol = 'http';
              if (vs.spec.tcp) protocol = 'tcp';
              if (vs.spec.tls) protocol = 'tls';
              
              addLink({
                source: id,
                target: `service/${resolved.namespace}/${resolved.name}`,
                type: 'routes-to',
                protocol
              });
            }
          }
        });
      };

      // VirtualServices can have http, tcp, or tls routes
      if (vs.spec?.http) {
        vs.spec.http.forEach(h => parseRoutes(h.route));
      }
      if (vs.spec?.tcp) {
        vs.spec.tcp.forEach(t => parseRoutes(t.route));
      }
      if (vs.spec?.tls) {
        vs.spec.tls.forEach(t => parseRoutes(t.route));
      }
    });
  }

  if (hasDestRule) {
    console.log('🛠️  Querying Istio DestinationRules...');
    const drData = getKubectlJson('destinationrules.networking.istio.io', '-A');
    drData.items.forEach(dr => {
      const name = dr.metadata.name;
      const ns = dr.metadata.namespace;
      const id = `destinationrule/${ns}/${name}`;
      const host = dr.spec?.host;
      const subsets = dr.spec?.subsets?.map(s => s.name) || [];
      const trafficPolicy = dr.spec?.trafficPolicy ? 'Configured' : 'Default';

      addNode({
        id,
        name,
        type: 'destinationrule',
        namespace: ns,
        status: 'Active',
        labels: dr.metadata.labels || {},
        details: { host, subsets, trafficPolicy }
      });
      addLink({ source: `namespace/${ns}`, target: id, type: 'contains' });

      // Link DestinationRule to Service
      if (host) {
        const resolved = resolveServiceHost(host, ns);
        if (resolved) {
          addLink({
            source: id,
            target: `service/${resolved.namespace}/${resolved.name}`,
            type: 'configures'
          });
        }
      }
    });
  }

  if (hasPeerAuth) {
    console.log('🔒 Querying Istio PeerAuthentications...');
    const paData = getKubectlJson('peerauthentications.security.istio.io', '-A');
    paData.items.forEach(pa => {
      const name = pa.metadata.name;
      const ns = pa.metadata.namespace;
      const id = `peerauthentication/${ns}/${name}`;
      const mode = pa.spec?.mtls?.mode || 'PERMISSIVE';
      const selector = pa.spec?.selector?.matchLabels;

      addNode({
        id,
        name,
        type: 'peerauthentication',
        namespace: ns,
        status: 'Active',
        labels: pa.metadata.labels || {},
        details: { mtlsMode: mode }
      });

      if (selector) {
        // Link to matching workloads (Deployments, StatefulSets) in the same namespace
        const selectorKeys = Object.keys(selector);
        nodes.forEach(node => {
          if (node.namespace === ns && ['deployment', 'statefulset', 'daemonset'].includes(node.type)) {
            const matches = selectorKeys.every(key => node.labels[key] === selector[key]);
            if (matches) {
              addLink({
                source: id,
                target: node.id,
                type: 'secures'
              });
            }
          }
        });
      } else {
        // Appears namespace-wide. Link to the namespace node.
        addLink({
          source: id,
          target: `namespace/${ns}`,
          type: 'secures'
        });
      }
    });
  }

  // Final count logging
  console.log(`📊 Statistics: Nodes = ${nodes.length}, Links = ${links.length}`);

  // Write graph files
  const rootPath = path.join(__dirname, 'cluster-graph.json');
  const dashboardPath = path.join(__dirname, 'dashboard', 'cluster-graph.json');
  
  const jsonContent = JSON.stringify({ nodes, links }, null, 2);
  
  fs.writeFileSync(rootPath, jsonContent, 'utf-8');
  console.log(`✅ Saved root cluster graph to: ${rootPath}`);

  // Create dashboard directory if it somehow doesn't exist, and write
  try {
    const dashboardDir = path.join(__dirname, 'dashboard');
    if (!fs.existsSync(dashboardDir)) {
      fs.mkdirSync(dashboardDir, { recursive: true });
    }
    fs.writeFileSync(dashboardPath, jsonContent, 'utf-8');
    console.log(`✅ Saved dashboard cluster graph to: ${dashboardPath}`);
  } catch (err) {
    console.warn('⚠️ Could not save to dashboard folder:', err.message);
  }
  
  console.log('✅ Success! Cluster graph data collection complete.');
}

main();
