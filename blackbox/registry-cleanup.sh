#!/bin/bash
set -e

KEEP=3
BASE_PATH="./"
REGISTRY_REPO_PATH="/docker/registry/v2/repositories"
REGISTRY_IMAGE_PATH="/_manifests/tags"

REPOS=($(sudo ls "./docker/registry/v2/repositories"))
for i in "${!REPOS[@]}"; do
    REPO=${REPOS[i]}
    REGISTRY_IMAGE_FULL_PATH=$BASE_PATH$REGISTRY_REPO_PATH/$REPO$REGISTRY_IMAGE_PATH

    IMAGE_DIRS=($(sudo ls -A1t $REGISTRY_IMAGE_FULL_PATH))
    for i in "${!IMAGE_DIRS[@]}"; do

        CURRENT_DIR=${IMAGE_DIRS[i]}
        if [[ $i -gt $(($KEEP - 1)) ]]; then
            echo "Deleting image: $REPO:$CURRENT_DIR"
            sudo rm -Rf $REGISTRY_IMAGE_FULL_PATH/$CURRENT_DIR
            RESTART="yes"
        else
            echo "Keeping image: $REPO:$CURRENT_DIR"
        fi
    done
done

if [ "$RESTART" = "yes" ]; then
    echo "Cleaning up"
    sudo microk8s kubectl rollout restart deployment/docker-registry
fi
