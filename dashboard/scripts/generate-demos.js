const fs = require('fs');
const path = require('path');

// Helper to generate a random ID suffix
function randomString(length = 6) {
  return Math.random()
    .toString(36)
    .substring(2, 2 + length);
}

// Helper to choose a random item from array
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generate IP address
function randomIP(prefix = '10.244.') {
  return prefix + Math.floor(Math.random() * 255) + '.' + Math.floor(Math.random() * 255);
}

function generateClusterData(sizeName, config) {
  const nodes = [];
  const links = [];
  const registeredIds = new Set();

  function addNode(node) {
    if (registeredIds.has(node.id)) return;
    nodes.push(node);
    registeredIds.add(node.id);
  }

  function addLink(source, target, type, extra = {}) {
    if (!registeredIds.has(source) || !registeredIds.has(target)) return;
    // Prevent duplicate links
    const linkExists = links.some(
      l => l.source === source && l.target === target && l.type === type
    );
    if (!linkExists) {
      links.push({ source, target, type, ...extra });
    }
  }

  // 1. Generate Physical/Virtual Nodes
  const numNodes = config.nodes;
  const clusterNodes = [];
  for (let i = 1; i <= numNodes; i++) {
    const nodeName = `aks-nodepool-${sizeName}-${i}`;
    const nodeId = `node/${nodeName}`;
    const cpu = randomChoice(['4', '8', '16']);
    const mem = cpu === '4' ? '16Gi' : cpu === '8' ? '32Gi' : '64Gi';
    addNode({
      id: nodeId,
      name: nodeName,
      type: 'node',
      status: 'Ready',
      labels: {
        agentpool: 'agentpool-' + sizeName,
        'kubernetes.io/os': 'linux',
        'kubernetes.io/hostname': nodeName,
        'topology.kubernetes.io/region': 'eastus',
        'topology.kubernetes.io/zone': `eastus-${(i % 3) + 1}`,
      },
      details: {
        internalIP: `10.240.0.${i + 3}`,
        cpu,
        memory: mem,
        kubeletVersion: 'v1.28.3',
        osImage: 'Ubuntu 22.04.3 LTS',
      },
    });
    clusterNodes.push(nodeId);
  }

  // 2. Generate Namespaces
  const namespaces = config.namespaces;
  namespaces.forEach(ns => {
    addNode({
      id: `namespace/${ns}`,
      name: ns,
      type: 'namespace',
      status: 'Active',
      labels: {
        'kubernetes.io/metadata.name': ns,
        'istio-injection': ns.includes('system') ? 'disabled' : 'enabled',
      },
      details: {
        creationTimestamp: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
        uid: `${randomString(8)}-${randomString(4)}-${randomString(4)}-${randomString(4)}-${randomString(12)}`,
      },
    });
  });

  // 3. Generate Workloads and Services for each namespace
  namespaces.forEach(ns => {
    const isSystem = ns.includes('system');
    const isMonitoring = ns.includes('monitoring') || ns.includes('logging');

    // Number of service stacks to create in this namespace
    let numServices = config.servicesPerNamespace;
    if (isSystem) numServices = Math.max(1, Math.floor(config.servicesPerNamespace * 0.4));
    if (isMonitoring) numServices = Math.max(1, Math.floor(config.servicesPerNamespace * 0.6));

    // Common names for workloads
    const appsList = isSystem
      ? [
          'kube-dns',
          'kube-proxy',
          'metrics-server',
          'aws-node',
          'ebs-csi-controller',
          'tunnelfront',
          'coredns',
        ]
      : isMonitoring
        ? [
            'prometheus-server',
            'grafana',
            'node-exporter',
            'alertmanager',
            'fluent-bit',
            'loki',
            'kibana',
          ]
        : [
            'auth-service',
            'payment-gateway',
            'shopping-cart',
            'order-processor',
            'inventory-db',
            'frontend',
            'notification-service',
            'recommendation-engine',
            'search-indexer',
            'cache-redis',
          ];

    const usedApps = new Set();

    for (let s = 0; s < numServices; s++) {
      let appName = '';
      do {
        appName = randomChoice(appsList);
        if (usedApps.size >= appsList.length) {
          appName = `${appName}-${randomString(3)}`;
          break;
        }
      } while (usedApps.has(appName));
      usedApps.add(appName);

      const isDb =
        appName.includes('db') ||
        appName.includes('redis') ||
        appName.includes('cache') ||
        appName.includes('indexer') ||
        appName.includes('loki');
      const workloadType = isDb
        ? 'statefulset'
        : appName.includes('exporter') || appName.includes('proxy') || appName.includes('fluent')
          ? 'daemonset'
          : 'deployment';

      const workloadId = `${workloadType}/${ns}/${appName}`;
      const workloadName = appName;

      const desiredReplicas =
        workloadType === 'daemonset'
          ? numNodes
          : sizeName === 'small'
            ? 1
            : sizeName === 'medium'
              ? 2
              : randomChoice([2, 3, 5]);
      const runningReplicas = workloadType === 'daemonset' ? numNodes : desiredReplicas;
      const workloadStatus = 'Running';

      // 3.1 Workload Node
      addNode({
        id: workloadId,
        name: workloadName,
        type: workloadType,
        namespace: ns,
        status: workloadStatus,
        labels: {
          app: appName,
          version: 'v1.2.0',
          tier: isDb ? 'backend' : 'frontend',
        },
        details: {
          replicas: `${runningReplicas}/${desiredReplicas}`,
          strategy: workloadType === 'deployment' ? 'RollingUpdate' : 'OnDelete',
          creationTimestamp: new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString(),
        },
      });
      // Link Namespace -> Workload
      addLink(`namespace/${ns}`, workloadId, 'contains');

      // 3.2 ServiceAccount
      const saName = `${appName}-sa`;
      const saId = `serviceaccount/${ns}/${saName}`;
      addNode({
        id: saId,
        name: saName,
        type: 'serviceaccount',
        namespace: ns,
        status: 'Active',
        labels: {},
        details: {},
      });
      addLink(`namespace/${ns}`, saId, 'contains');

      // 3.3 ReplicaSet (only for deployments)
      let replicaSetId = null;
      if (workloadType === 'deployment') {
        const rsName = `${appName}-${randomString(9)}`;
        replicaSetId = `replicaset/${ns}/${rsName}`;
        addNode({
          id: replicaSetId,
          name: rsName,
          type: 'replicaset',
          namespace: ns,
          status: 'Active',
          labels: { app: appName },
          details: { replicas: `${desiredReplicas}/${desiredReplicas}` },
        });
        addLink(`namespace/${ns}`, replicaSetId, 'contains');
        addLink(workloadId, replicaSetId, 'manages');
      }

      // 3.4 PVC if DB
      if (isDb) {
        const pvcName = `data-volume-${appName}-${randomString(4)}`;
        const pvcId = `pvc/${ns}/${pvcName}`;
        addNode({
          id: pvcId,
          name: pvcName,
          type: 'pvc',
          namespace: ns,
          status: 'Bound',
          labels: {},
          details: {
            storageClass: 'managed-premium',
            capacity: randomChoice(['10Gi', '50Gi', '100Gi', '500Gi']),
            accessModes: ['ReadWriteOnce'],
          },
        });
        addLink(`namespace/${ns}`, pvcId, 'contains');
      }

      // 3.5 Pods
      const podIds = [];
      for (let p = 0; p < runningReplicas; p++) {
        const podName =
          workloadType === 'deployment'
            ? `${appName}-${randomString(9)}-${randomString(5)}`
            : `${appName}-${p}`;
        const podId = `pod/${ns}/${podName}`;
        podIds.push(podId);

        addNode({
          id: podId,
          name: podName,
          type: 'pod',
          namespace: ns,
          status: 'Running',
          labels: {
            app: appName,
            podTemplateHash: randomString(9),
            version: 'v1.2.0',
          },
          details: {
            podIP: randomIP(),
            hostIP: `10.240.0.${Math.floor(Math.random() * numNodes) + 4}`,
            nodeName: `aks-nodepool-${sizeName}-${Math.floor(Math.random() * numNodes) + 1}`,
            restartCount: Math.random() > 0.95 ? Math.floor(Math.random() * 5).toString() : '0',
            serviceAccountName: saName,
          },
        });
        addLink(`namespace/${ns}`, podId, 'contains');

        // Link ServiceAccount to Pod
        addLink(saId, podId, 'binds');

        // Link Pod to Workload/RS
        const parentId = replicaSetId || workloadId;
        addLink(parentId, podId, 'manages');

        // Link Pod to Node
        const randomNodeId = randomChoice(clusterNodes);
        addLink(randomNodeId, podId, 'hosts');

        // Link PVC to Pod if Db
        if (isDb) {
          const targetPvc = nodes.find(
            n =>
              n.type === 'pvc' && n.namespace === ns && n.name.startsWith(`data-volume-${appName}`)
          );
          if (targetPvc) {
            addLink(podId, targetPvc.id, 'claims-volume');
          }
        }
      }

      // 3.6 Service
      const svcName = appName;
      const svcId = `service/${ns}/${svcName}`;
      addNode({
        id: svcId,
        name: svcName,
        type: 'service',
        namespace: ns,
        status: 'Active',
        labels: { app: appName },
        details: {
          serviceType: 'ClusterIP',
          clusterIP: `10.0.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`,
          ports: [
            randomChoice([
              '80/TCP (http)',
              '8080/TCP (http)',
              '443/TCP (https)',
              '9090/TCP (grpc)',
              '6379/TCP (redis)',
            ]),
          ],
        },
      });
      addLink(`namespace/${ns}`, svcId, 'contains');

      // Link Service to Pods
      podIds.forEach(podId => {
        addLink(svcId, podId, 'routes-to', { protocol: 'http' });
      });

      // 3.7 Istio & Gateway resources for frontends
      if (appName === 'frontend' && !isSystem) {
        // Gateway
        const gwName = `${appName}-gateway`;
        const gwId = `gateway/${ns}/${gwName}`;
        addNode({
          id: gwId,
          name: gwName,
          type: 'gateway',
          namespace: ns,
          status: 'Active',
          labels: { app: appName },
          details: { servers: ['80/HTTP (*)', '443/HTTPS (*)'] },
        });
        addLink(`namespace/${ns}`, gwId, 'contains');

        // VirtualService
        const vsName = `${appName}-vs`;
        const vsId = `virtualservice/${ns}/${vsName}`;
        addNode({
          id: vsId,
          name: vsName,
          type: 'virtualservice',
          namespace: ns,
          status: 'Active',
          labels: {},
          details: { hosts: [`${ns}.demo.kube3d.io`], gateways: [gwName] },
        });
        addLink(`namespace/${ns}`, vsId, 'contains');
        addLink(gwId, vsId, 'routes-to', { protocol: 'http' });
        addLink(vsId, svcId, 'routes-to', { protocol: 'http' });

        // DestinationRule
        const drName = `${appName}-dr`;
        const drId = `destinationrule/${ns}/${drName}`;
        addNode({
          id: drId,
          name: drName,
          type: 'destinationrule',
          namespace: ns,
          status: 'Active',
          labels: {},
          details: { host: svcName, trafficPolicy: 'LOAD_BALANCER: ROUND_ROBIN' },
        });
        addLink(`namespace/${ns}`, drId, 'contains');
        addLink(drId, svcId, 'configures');
      }

      // 3.8 Ingresses (for some public services)
      if ((appName === 'frontend' || appName === 'grafana') && !isSystem) {
        const ingressName = `${appName}-ingress`;
        const ingressId = `ingress/${ns}/${ingressName}`;
        addNode({
          id: ingressId,
          name: ingressName,
          type: 'ingress',
          namespace: ns,
          status: 'Active',
          labels: {},
          details: {
            hosts: [`${appName}.${ns}.kube3d.io`],
            loadBalancer: `20.12.87.${Math.floor(Math.random() * 254) + 1}`,
          },
        });
        addLink(`namespace/${ns}`, ingressId, 'contains');
        addLink(ingressId, svcId, 'exposes', { protocol: 'http' });
      }
    }
  });

  // 4. Random cross-service links (e.g. apps talking to each other)
  const services = nodes.filter(n => n.type === 'service' && !n.namespace.includes('system'));
  services.forEach(svc => {
    if (svc.name === 'frontend') {
      const namespaceServices = services.filter(
        s => s.namespace === svc.namespace && s.name !== 'frontend'
      );
      namespaceServices.forEach(otherSvc => {
        const frontendPods = nodes.filter(
          n => n.type === 'pod' && n.namespace === svc.namespace && n.name.startsWith('frontend')
        );
        frontendPods.forEach(pod => {
          addLink(pod.id, otherSvc.id, 'routes-to', { protocol: 'http' });
        });
      });
    } else if (svc.name.includes('service') && !svc.name.includes('auth')) {
      const dbSvc = services.find(
        s =>
          s.namespace === svc.namespace &&
          (s.name.includes('db') || s.name.includes('redis') || s.name.includes('cache'))
      );
      const authSvc = services.find(s => s.namespace === svc.namespace && s.name.includes('auth'));

      const backendPods = nodes.filter(
        n => n.type === 'pod' && n.namespace === svc.namespace && n.name.startsWith(svc.name)
      );
      backendPods.forEach(pod => {
        if (dbSvc) addLink(pod.id, dbSvc.id, 'routes-to', { protocol: 'tcp' });
        if (authSvc) addLink(pod.id, authSvc.id, 'routes-to', { protocol: 'http' });
      });
    }
  });

  console.log(`Generated ${sizeName} cluster: ${nodes.length} nodes, ${links.length} links`);
  return { nodes, links };
}

// Configs for different sizes
const configs = {
  small: {
    nodes: 2,
    namespaces: ['kube-system', 'default'],
    servicesPerNamespace: 2,
  },
  medium: {
    nodes: 4,
    namespaces: ['kube-system', 'default', 'monitoring', 'dev'],
    servicesPerNamespace: 3,
  },
  large: {
    nodes: 12,
    namespaces: [
      'kube-system',
      'default',
      'monitoring',
      'logging',
      'dev',
      'staging',
      'istio-system',
    ],
    servicesPerNamespace: 5,
  },
  xl: {
    nodes: 35,
    namespaces: [
      'kube-system',
      'default',
      'monitoring',
      'logging',
      'dev-a',
      'dev-b',
      'staging-a',
      'staging-b',
      'prod-a',
      'prod-b',
      'istio-system',
      'cert-manager',
    ],
    servicesPerNamespace: 7,
  },
  xxl: {
    nodes: 80,
    namespaces: [
      'kube-system',
      'default',
      'monitoring',
      'logging',
      'istio-system',
      'cert-manager',
      'dev-auth',
      'dev-payments',
      'dev-store',
      'dev-shipping',
      'staging-auth',
      'staging-payments',
      'staging-store',
      'staging-shipping',
      'prod-auth',
      'prod-payments',
      'prod-store',
      'prod-shipping',
      'prod-db',
      'vault',
    ],
    servicesPerNamespace: 10,
  },
};

const outputDir = path.join(__dirname, '..', 'public', 'data');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

Object.entries(configs).forEach(([size, config]) => {
  const data = generateClusterData(size, config);
  const outputPath = path.join(outputDir, `${size}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`Wrote dataset to ${outputPath}`);
});
