# Blackbox

Microk8s with automatic SSL certs, automatic rollback, and zero downtime (except when adding a domain, which restarts the proxy). Inspired by AWS Lightsail.

## Preps

Install latest Ubuntu LTS version and run these commands:

```
wget https://raw.githubusercontent.com/lagenhetsbyte/build-scripts/master/blackbox/setup.sh
sudo bash ./setup.sh
```

## Instruction file for Blackbox deployment

```json
{
  "services": [
    {
      "image": "strm/helloworld-http",
      "domains": ["somedomain.com"],
      "name": "service1",
      "appPort": 3001
    }
  ]
}
```

All options:

```json
{
  "services": [
    {
      "forceDeployment": false, // Continues deployment without waiting for current deployment to complete.
      "dockerLoginCommand": "sudo aws ecr get-login-password --region eu-north-1 | sudo docker login --username AWS --password-stdin 123123123.dkr.ecr.eu-north-1.amazonaws.com",
      // Optional. Bash command line to sync AWS access key with docker.
      "domains": ["somedomain.com"], // Required, but the array can be empty for services that doesn't have an endpoint.
      "name": "service1", // Required, must be unique.
      "image": "strm/helloworld-http", // deploy.sh adds the new image here. Otherwise, this field is required. Don't use :latest, it ruins automatic rollback.
      "appPort": 3001, // Required.
      "env": {
        // Optional.
        "NODE_ENV": "development"
      },
      "volumes": [
        // Optional.
        {
          "name": "data", // Unique name.
          "containerPath": "/etc/resty-auto-ssl",
          "size": 5 // In GB. Optional, default is 1.
        }
      ],
      "healthCheck": {
        // Optional, defaults to false.
        "disabled": false, // Set to true if no health check endpoint exists.
        "path": "/" // Optional, default is /. Always a GET.
      },
      "instances": 1 // Optional, default is 1. Lowest amount of instances running at the same time.
    }
  ],
  // Optional  
  "deploymentTimeout": 200 // Defaults to 120 (sec). Rollsback on timeout. Why? Because if a pod fails to start, it can take 30 minutes to change state to failed, which is too long.
}
```

## Example 1. Deploy directly on Blackbox

```
wget https://github.com/lagenhetsbyte/build-scripts/raw/master/blackbox/blackbox.zip
unzip ./blackbox.zip
sudo node deploy.js instruction.json
```

## Example 2. Deploy with github action - AWS ECR repo

deploy.sh is made for AWS ECR, but can be modified to work with other services. Make sure that the Blackbox is already logged in on the AWS account.

```yaml
- name: Deploy
  run: |
    wget -N https://raw.githubusercontent.com/lagenhetsbyte/build-scripts/master/blackbox/deploy.sh && bash deploy.sh \
    INSTRUCTION_FILE="./deploy-prod.json" \
    IMAGE_TAG="$prod-{{ github.run_number }}" \
    AWS_REPONAME="testservice" \
    AWS_REGION="eu-north-1" \
    AWS_DOMAIN="123123123.dkr.ecr.eu-north-1.amazonaws.com" \
    VPS_HOST="13.13.13.13" \
    VPS_USER="ubuntu" \
    AWS_ACCESS_KEY_ID="${{ secrets.AWS_ACCESS_KEY_ID }}" \
    AWS_SECRET_ACCESS_KEY="${{ secrets.AWS_SECRET_ACCESS_KEY }}" \
    SSH_KEY_DIR="../ssh_key.pem"
```

## Example 3. Deploy with github action - private repo

```yaml
- name: Deploy
  run: |
    wget -N https://raw.githubusercontent.com/lagenhetsbyte/build-scripts/master/blackbox/deploy-private.sh && bash deploy-private.sh \    
    IMAGE_TAG="${{ github.run_number }}" \
    REPO="testrepo" \
    REGISTRY_DOMAIN="registry.some.domain" \
    HOST="13.13.13.13" \
    USER="docker" \
    SSH_KEY_DIR="../ssh_key.pem" \
    INSTRUCTION_FILE="./deploy.json" \
    REGISTRY_USER="${{ secrets.DOCKER_REGISTRY_USER }}" \
    REGISTRY_PASSWORD="${{ secrets.DOCKER_REGISTRY_PASSWORD }}"
```

## Create private docker registry on Blackbox

Create auth file

```bash
mkdir -p /mnt/docker-registry-auth/
sudo docker run --entrypoint htpasswd httpd:2 -Bbn docker verysecurepassword > htpasswd
cp htpasswd /mnt/docker-registry-auth
```

Create instruction for deployment

```json
{
  "deploymentTimeout": 200,
  "services": [
    {
      "image": "registry:2",
      "domains": ["registry.some.domain"],
      "name": "docker-registry",
      "appPort": 5000,
      "postCommand": "sudo wget -N https://raw.githubusercontent.com/lagenhetsbyte/build-scripts/master/blackbox/install-registry-cleanup.sh && sudo bash install-registry-cleanup.sh",
      "env": {
        "REGISTRY_AUTH": "htpasswd",
        "REGISTRY_AUTH_HTPASSWD_PATH": "/auth/htpasswd",
        "REGISTRY_AUTH_HTPASSWD_REALM": "Registry Realm",
        "REGISTRY_HTTP_SECRET": "anotherSuperSecurePasswordNotSameAsBefore",
        "REGISTRY_STORAGE_DELETE_ENABLED": "true"
      },
      "volumes": [
        { "name": "storage", "containerPath": "/var/lib/registry", "size": 50 },
        { "name": "auth", "containerPath": "/auth", "size": 1 }
      ]
    }
  ]
}
```

Deploy

```bash
wget -N https://github.com/lagenhetsbyte/build-scripts/raw/master/blackbox/blackbox.zip && unzip -o blackbox.zip
sudo node deploy.js instruction.json
```

## Troubleshooting

Useful commands.

### General

```
sudo microk8s kubectl get deployments
sudo microk8s kubectl get services
sudo microk8s kubectl get pods

sudo microk8s kubectl logs deployment/{name}
sudo microk8s kubectl get deployment/{name}
sudo microk8s kubectl delete deployment/{name}
sudo microk8s kubectl delete service/{name}
```

### Proxy

```
sudo microk8s kubectl get ds/proxy-auto-ssl
sudo microk8s kubectl logs ds/proxy-auto-ssl
sudo microk8s kubectl get ds/proxy-auto-ssl -o json --namespace default
sudo microk8s kubectl edit ds/proxy-auto-ssl
```
