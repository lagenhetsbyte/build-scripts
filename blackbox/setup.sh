#!/bin/bash
set -e

echo "Variables:"

for ARGUMENT in "$@"; do

    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
    declare $KEY="$VALUE"
    echo $KEY="$VALUE"

done

sudo apt update
sudo apt install fail2ban -y

sudo snap install microk8s --classic --channel=1.25
sudo usermod -a -G microk8s $USER
sudo chown -f -R $USER ~/.kube
microk8s status --wait-ready
microk8s enable dns istio
alias kubectl='microk8s kubectl'

sudo apt install docker.io -y
apt install nodejs -y

sudo apt install unzip -y
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli
ls -l /usr/local/bin/aws

sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo '/vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
