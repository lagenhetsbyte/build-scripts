#!/bin/bash
set -e

echo "Downloading cleanup script"
wget -N https://raw.githubusercontent.com/lagenhetsbyte/build-scripts/master/blackbox/registry-cleanup.sh
echo "Moving script"
mv ./registry-cleanup.sh /mnt/docker-registry-storage/

echo "Adding job to crontab if not already there"
grep -qxF '*/15 * * * * root /mnt/docker-registry-storage/registry-cleanup.sh' /etc/crontab || echo '*/15 * * * * root /mnt/docker-registry-storage/registry-cleanup.sh' >>/etc/crontab

echo "Reloading cronjob"
sudo service cron reload
