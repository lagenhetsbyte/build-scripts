#!/bin/bash
set -e

# Variables to define
#IMAGE_TAG
#REGISTRY_DOMAIN
#REPO
#HOST
#USER
#SSH_KEY_DIR
#INSTRUCTION_FILE
#REGISTRY_USER
#REGISTRY_PASSWORD
#DOCKERFILE_DIR
#DOCKERFILE
#BUILD_DIR
#HA_MODE

echo "Variables:"

for ARGUMENT in "$@"; do
    
    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
    declare $KEY="$VALUE"
    echo $KEY="$VALUE"
    
done

IMAGE_TAG=$IMAGE_TAG
REPOSITORY_URI=$REGISTRY_DOMAIN/$REPO

echo "Logging in to docker"
echo $REGISTRY_PASSWORD | docker login --username $REGISTRY_USER --password-stdin $REGISTRY_DOMAIN

echo "Build started $(date)"
echo "Building the Docker image..."

if [ -n "$BUILD_DIR" ]; then
    CURRENT_DIR=$PWD
    cd $BUILD_DIR
fi

if [[ ! -z "$DOCKERFILE_DIR" ]]; then
    docker build -f $DOCKERFILE_DIR -t $REPOSITORY_URI:$IMAGE_TAG ..
    elif [[ ! -z "$DOCKERFILE" ]]; then
    docker build -f $DOCKERFILE -t $REPOSITORY_URI:$IMAGE_TAG .
else
    docker build -t $REPOSITORY_URI:$IMAGE_TAG .
fi

if [ -n "$BUILD_DIR" ]; then
    cd $CURRENT_DIR
fi

echo "Build completed $(date)"
echo "Pushing the Docker images"
docker push $REPOSITORY_URI:$IMAGE_TAG

RANDOM_STR=$(cat /proc/sys/kernel/random/uuid | sed 's/[-]//g' | head -c 20)
DEPLOYMENT_INSTRUCTION_FILE="$IMAGE_TAG-deploy-$RANDOM_STR.json"

scp -o StrictHostKeyChecking=no -i "$SSH_KEY_DIR" $INSTRUCTION_FILE "$USER"@"$HOST":"$DEPLOYMENT_INSTRUCTION_FILE"

function ssh_command() {
    echo "Running remote command: $1"
    ssh -o StrictHostKeyChecking=no -i $SSH_KEY_DIR $USER@$HOST "$1"
    echo "Running remote command exit code: $?"
}


if [ -z "$HA_MODE" ]; then
    echo "Downloading blackbox"
    ssh_command "wget -N https://github.com/lagenhetsbyte/build-scripts/raw/master/blackbox/blackbox.zip && unzip -o blackbox.zip"
fi

echo "Replacing image in instruction"
ssh_command "node replace_image.js "$DEPLOYMENT_INSTRUCTION_FILE" "$REPOSITORY_URI:$IMAGE_TAG""

if [ -z "$HA_MODE" ]; then
    echo "Logging in to docker private repo"
    ssh_command "sudo echo "$REGISTRY_PASSWORD" | sudo docker login --username "$REGISTRY_USER" --password-stdin "$REGISTRY_DOMAIN""
    
    echo "Running blackbox deployment"
    ssh_command "sudo node deploy.js "$DEPLOYMENT_INSTRUCTION_FILE""
else
    echo "Running HA deployment"
    ssh_command "sudo node deploy.js "$DEPLOYMENT_INSTRUCTION_FILE" '"$REGISTRY_DOMAIN"||"$REGISTRY_USER"||"$REGISTRY_PASSWORD"'"
fi







