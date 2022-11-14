const fs = require("fs");
const {
  runHostScript,
  getMk8sCurrentConfig,
  getServicePort,
  getServicePorts,
  copy,
  deleteConfigPath,
  createConfigPath,
  deleteFile,
  getCurrentServiceInfo,
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
  for (const service of instruction.services) {
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

    console.log("Waiting for current proxy deployment to complete");
    await runHostScript(
      `microk8s kubectl rollout status ds proxy-auto-ssl`,
      false
    );

    console.log("Generating configs in ", templatePath);
    generateTemplates(service, instruction.sslProduction);

    if (service.dockerLoginCommand) {
      await runHostScript(service.dockerLoginCommand);
      await runHostScript(
        "sudo cp /root/.docker/config.json /var/snap/microk8s/common/var/lib/kubelet/"
      );
    }

    await runHostScript(
      `microk8s kubectl apply -f ${path.join(
        templatePath,
        "generated-storage.json"
      )}`,
      false
    );

    await runHostScript(
      `microk8s kubectl apply -f ${path.join(
        templatePath,
        "generated-service.json"
      )}`
    );

    await runHostScript(
      `microk8s kubectl apply -f ${path.join(
        templatePath,
        "generated-proxy.json"
      )} `
    );

    const deployResult = await runHostScript(
      `microk8s kubectl rollout status deployment ${service.name} ${timeoutStr}`,
      false
    );

    if (deployResult.code !== 0) {
      console.log("Rollout for", service.name, "failed, starting rollback.");

      await runHostScript(
        `microk8s kubectl rollout undo deployment ${service.name}`
      );

      await runHostScript(
        `microk8s kubectl rollout status deployment ${service.name} ${timeoutStr}`
      );

      isSuccess = false;
    }
  }

  if (!isSuccess) {
    throw new Error("Rollout failed for at least one service");
  }
}

function generateTemplates(service, sslProduction) {
  let volumes = [];

  if (Array.isArray(service.volumes)) {
    volumes = service.volumes
      .map((v) => ({ ...v, name: `${service.name}-${v.name}` }))
      .flat();
  }

  generateStorageTemplate([
    ...volumes,
    { name: "proxy-volume", containerPath: "/etc/resty-auto-ssl", size: 1 },
  ]);

  generateServiceTemplate(service);
  generateProxyTemplate(service, sslProduction, []);
}

async function generateStorageTemplate(storages) {
  const template = JSON.parse(fs.readFileSync("./templates/storage.json"));
  const t1 = template.items[0];
  const t2 = template.items[1];
  template.items = [];

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
  }
  cTDeployment.spec.template.spec.containers.push(container);

  template.items.push(cTService);
  template.items.push(cTDeployment);

  fs.writeFileSync(
    path.join(templatePath, "generated-service.json"),
    JSON.stringify(template)
  );
}

async function generateProxyTemplate(service, production, removeServices = []) {
  const template = JSON.parse(fs.readFileSync("./templates/proxy.json"));
  const container = template.spec.template.spec.containers[0];
  let sites = "";

  const prodMode =
    production === null || production === undefined || production === true;

  const currentSites = await getCurrentProxySitesConfig();
  if (currentSites) {
    const arr = currentSites.split(";").map((x) => x.trim());
    const filtered = arr.filter(
      (x) =>
        !service.domains.some((d) => x.includes(`${d}=`)) &&
        !removeServices.some((rs) => x.includes(`${rs.domain}=`))
    );

    sites = filtered.join(";");
    if (filtered.length === 1) {
      sites += ";";
    }
  }

  for (const domain of service.domains) {
    sites += `${domain}=localhost:${service.servicePort};`;
  }

  container.env.push({
    name: "SITES",
    value: sites,
  });

  container.env.push({
    name: "LETSENCRYPT_URL",
    value: prodMode
      ? "https://acme-v02.api.letsencrypt.org/directory"
      : "https://acme-staging-v02.api.letsencrypt.org/directory",
  });

  const currentProdMode = await getCurrentProxyProductionMode();
  if (currentProdMode !== prodMode) {
    await runHostScript("sudo rm -r  /mnt/proxy-volume/", false);
    await runHostScript("sudo mkdir -p /mnt/proxy-volume/", false);
  }

  template.spec.template.spec.containers = [container];

  fs.writeFileSync(
    path.join(templatePath, "generated-proxy.json"),
    JSON.stringify(template)
  );
}

async function getCurrentProxySitesConfig() {
  try {
    const config = await getMk8sCurrentConfig("ds/proxy-auto-ssl");
    if (!config) {
      return null;
    }

    const env = config.spec.template.spec.containers[0].env.find(
      (x) => x.name === "SITES"
    );
    return env.value;
  } catch (error) {}

  return null;
}

async function getCurrentProxyProductionMode() {
  try {
    const config = await getMk8sCurrentConfig("ds/proxy-auto-ssl");
    if (!config) {
      return null;
    }

    const env = config.spec.template.spec.containers[0].env.find(
      (x) => x.name === "LETSENCRYPT_URL"
    );

    return env.value === "https://acme-v02.api.letsencrypt.org/directory";
  } catch (error) {}

  return null;
}

async function removeServices(instruction) {
  if (!Array.isArray(instruction.removeServices)) {
    return;
  }

  for (const service of instruction.removeServices) {
    await runHostScript(
      `microk8s kubectl delete -n default service ${service.name}`,
      false
    );

    await runHostScript(
      `microk8s kubectl delete -n default deployment ${service.name}`,
      false
    );
  }
}

async function run() {
  try {
    const instructionFile = process.argv[2];
    if (!fs.existsSync(instructionFile)) {
      throw new Error("The instruction file doesnt exist:", instructionFile);
    }

    templatePath = createConfigPath();
    const instruction = JSON.parse(fs.readFileSync(instructionFile));
    if (!isNaN(instruction.deploymentTimeout)) {
      timeout = instruction.deploymentTimeout;
    }

    instruction.services = await getServicePorts(instruction.services);
    await deploy(instruction);
    await removeServices(instruction);
    await deleteConfigPath(templatePath);
    await deleteFile(instructionFile);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

run();

//test();

async function test() {
  // const json = require("./data.json");

  // const currentInfo = json.items.map((x) => {
  //   return {
  //     port:
  //       x.spec.ports[0] && x.spec.ports[0].nodePort
  //         ? x.spec.ports[0].nodePort
  //         : null,
  //     name: x.metadata.name,
  //   };
  // });

  // console.log(currentInfo);

  const p = await getServicePort("lagenhetsbyte-paymentss");
  console.log(p);
}
