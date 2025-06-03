#!/bin/bash

# Exit on error, but print the command that failed
set -e
trap 'last_command=$current_command; current_command=$BASH_COMMAND' DEBUG
trap 'echo "\"${last_command}\" command failed with exit code $?."' EXIT

# Get current directory
CURRENT_DIR=$(pwd)
echo "Working directory: $CURRENT_DIR"

# Colorize output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_section() {
    echo -e "\n${GREEN}=== $1 ===${NC}"
}

print_subsection() {
    echo -e "\n${YELLOW}--- $1 ---${NC}"
}

print_error() {
    echo -e "${RED}ERROR: $1${NC}"
}

print_success() {
    echo -e "${GREEN}SUCCESS: $1${NC}"
}

# Check if running as root or sudo
if [ "$EUID" -ne 0 ]; then
    print_error "Please run this script with sudo or as root"
    exit 1
fi

# Check if required folders exist
if [ ! -d "$CURRENT_DIR/chaincode" ] || [ ! -d "$CURRENT_DIR/website" ]; then
    print_error "Required directories not found. Please make sure you have uploaded the chaincode and website folders."
    exit 1
fi

# Check system requirements
print_section "Checking System Requirements"
MEM_TOTAL=$(grep MemTotal /proc/meminfo | awk '{print $2}')
if [ "$MEM_TOTAL" -lt 4000000 ]; then  # Less than 4GB RAM
    print_error "Your system has less than 4GB RAM. Hyperledger Fabric might not work properly."
    echo "Do you want to continue anyway? (y/n)"
    read -r answer
    if [ "$answer" != "y" ]; then
        exit 1
    fi
fi

# Update and install prerequisites
print_section "Installing Prerequisites"
apt-get update
apt-get upgrade -y

print_subsection "Installing basic utilities"
apt-get install -y git curl wget apt-transport-https ca-certificates gnupg-agent software-properties-common jq

# Docker installation
print_section "Installing Docker and Docker Compose"
if ! command -v docker &> /dev/null; then
    print_subsection "Installing Docker"
    apt-get remove docker docker.io containerd runc || true
    
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    usermod -aG docker $SUDO_USER || usermod -aG docker root
    print_success "Docker installed successfully"
else
    print_success "Docker is already installed"
fi

# Docker Compose installation
if ! command -v docker-compose &> /dev/null; then
    print_subsection "Installing Docker Compose"
    DOCKER_COMPOSE_VERSION="1.29.2"
    curl -L "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    print_success "Docker Compose installed successfully"
else
    print_success "Docker Compose is already installed"
fi

# Go installation
print_section "Installing Go"
if ! command -v go &> /dev/null; then
    GO_VERSION="1.17.13"
    wget https://golang.org/dl/go${GO_VERSION}.linux-amd64.tar.gz
    tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz
    rm go${GO_VERSION}.linux-amd64.tar.gz
    
    # Set up Go environment variables in .profile for current user
    PROFILE_FILE="/root/.profile"
    if [ "$SUDO_USER" != "" ]; then
        PROFILE_FILE="/home/$SUDO_USER/.profile"
    fi
    
    echo 'export PATH=$PATH:/usr/local/go/bin' >> $PROFILE_FILE
    echo 'export GOPATH=$HOME/go' >> $PROFILE_FILE
    echo 'export PATH=$PATH:$GOPATH/bin' >> $PROFILE_FILE
    
    # Also add to current environment
    export PATH=$PATH:/usr/local/go/bin
    export GOPATH=$HOME/go
    export PATH=$PATH:$GOPATH/bin
    
    print_success "Go installed successfully"
else
    print_success "Go is already installed"
fi

# Node.js installation
print_section "Installing Node.js and npm"
if ! command -v node &> /dev/null; then
    curl -sL https://deb.nodesource.com/setup_16.x | bash -
    apt-get install -y nodejs
    print_success "Node.js and npm installed successfully"
else
    print_success "Node.js is already installed"
fi

# Python installation
print_section "Installing Python"
apt-get install -y python3 python3-pip

# Download and install Hyperledger Fabric
print_section "Downloading and installing Hyperledger Fabric"
FABRIC_VERSION="2.2.3"
CA_VERSION="1.5.2"

print_subsection "Downloading Fabric bootstrap script"
curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/bootstrap.sh -o bootstrap.sh
chmod +x bootstrap.sh

print_subsection "Installing Fabric binaries and docker images"
./bootstrap.sh ${FABRIC_VERSION} ${CA_VERSION}

# Set environment variables for Fabric
print_section "Setting up Fabric environment variables"
export PATH=$PATH:$CURRENT_DIR/fabric-samples/bin
export FABRIC_CFG_PATH=$CURRENT_DIR/fabric-samples/config
export FABRIC_LOGGING_SPEC=INFO

# Start the test network
print_section "Setting up Hyperledger Fabric test network"
cd $CURRENT_DIR/fabric-samples/test-network

print_subsection "Bringing down any existing network"
./network.sh down

print_subsection "Starting the network with CouchDB"
./network.sh up createChannel -c medchannel -s couchdb

cd $CURRENT_DIR

# Deploy chaincode
print_section "Preparing and installing chaincode"
mkdir -p $CURRENT_DIR/fabric-samples/chaincode-external/medical
cp -r $CURRENT_DIR/chaincode/medical-management/* $CURRENT_DIR/fabric-samples/chaincode-external/medical/

cd $CURRENT_DIR/fabric-samples/chaincode-external/medical
print_subsection "Installing chaincode dependencies"
npm install

cd $CURRENT_DIR/fabric-samples/test-network
print_subsection "Deploying medical management chaincode"
./network.sh deployCC -ccn medicalmanagement -ccp ../chaincode-external/medical -ccl javascript -c medchannel

# Initialize the ledger
print_section "Initializing the ledger with test data"

# Set environment variables for Fabric CLI
export PATH=$PATH:$CURRENT_DIR/fabric-samples/bin
export FABRIC_CFG_PATH=$CURRENT_DIR/fabric-samples/config
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE=$CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=$CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051

print_subsection "Initializing the ledger (creates admin user)"
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $CURRENT_DIR/fabric-samples/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem \
  -C medchannel -n medicalmanagement \
  --peerAddresses localhost:7051 --tlsRootCertFiles $CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
  --peerAddresses localhost:9051 --tlsRootCertFiles $CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
  -c '{"function":"initLedger","Args":[]}' || echo "Initialization may have failed - continuing anyway"

echo "Waiting for transaction to be processed..."
sleep 5

print_subsection "Creating a doctor"
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $CURRENT_DIR/fabric-samples/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem \
  -C medchannel -n medicalmanagement \
  --peerAddresses localhost:7051 --tlsRootCertFiles $CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
  --peerAddresses localhost:9051 --tlsRootCertFiles $CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
  -c '{"function":"createDoctor","Args":["DOC001", "Dr. Jane Smith", "Cardiologist", "+1-555-123-4567"]}' || echo "Doctor creation may have failed - continuing anyway"

echo "Waiting for transaction to be processed..."
sleep 5

print_subsection "Creating a patient"
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $CURRENT_DIR/fabric-samples/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem \
  -C medchannel -n medicalmanagement \
  --peerAddresses localhost:7051 --tlsRootCertFiles $CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
  --peerAddresses localhost:9051 --tlsRootCertFiles $CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt \
  -c '{"function":"createPatient","Args":["PAT001", "John Doe", "1980-05-15", "+1-555-987-6543", "123 Main St, Anytown, USA"]}' || echo "Patient creation may have failed - continuing anyway"

# Set up web application
print_section "Setting up the web application"
cd $CURRENT_DIR/website
npm install

# Update connection profiles with correct paths
print_section "Updating connection profiles"

# Function to update certificate paths in connection profiles
update_certificate_paths() {
    local profile_file=$1
    
    # Update the paths to use absolute paths
    sed -i "s|\"path\": \"../fabric-samples/|\"path\": \"$CURRENT_DIR/fabric-samples/|g" "$profile_file"
    print_success "Updated certificate paths in $profile_file"
}

# Update local connection profile
update_certificate_paths "connection-profile.json"

# Create external connection profile with server IP
SERVER_IP=$(hostname -I | awk '{print $1}')
cp connection-profile.json connection-profile-external.json
sed -i "s/localhost/$SERVER_IP/g" connection-profile-external.json
update_certificate_paths "connection-profile-external.json"

# Create wallet directory and set up admin credentials
print_section "Setting up wallet and admin credentials"
mkdir -p wallet

# Setup admin credentials
ADMIN_MSP_PATH="$CURRENT_DIR/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
node -e "
const fs = require('fs');
const path = require('path');
const { Wallets } = require('fabric-network');

async function setupWallet() {
    try {
        // Create a new wallet
        const wallet = await Wallets.newFileSystemWallet('./wallet');
        
        // Check if admin identity already exists
        const adminExists = await wallet.get('admin');
        if (adminExists) {
            console.log('Admin identity already exists in the wallet');
            return;
        }
        
        // Read admin certificates
        const certPath = path.resolve('$ADMIN_MSP_PATH/signcerts/Admin@org1.example.com-cert.pem');
        const keyDir = path.resolve('$ADMIN_MSP_PATH/keystore');
        
        const cert = fs.readFileSync(certPath).toString();
        
        // Find the private key file (it has a random name)
        const keyFiles = fs.readdirSync(keyDir);
        if (keyFiles.length === 0) {
            throw new Error('No private key found in keystore directory');
        }
        
        const keyPath = path.join(keyDir, keyFiles[0]);
        const key = fs.readFileSync(keyPath).toString();
        
        const identity = {
            credentials: {
                certificate: cert,
                privateKey: key,
            },
            mspId: 'Org1MSP',
            type: 'X.509',
        };
        
        // Save the identity to the wallet
        await wallet.put('admin', identity);
        console.log('Admin identity imported to wallet');
    } catch (error) {
        console.error('Error setting up wallet:', error);
    }
}

setupWallet();
"

# Update hosts file
print_section "Updating hosts file with correct domain names"
SERVER_IP=$(hostname -I | awk '{print $1}')

if ! grep -q "orderer.example.com" /etc/hosts; then
    echo "Adding Fabric hostnames to /etc/hosts..."
    echo "$SERVER_IP orderer.example.com peer0.org1.example.com peer0.org2.example.com ca.org1.example.com ca.org2.example.com" >> /etc/hosts
    print_success "Added Fabric hostnames to /etc/hosts"
else
    print_success "Fabric hostnames already in /etc/hosts"
fi

# Test blockchain connection
print_section "Testing blockchain connection"
cd $CURRENT_DIR/website
node test-connection.js || echo "Connection test failed - continuing anyway"

# Start the web application
print_section "Starting the web application"
echo "Starting MMU web application..."
cd $CURRENT_DIR/website

# Create a systemd service file
cat > /etc/systemd/system/mmu.service << EOF
[Unit]
Description=MMU Web Application
After=network.target

[Service]
Environment=HOST=0.0.0.0
Environment=EXTERNAL_ACCESS=true
Type=simple
User=root
WorkingDirectory=$CURRENT_DIR/website
ExecStart=/usr/bin/node app.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

# Enable and start the service
systemctl daemon-reload
systemctl enable mmu
systemctl start mmu

print_success "MMU service started"

# Final output
SERVER_IP=$(hostname -I | awk '{print $1}')
print_section "Setup Complete!"
echo "Your MMU application is now running as a service"
echo "Access the application at: http://$SERVER_IP:3000"
echo ""
echo "Default admin credentials:"
echo "  Username: admin"
echo "  Password: adminpw"
echo ""
echo "To check service status: systemctl status mmu"
echo "To restart the service: systemctl restart mmu"
echo "To stop the service: systemctl stop mmu"
echo "To view logs: journalctl -u mmu -f"
echo ""
echo "Enjoy using MMU!"

# Remove the trap before exiting successfully
trap - EXIT 