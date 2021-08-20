 #!/bin/bash

check_apt_lock() {
    locked1=$(sudo lsof /var/lib/dpkg/lock-frontend)
    locked2=$(sudo lsof /var/lib/apt/lists/lock)

    if [ -z "$locked1" ] && [ -z "$locked2" ]; then
        echo "0"
    else
        echo "1"
    fi
}

wait_for_apt() {
        echo "Making sure apt is unlocked"
        
        RESULT_APT=$(check_apt_lock)
        while [ "$RESULT_APT" != "0" ]; do
           RESULT_APT=$(check_apt_lock)
           echo "Waiting for apt"
        sleep 5
        done
}

install_docker() {      
    wait_for_apt    
    sudo apt-get update
    sudo apt-get -y install docker.io
    sudo systemctl unmask docker
    sudo systemctl start docker
    sudo systemctl enable docker
    sleep 5
}

install_aws() {    
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
    unzip awscliv2.zip
    sudo ./aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli
    ls -l /usr/local/bin/aws
}

check_docker() {    
    echo "Looking for Docker installation"
    docker --version | grep "Docker version"
    if [ $? -eq 0 ]; then
        echo "Docker is installed"
    else
        echo "Installing docker"
        install_docker
    fi
}

check_aws() {
    echo "Looking for AWS CLI installation"
    aws --version | grep "aws-cli/"
    if [ $? -eq 0 ]; then
        echo "AWS CLI is installed"
    else
        echo "Installing AWS CLI"
        install_aws
    fi
}

check_docker
check_aws
