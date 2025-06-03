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

# Step 1: Stop any running application
print_section "Stopping any running MMU web application"
# Try systemd service if it exists
systemctl stop mmu 2>/dev/null || echo "mmu.service not found, checking for running processes"
# Look for Node.js processes running app.js and kill them
pkill -f "node.*app.js" 2>/dev/null || echo "No running node processes found"

# Step 2: Shut down and clean up the existing network
print_section "Shutting down and cleaning up existing network"
cd $CURRENT_DIR/fabric-samples/test-network
./network.sh down

# Step 3: Clean up the website data
print_section "Cleaning up website data"
print_subsection "Removing database and wallet files"
rm -f $CURRENT_DIR/website/database.db
rm -f $CURRENT_DIR/website/wallet/*
echo "Database and wallet files removed"

# Step 4: Copy the updated chaincode
print_section "Updating chaincode"
mkdir -p $CURRENT_DIR/fabric-samples/chaincode-external/medical
cp -r $CURRENT_DIR/chaincode/medical-management/* $CURRENT_DIR/fabric-samples/chaincode-external/medical/

# Step 5: Update chaincode dependencies
print_subsection "Installing chaincode dependencies"
cd $CURRENT_DIR/fabric-samples/chaincode-external/medical
npm install

# Step 6: Start the network with CouchDB
print_section "Starting the network with CouchDB"
cd $CURRENT_DIR/fabric-samples/test-network
./network.sh up createChannel -c medchannel -s couchdb

# Step 7: Deploy the chaincode
print_subsection "Deploying updated medical management chaincode"
./network.sh deployCC -ccn medicalmanagement -ccp ../chaincode-external/medical -ccl javascript -c medchannel

# Step 8: Initialize the ledger
print_section "Initializing the ledger with default data"

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

# Step 9: Setup application credentials
print_section "Setting up application credentials"
cd $CURRENT_DIR/website

# Remove any existing wallet files and create fresh admin wallet
print_subsection "Creating admin identity in wallet"
rm -rf wallet/*
node add-to-wallet.js || echo "Failed to add admin to wallet - you may need to do this manually"

# Step 10: Create necessary directories for file uploads
print_section "Setting up file directories"
mkdir -p $CURRENT_DIR/website/uploads
mkdir -p $CURRENT_DIR/website/downloads
chmod 777 $CURRENT_DIR/website/uploads
chmod 777 $CURRENT_DIR/website/downloads

# Step 11: Start the MMU web application
print_section "Starting the MMU web application"

# Attempt to use systemd service if it exists
if systemctl list-unit-files | grep -q mmu.service; then
    print_subsection "Using systemd service"
    systemctl start mmu || echo "Failed to start mmu service, will try running manually"
else
    # Manually start the application
    print_subsection "Starting application manually"
    cd $CURRENT_DIR/website
    
    # Set the environment variable for external access
    export EXTERNAL_ACCESS=true
    
    # Check if there's a process manager being used
    if command -v pm2 &> /dev/null; then
        print_subsection "Starting with PM2"
        pm2 delete mmu 2>/dev/null || true
        pm2 start app.js --name mmu
    else
        print_subsection "Starting with nohup"
        # Kill any existing Node.js processes running the app
        pkill -f "node app.js" || true
        sleep 2
        nohup node app.js > app.log 2>&1 &
        echo "Application started with PID: $!"
    fi
fi

print_success "Network and application have been restarted successfully!"
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "Access the application at: http://$SERVER_IP:3000"
echo "Default admin credentials:"
echo "  Username: admin"
echo "  Password: adminpw"

# Remove the trap before exiting successfully
trap - EXIT 