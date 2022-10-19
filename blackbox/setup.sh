#!/bin/bash
set -e

# Variables to define
#AWS_REGION
#AWS_ACCESS_KEY_ID
#AWS_SECRET_ACCESS_KEY

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

aws configure set default.region "$AWS_REGION"
aws configure set aws_access_key_id "$AWS_ACCESS_KEY_ID"
aws configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY"
