#!/bin/bash
set -e

CRON="0 3 * * * root"
COMMAND="cd /mnt/docker-registry-storage && rm registry-cleanup.log || true && bash registry-cleanup.sh | tee -a registry-cleanup.log"

echo "Downloading cleanup script"
wget -N https://raw.githubusercontent.com/lagenhetsbyte/build-scripts/master/blackbox/registry-cleanup.sh
echo "Moving script"
sudo mv ./registry-cleanup.sh /mnt/docker-registry-storage/

echo "Adding job to crontab if not already there"
sudo grep -qxF "$CRON $COMMAND" /etc/crontab || echo "$CRON $COMMAND" >>/etc/crontab

echo "Reloading cronjob"
sudo service cron reload
