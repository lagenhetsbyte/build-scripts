#!/bin/bash
set -e

echo "Variables:"

for ARGUMENT in "$@"; do

    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
    declare $KEY="$VALUE"
    echo $KEY="$VALUE"

done

if [ -f "/swapfile" ]; then
    echo "Swap exists"
else
    echo "Add swap"
    sudo fallocate -l 4G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
    sudo sysctl vm.swappiness=10
    echo '/vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
fi

echo "Update repo"
sudo apt update
echo "Install fail2ban"
sudo apt install fail2ban -y

echo "Install microk8s snap"
sudo snap install microk8s --classic --channel=1.25
echo "Set microk8s user"
sudo usermod -a -G microk8s $USER
echo "Set kube user"
sudo chown -f -R $USER ~/.kube
echo "Check microk8s status"
sudo microk8s status --wait-ready
echo "Enable microk8s addons"
sudo microk8s enable dns
echo "Set microk8s alias"
alias kubectl='microk8s kubectl'

echo "Install docker"
sudo apt install docker.io -y
echo "Install nodejs"
sudo apt install nodejs -y
echo "Install unzip"
sudo apt install unzip -y

echo "Install AWS"
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli
ls -l /usr/local/bin/aws
