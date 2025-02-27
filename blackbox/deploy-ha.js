const fs = require("fs");
const {
  runHostScript,
  getServicePorts,
  copy,
  deleteConfigPath,
  createConfigPath,
  deleteFile,
  isDomainValid,
  getCurrentServiceInfo,
  checkAndRenewMk8sCerts,
} = require("./helpers");
const path = require("path");

let timeout = 120;
let templatePath = "";

async function deploy(instruction) {
  let timeoutStr = `--watch --timeout ${timeout}s`;
  if (!timeout) {
    timeoutStr = "";
  }

  let isSuccess = true;

  const currentServices = await getCurrentServiceInfo();
  const service = instruction.services[0];

  if (!service) {
    throw new Error("No service to deploy");
  }

  if (
    !service.forceDeployment &&
    currentServices.some((x) => x.name == service.name)
  ) {
    const serviceDeploymentStatus = await runHostScript(
      `microk8s kubectl rollout status deployment ${service.name}`,
      false
    );

    if (serviceDeploymentStatus.code !== 0) {
      throw new Error("Not ready for rollout!");
    }
  }

  console.log("Generating configs in", templatePath);
  await generateTemplates(service);

  if (service.dockerLoginCommand) {
    await runHostScript(service.dockerLoginCommand);
  }

  if (fs.existsSync("/root/.docker/config.json")) {
    await runHostScript(
      "sudo cp /root/.docker/config.json /var/snap/microk8s/common/var/lib/kubelet/"
    );
  }

  if (service.preCommand) {
    await runHostScript(service.preCommand);
  }

  const storageTemplatePath = path.join(templatePath, "generated-storage.json");
  if (fs.existsSync(storageTemplatePath)) {
    await runHostScript(
      `microk8s kubectl apply -f ${storageTemplatePath}`,
      false
    );
  }

  await runHostScript(
    `microk8s kubectl apply -f ${path.join(
      templatePath,
      "generated-service.json"
    )}`
  );

  const deployResult = await runHostScript(
    `microk8s kubectl rollout status deployment ${service.name} ${timeoutStr}`,
    false
  );

  if (deployResult.code !== 0) {
    console.log("Rollout for", service.name, "failed, starting rollback.");
    

    const getPodsCmd = `microk8s kubectl get pods --selector=app=${service.name} -o jsonpath='{.items[*].metadata.name}'`;
    const podsResult = await runHostScript(getPodsCmd, false);
    if (podsResult.code === 0 && podsResult.lines && podsResult.lines.length > 0) {
      // lines är array av strängar; i detta fall är pods i första raden
      const podNames = podsResult.lines[0].split(" ");
      for (const podName of podNames) {
        console.log(`Logs for pod: ${podName}`);
        // 2. Visa loggar för varje pod
        await runHostScript(`microk8s kubectl logs ${podName}`, false);
      }
    }

    await runHostScript(
      `microk8s kubectl rollout undo deployment ${service.name}`
    );

    await runHostScript(
      `microk8s kubectl rollout status deployment ${service.name} ${timeoutStr}`
    );

    isSuccess = false;
  } else if (service.postCommand) {
    await runHostScript(service.postCommand);
  }

  if (!isSuccess) {
    throw new Error("Rollout failed for at least one service");
  }

  return service.servicePort;
}

async function generateTemplates(service) {
  let volumes = [];

  if (Array.isArray(service.volumes)) {
    volumes = service.volumes
      .map((v) => ({ ...v, name: `${service.name}-${v.name}` }))
      .flat();
  }

  await generateStorageTemplate(volumes);
  await generateServiceTemplate(service);
}

async function generateStorageTemplate(storages) {
  const template = JSON.parse(fs.readFileSync("./templates/storage.json"));
  const t1 = template.items[0];
  const t2 = template.items[1];
  template.items = [];

  if (!storages || storages.length === 0) {
    return;
  }

  for (const storage of storages.flat()) {
    const t1c = copy(t1);
    const t2c = copy(t2);

    const fullPath = `/mnt/${storage.name}`;

    t1c.metadata.name = storage.name;
    t1c.spec.hostPath.path = fullPath;
    t1c.spec.capacity.storage = `${storage.size}Gi`;
    t2c.metadata.name = `${storage.name}-claim`;
    t2c.spec.resources.requests.storage = `${storage.size}Gi`;

    template.items.push(t1c);
    template.items.push(t2c);

    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  fs.writeFileSync(
    path.join(templatePath, "generated-storage.json"),
    JSON.stringify(template)
  );
}

async function generateServiceTemplate(service) {
  const template = JSON.parse(fs.readFileSync("./templates/service.json"));
  const tService = template.items[0];
  const tDeployment = template.items[1];
  template.items = [];

  const cTService = copy(tService);
  cTService.metadata.name = service.name;
  cTService.metadata.labels.app = service.name;

  cTService.spec.ports = [
    {
      name: `${service.appPort}-${service.appPort}`,
      protocol: "TCP",
      port: service.appPort,
      targetPort: service.appPort,
      nodePort: service.servicePort,
    },
  ];
  cTService.spec.selector.app = service.name;

  const cTDeployment = copy(tDeployment);
  cTDeployment.metadata.name = service.name;
  cTDeployment.metadata.labels.app = service.name;
  cTDeployment.spec.selector.matchLabels.app = service.name;
  cTDeployment.spec.replicas = service.instances || 1;
  cTDeployment.spec.template.metadata.labels.app = service.name;

  if (service.volumes) {
    cTDeployment.spec.template.spec.volumes = [];
    for (const storage of service.volumes) {
      cTDeployment.spec.template.spec.volumes.push({
        name: `${service.name}-${storage.name}`,
        persistentVolumeClaim: {
          claimName: `${service.name}-${storage.name}-claim`,
        },
      });
    }
  }

  const container = copy(cTDeployment.spec.template.spec.containers[0]);
  cTDeployment.spec.template.spec.containers = [];
  container.name = service.name;
  container.image = service.image;
  container.ports = [{ containerPort: service.appPort }];
  container.readinessProbe.httpGet.port = service.appPort;
  container.startupProbe.httpGet.port = service.appPort;

  if (service.healthCheck && service.healthCheck.path) {
    container.readinessProbe.httpGet.path = service.healthCheck.path;
    container.startupProbe.httpGet.path = service.healthCheck.path;
  }

  if (service.volumes) {
    container.volumeMounts = [];
    for (const storage of service.volumes) {
      container.volumeMounts.push({
        mountPath: storage.containerPath,
        name: `${service.name}-${storage.name}`,
      });
    }
  }

  if (service.env && typeof service.env === "object") {
    container.env = [];
    for (const key of Object.keys(service.env)) {
      container.env.push({ name: key, value: service.env[key] });
    }
  }

  if (service.healthCheck && service.healthCheck.disabled) {
    delete container.readinessProbe;
    delete container.startupProbe;
  }

  cTDeployment.spec.template.spec.containers.push(container);

  template.items.push(cTService);
  template.items.push(cTDeployment);

  fs.writeFileSync(
    path.join(templatePath, "generated-service.json"),
    JSON.stringify(template)
  );
}

function validateDomains(services) {
  for (const service of services) {
    if (!Array.isArray(service.domains)) {
      continue;
    }

    for (const domain of service.domains) {
      if (!isDomainValid(domain)) {
        throw new Error(`Invalid service domain: ${domain}`);
      }
    }
  }
}

async function run() {
  try {
    const instructionFile = process.argv[2];

    if (!fs.existsSync(instructionFile)) {
      throw new Error("The instruction file doesnt exist:", instructionFile);
    }

    await checkAndRenewMk8sCerts();

    templatePath = createConfigPath();
    const instruction = JSON.parse(fs.readFileSync(instructionFile));
    if (!isNaN(instruction.deploymentTimeout)) {
      timeout = instruction.deploymentTimeout;
    }

    instruction.services = await getServicePorts(instruction.services);
    validateDomains(instruction.services);
    const servicePort = await deploy(instruction);
    await deleteConfigPath(templatePath);
    await deleteFile(instructionFile);
    console.log(`Service successfully deployed on port: ${servicePort}`);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

run();
