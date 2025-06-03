const { Gateway, Wallets } = require('fabric-network');
const fs = require('fs');
const path = require('path');

async function testConnection() {
    try {
        console.log('Testing blockchain connection...');
        
        // Determine which connection profile to use
        const isExternal = process.env.EXTERNAL_ACCESS === 'true';
        const profileName = isExternal ? 'connection-profile-external.json' : 'connection-profile.json';
        console.log(`Using connection profile: ${profileName}`);
        
        // Load connection profile
        const connectionProfilePath = path.join(__dirname, profileName);
        if (!fs.existsSync(connectionProfilePath)) {
            console.error(`Connection profile not found at ${connectionProfilePath}`);
            return false;
        }
        
        const connectionProfile = JSON.parse(fs.readFileSync(connectionProfilePath, 'utf8'));
        
        // Get the wallet
        const walletPath = path.join(__dirname, 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        
        // Check if admin identity exists
        const adminIdentity = await wallet.get('admin');
        if (!adminIdentity) {
            console.error('Admin identity not found in wallet');
            return false;
        }
        
        // Create gateway instance
        const gateway = new Gateway();
        
        // Connect to gateway
        console.log('Connecting to gateway...');
        await gateway.connect(connectionProfile, {
            wallet,
            identity: 'admin',
            discovery: { 
                enabled: true, 
                asLocalhost: !isExternal 
            },
            eventHandlerOptions: {
                commitTimeout: 300
            },
            tlsOptions: {
                rejectUnauthorized: false
            }
        });
        
        // Get network and contract
        console.log('Getting network...');
        const network = await gateway.getNetwork('medchannel');
        
        console.log('Getting contract...');
        const contract = network.getContract('medicalmanagement');
        
        // Try a simple query
        console.log('Querying contract...');
        try {
            const result = await contract.evaluateTransaction('getUserProfile', 'admin');
            console.log('Query successful:', JSON.parse(result.toString()));
            console.log('✅ Connection test SUCCESSFUL!');
            return true;
        } catch (error) {
            console.error('Query failed:', error.message);
            console.log('❌ Connection test FAILED at contract query');
            return false;
        } finally {
            gateway.disconnect();
        }
    } catch (error) {
        console.error('Connection test failed:', error.message);
        console.log('❌ Connection test FAILED');
        return false;
    }
}

// Run the test
testConnection().then(success => {
    if (success) {
        console.log('Connection test completed successfully');
        process.exit(0);
    } else {
        console.log('Connection test failed');
        process.exit(1);
    }
}).catch(error => {
    console.error('Test threw an exception:', error);
    process.exit(1);
}); 