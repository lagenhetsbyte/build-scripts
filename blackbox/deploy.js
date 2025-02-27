const fs = require("fs");
const {
  runHostScript,
  getMk8sCurrentConfig,
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

const proxyConfigDir = "/mnt/proxy-config";
const nginxConfigFile = path.join(proxyConfigDir, "nginx.conf");
const restyConfigFile = path.join(proxyConfigDir, "resty-http.conf");
const sslConfigFile = path.join(proxyConfigDir, "ssl.conf");

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

    console.log("Generating configs in", templatePath);
    await generateTemplates(service, instruction);

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

    if (service.deployProxy) {
      console.log("Deploying proxy");

      await patchRestyConfig();

      await runHostScript(
        `microk8s kubectl apply -f ${path.join(
          templatePath,
          "generated-proxy.json"
        )} `
      );
    }

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
  }

  if (!isSuccess) {
    throw new Error("Rollout failed for at least one service");
  }
}

async function generateTemplates(service, instruction) {
  let volumes = [];

  if (Array.isArray(service.volumes)) {
    volumes = service.volumes
      .map((v) => ({ ...v, name: `${service.name}-${v.name}` }))
      .flat();
  }

  await generateStorageTemplate([
    ...volumes,
    { name: "proxy-volume", containerPath: "/etc/resty-auto-ssl", size: 1 },
    {
      name: "proxy-config",
      containerPath: "/usr/local/openresty/nginx/conf",
      size: 0.5,
    },
  ]);

  await generateServiceTemplate(service);
  await generateProxyTemplate(service, instruction);
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

async function generateProxyTemplate(service, instruction) {
  const template = JSON.parse(fs.readFileSync("./templates/proxy.json"));
  const container = template.spec.template.spec.containers[0];
  let sites = "";
  let currentFilteredSiteDomains = [];

  const currentSites = await getCurrentProxySitesConfig();

  if (currentSites) {
    const siteDomainMatches = [
      ...currentSites.matchAll(/([\w|\d|.|-]+)=[\w|\d|.|-]+:\d+/gim),
    ];

    const matches = siteDomainMatches.filter(
      (x) => !service.domains.some((d) => d == x[1])
    );

    currentFilteredSiteDomains = matches.map((x) => x[1]);

    const proxySites = matches.map((x) => x[0]);
    sites = proxySites.join(";");
    if (matches.length > 0 && !sites.endsWith(";")) {
      sites += ";";
    }
  }

  for (const domain of service.domains) {
    sites += `${domain}=localhost:${service.servicePort};`;
  }

  const sitesArr = sites.split(";").filter((x) => x);
  const currentSitesArr = currentSites.split(";").filter((x) => x);
  if (sitesArr.some((s) => !currentSitesArr.includes(s))) {
    service.deployProxy = true;
  }

  container.env.push({
    name: "SITES",
    value: sites,
  });

  if (
    instruction.redis &&
    typeof instruction.redis === "object" &&
    instruction.redis.host &&
    instruction.redis.port
  ) {
    container.env.push({
      name: "REDIS_HOST",
      value: instruction.redis.host.toString(),
    });

    container.env.push({
      name: "REDIS_PORT",
      value: instruction.redis.port.toString(),
    });
  }

  const joinedDomains = [
    ...service.domains,
    ...currentFilteredSiteDomains,
  ].join("|");

  if (joinedDomains) {
    container.env.push({
      name: "ALLOWED_DOMAINS",
      value: `(${joinedDomains})`,
    });
  }

  container.env.push({
    name: "LETSENCRYPT_URL",
    value: "https://acme-v02.api.letsencrypt.org/directory",
  });

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
      return "";
    }

    const env = config.spec.template.spec.containers[0].env.find(
      (x) => x.name === "SITES"
    );
    return env.value || "";
  } catch (error) {}

  return "";
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

async function patchRestyConfig() {
  return runHostScript(
    `sudo cp ./templates/resty-http.conf ${restyConfigFile}`
  );
}

async function extractProxyConfigs(dest) {
  await runHostScript(
    "sudo docker run -d --name temp valian/docker-nginx-auto-ssl"
  );

  await runHostScript(`sudo mkdir -p ${dest}`);

  await runHostScript(
    `sudo docker cp temp:/usr/local/openresty/nginx/conf ${dest}`
  );

  await runHostScript(
    `sudo mv ${dest}/conf/* ${dest} && sudo rm -r ${dest}/conf`
  );

  await runHostScript(`sudo docker rm -f temp`);
}

async function patchProxyConfig() {
  if (!fs.existsSync(proxyConfigDir)) {
    console.log("Proxy is not deployed, skipping config patch.");
    return;
  }

  if (fs.readdirSync(proxyConfigDir).length > 0) {
    const nginxConfig = fs.readFileSync(nginxConfigFile, "UTF8");
    const restyConfig = fs.readFileSync(restyConfigFile, "UTF8");
    const sslConfig = fs.readFileSync(sslConfigFile, "UTF-8");

    if (
      !nginxConfig.includes("client_max_body_size 100M;") &&
      !sslConfig.includes("ssl_protocols TLSv1.2 TLSv1.3;") &&
      !restyConfig.includes("ngx.re.match(domain, '.*', 'ijo')")
    ) {
      return;
    }
  }

  await extractProxyConfigs(proxyConfigDir);

  let nginxConfig = fs.readFileSync(nginxConfigFile, "UTF8");
  nginxConfig = nginxConfig.replace(
    "client_max_body_size 100M;",
    `client_header_timeout 10m;\n
     client_body_timeout 10m;\n
     proxy_read_timeout 10m;\n
     proxy_connect_timeout 10m;\n
     proxy_send_timeout 10m;\n
     send_timeout 10m;\n
     client_max_body_size 5120M;\n
     `
  );

  let sslConfig = fs.readFileSync(sslConfigFile, "UTF8");
  sslConfig = sslConfig.replace(
    "ssl_protocols TLSv1.2 TLSv1.3;",
    "ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;"
  );

  sslConfig = sslConfig.replace(
    "ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;",
    "ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:DHE-RSA-AES128-SHA256:DHE-RSA-AES256-SHA256:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES256-SHA256:AES128-SHA:AES256-SHA:DES-CBC3-SHA;"
  );

  patchRestyConfig();

  console.log("Writing patched proxy config files");
  fs.writeFileSync(nginxConfigFile, nginxConfig);
  fs.writeFileSync(sslConfigFile, sslConfig);

  console.log("Restarting proxy to apply changes");
  await runHostScript(
    `microk8s kubectl rollout restart ds proxy-auto-ssl`,
    true
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
    await patchProxyConfig();

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
