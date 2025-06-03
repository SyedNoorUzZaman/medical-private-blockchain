/**
 * Helper script to add user identities to the wallet
 * Usage: node add-to-wallet.js [userId]
 * If no userId is provided, it will create the admin identity
 */

const { Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const fs = require('fs');
const path = require('path');

async function createAdminIdentity() {
    try {
        console.log('Creating admin identity in wallet');
        
        // Get the wallet path
        const walletPath = path.join(__dirname, 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        
        // Check if identity already exists
        const adminExists = await wallet.get('admin');
        if (adminExists) {
            console.log('Admin identity already exists in the wallet');
            return true;
        }

        // Load connection profile
        const ccpPath = path.resolve(__dirname, 'connection-profile.json');
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));

        // Create a new CA client for interacting with the CA
        const caInfo = ccp.certificateAuthorities['ca.org1.example.com'];
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        // Read the admin credentials from Fabric
        const adminKeyPath = path.resolve(__dirname, '..', 'fabric-samples', 'test-network', 
            'organizations', 'peerOrganizations', 'org1.example.com', 'users', 'Admin@org1.example.com', 
            'msp', 'keystore', 'priv_sk');
        const adminCertPath = path.resolve(__dirname, '..', 'fabric-samples', 'test-network', 
            'organizations', 'peerOrganizations', 'org1.example.com', 'users', 'Admin@org1.example.com', 
            'msp', 'signcerts', 'Admin@org1.example.com-cert.pem');
            
        let privateKey, certificate;
        
        try {
            // Try to read the key directly
            privateKey = fs.readFileSync(adminKeyPath, 'utf8');
            certificate = fs.readFileSync(adminCertPath, 'utf8');
        } catch (e) {
            // If direct paths don't work, try searching for the key file
            const keyDirPath = path.resolve(__dirname, '..', 'fabric-samples', 'test-network', 
                'organizations', 'peerOrganizations', 'org1.example.com', 'users', 'Admin@org1.example.com', 
                'msp', 'keystore');
            const files = fs.readdirSync(keyDirPath);
            const keyFile = files.find(file => file.endsWith('_sk'));
            if (keyFile) {
                privateKey = fs.readFileSync(path.join(keyDirPath, keyFile), 'utf8');
            }
            
            // Try to find the cert file
            const certDirPath = path.resolve(__dirname, '..', 'fabric-samples', 'test-network', 
                'organizations', 'peerOrganizations', 'org1.example.com', 'users', 'Admin@org1.example.com', 
                'msp', 'signcerts');
            const certFiles = fs.readdirSync(certDirPath);
            const certFile = certFiles.find(file => file.endsWith('.pem'));
            if (certFile) {
                certificate = fs.readFileSync(path.join(certDirPath, certFile), 'utf8');
            }
        }
        
        if (!privateKey || !certificate) {
            throw new Error('Could not find admin private key or certificate');
        }
        
        // Create admin identity
        const adminIdentity = {
            credentials: {
                certificate,
                privateKey,
            },
            mspId: 'Org1MSP',
            type: 'X.509',
        };
        
        // Import the admin identity to the wallet
        await wallet.put('admin', adminIdentity);
        console.log('Successfully created admin identity in wallet');
        return true;
    } catch (error) {
        console.error(`Failed to create admin identity: ${error}`);
        return false;
    }
}

async function createUserIdentity(userId) {
    try {
        console.log(`Creating identity for user: ${userId}`);
        
        // Get the wallet path
        const walletPath = path.join(__dirname, 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        
        // Check if identity already exists
        const exists = await wallet.get(userId);
        if (exists) {
            console.log(`Identity ${userId} already exists in the wallet`);
            return;
        }
        
        // Get the admin identity
        const adminIdentity = await wallet.get('admin');
        if (!adminIdentity) {
            throw new Error('Admin identity does not exist in the wallet');
        }
        
        // Create a new identity for the user based on the admin identity
        const identity = {
            credentials: {
                certificate: adminIdentity.credentials.certificate,
                privateKey: adminIdentity.credentials.privateKey,
            },
            mspId: 'Org1MSP',
            type: 'X.509',
        };
        
        // Add the identity to the wallet
        await wallet.put(userId, identity);
        console.log(`Successfully created wallet identity for user ${userId}`);
        
    } catch (error) {
        console.error(`Failed to create wallet identity: ${error}`);
        process.exit(1);
    }
}

async function main() {
    // Check if admin needs to be created
    await createAdminIdentity();
    
    // Check if user ID was provided
    if (process.argv.length >= 3) {
        const userId = process.argv[2];
        await createUserIdentity(userId);
    }
}

main()
    .then(() => {
        console.log('Done');
        process.exit(0);
    })
    .catch((error) => {
        console.error(`Error: ${error}`);
        process.exit(1);
    }); 