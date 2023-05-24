#!/bin/bash

set -e

KEEP=5
BASE_PATH=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
REGISTRY_REPO_PATH="/docker/registry/v2/repositories"
REGISTRY_IMAGE_PATH="/_manifests/tags"

REPOS=($(sudo ls "$BASE_PATH$REGISTRY_REPO_PATH"))
for i in "${!REPOS[@]}"; do
    REPO=${REPOS[i]}
    REGISTRY_IMAGE_FULL_PATH=$BASE_PATH$REGISTRY_REPO_PATH/$REPO$REGISTRY_IMAGE_PATH

    IMAGE_DIRS=($(sudo ls -A1t $REGISTRY_IMAGE_FULL_PATH || true))
    for i in "${!IMAGE_DIRS[@]}"; do

        CURRENT_DIR=${IMAGE_DIRS[i]}
        if [[ $i -gt $(($KEEP - 1)) ]]; then
            echo "Deleting image: $REPO:$CURRENT_DIR"
            sudo rm -Rf $REGISTRY_IMAGE_FULL_PATH/$CURRENT_DIR
            CLEANUP="yes"
        else
            echo "Keeping image: $REPO:$CURRENT_DIR"
        fi
    done
done

if [ "$CLEANUP" = "yes" ]; then
    echo "Running cleanup"
    sudo microk8s kubectl exec -it deployment/docker-registry -- /bin/sh -c "bin/registry garbage-collect --delete-untagged /etc/docker/registry/config.yml"
    sudo microk8s kubectl rollout restart deployment/docker-registry
fi
