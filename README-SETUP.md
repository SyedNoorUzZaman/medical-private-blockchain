# MMU - Complete Setup Instructions

This guide provides simple instructions for setting up the MMU application on any Ubuntu server.

## Prerequisites

- Ubuntu 22.04 LTS or newer
- At least 4GB of RAM
- At least 20GB of free disk space
- An internet connection
- Root or sudo access

## Setup Steps

1. **First, upload these folders to your VPS:**
   - `chaincode/` - Contains the blockchain smart contracts
   - `website/` - Contains the web application

   Make sure your server has Ubuntu installed and you have root or sudo access.

2. Upload the project files to your server

   Upload the entire project folder to your server using SCP, SFTP, or any other method.

3. Make the setup script executable:

   ```bash
   chmod +x mmu-setup.sh
   ```

4. Run the setup script:

   ```bash
   sudo ./mmu-setup.sh
   ```

   The script will:
   - Install all necessary dependencies
   - Set up Hyperledger Fabric
   - Deploy the chaincode
   - Configure and start the web application

5. Access the web application

   This single script will:
   - Install all required dependencies (Docker, Go, Node.js)
   - Set up Hyperledger Fabric and configure the network
   - Deploy the medical management chaincode
   - Initialize the blockchain with test data
   - Configure the web application
   - Start the application as a system service

4. **Access the application:**
   - After setup completes, the application will be running at: `http://YOUR_SERVER_IP:3000`
   - Default admin credentials:
     - Username: admin
     - Password: adminpw

## Managing the Service

The application runs as a system service. You can manage it using:

- Check status: `systemctl status mmu`
- Restart service: `systemctl restart mmu`
- Stop service: `systemctl stop mmu`
- View logs: `journalctl -u mmu -f`

## Troubleshooting

If you encounter issues:

1. Check the application logs for errors:
   ```bash
   journalctl -u mmu -f
   ```

2. Make sure Docker is running:
   ```bash
   systemctl status docker
   ```

3. **Ensure that Docker containers are running:**
   ```
   docker ps
   ```

4. **Restart the entire blockchain network:**
   ```
   cd fabric-samples/test-network
   ./network.sh down
   ./network.sh up createChannel -c medchannel -s couchdb
   ```

For additional help, refer to the Hyperledger Fabric documentation. 