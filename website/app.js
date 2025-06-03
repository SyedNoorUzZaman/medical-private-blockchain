'use strict';

const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');

// Fabric network imports 
const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure upload directory exists
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            try {
                fs.mkdirSync(uploadDir, { recursive: true });
                console.log(`Created upload directory: ${uploadDir}`);
            } catch (err) {
                console.error(`Failed to create upload directory: ${err}`);
            }
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Generate unique filename with timestamp and original extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, uniqueSuffix + ext);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: function (req, file, cb) {
        // Accept only certain file types
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
        const allowedExtensions = ['.pdf', '.jpeg', '.jpg', '.png'];
        
        // Check both MIME type and file extension
        const ext = path.extname(file.originalname).toLowerCase();
        
        if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Invalid file type. Only PDF, JPEG and PNG are allowed. You uploaded: ${file.mimetype}`));
        }
    }
});

// Set up middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // Serve files, will add authentication later
app.use(session({
    secret: 'medical-management-blockchain-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Initialize database
const db = new Database(path.join(__dirname, 'database.db'));

// Create users table if it doesn't exist
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`);

// Function to get connection profile based on environment
function getConnectionProfile() {
    // Check if we're in an external access mode (environment variable)
    const isExternalAccess = process.env.EXTERNAL_ACCESS === 'true';
    const connectionProfilePath = path.join(__dirname, 
        isExternalAccess ? 'connection-profile-external.json' : 'connection-profile.json');
    
    if (!fs.existsSync(connectionProfilePath)) {
        console.error(`Connection profile not found at ${connectionProfilePath}`);
        // If external profile doesn't exist, try to use the default one
        const defaultProfilePath = path.join(__dirname, 'connection-profile.json');
        if (fs.existsSync(defaultProfilePath)) {
            console.log(`Using default connection profile instead.`);
            return JSON.parse(fs.readFileSync(defaultProfilePath, 'utf8'));
        }
        throw new Error('No valid connection profile found');
    }
    
    return JSON.parse(fs.readFileSync(connectionProfilePath, 'utf8'));
}

// Function to initialize the wallet
async function initializeWallet() {
    try {
        // Create a new wallet to store user identities
        const walletPath = path.join(__dirname, 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        
        // Check if admin identity exists
        const adminExists = await wallet.get('admin');
        if (adminExists) {
            console.log('Admin identity already exists in the wallet');
            return wallet;
        }
        
        try {
            // Load the connection profile
            const connectionProfile = getConnectionProfile();
            
            // Create a new CA client for interacting with the CA
            const caInfo = connectionProfile.certificateAuthorities['ca.org1.example.com'];
            
            // Get CA certificate
            let caTLSCACerts;
            if (caInfo.tlsCACerts.pem) {
                caTLSCACerts = caInfo.tlsCACerts.pem;
            } else if (caInfo.tlsCACerts.path) {
                try {
                    caTLSCACerts = fs.readFileSync(caInfo.tlsCACerts.path, 'utf8');
                } catch (readError) {
                    console.error(`Error reading CA certificate: ${readError}`);
                    throw readError;
                }
            }
            
            const ca = new FabricCAServices(caInfo.url, { 
                trustedRoots: caTLSCACerts, 
                verify: false 
            }, caInfo.caName);
            
            try {
                // Enroll the admin user
                const enrollment = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
                const x509Identity = {
                    credentials: {
                        certificate: enrollment.certificate,
                        privateKey: enrollment.key.toBytes(),
                    },
                    mspId: 'Org1MSP',
                    type: 'X.509',
                };
                await wallet.put('admin', x509Identity);
                console.log('Admin identity successfully enrolled and added to wallet');
            } catch (caError) {
                console.error(`Failed to enroll admin from CA: ${caError}`);
                console.log('Creating a dummy admin identity for development purposes');
                
                // Create a dummy admin identity for development purposes
                const adminIdentity = {
                    credentials: {
                        certificate: '-----BEGIN CERTIFICATE-----\nMIIB8TCCAZegAwIBAgIUcQF2/sCGkDFQgvZDmStEGTrJxskwCgYIKoZIzj0EAwIw\ncDELMAkGA1UEBhMCVVMxFzAVBgNVBAgTDk5vcnRoIENhcm9saW5hMQ8wDQYDVQQH\nEwZEdXJoYW0xGTAXBgNVBAoTEG9yZzEuZXhhbXBsZS5jb20xHDAaBgNVBAMTE2Nh\nLm9yZzEuZXhhbXBsZS5jb20wHhcNMjIwODAxMTAwMDAwWhcNMjMwODAxMTAwMDAw\nWjAhMQ8wDQYDVQQLEwZjbGllbnQxDjAMBgNVBAMTBWFkbWluMFkwEwYHKoZIzj0C\nAQYIKoZIzj0DAQcDQgAEw3l91+fYMjVQ81uGiHU8xB2CQsXKQQdm3qEzZdO5xUGx\n7Wd+5y5Joji+JzmZB/1Poy4rJUbTzA+K7xGQ+uUK4aNgMF4wDgYDVR0PAQH/BAQD\nAgeAMAwGA1UdEwEB/wQCMAAwHQYDVR0OBBYEFNVPdZzY1HuaFDJa9P0D1fZYRR9F\nMB8GA1UdIwQYMBaAFBdL5x0WxlTzxLHcwYG/28nDR8b4MAoGCCqGSM49BAMCA0gA\nMEUCIQCiHu7l2h/kXmk/jgDpaUzr+6SXKvA6a1zn3xLr2kHQJwIgAy0dXe3p1wxK\nLfG3cqgdgbkYKsM4TAO2l0D3wZIe7gM=\n-----END CERTIFICATE-----',
                        privateKey: '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFi3NjAF9BcQuxYp6\nWtzU/3oI4wbJW6DST5o0AS0d24uhRANCAATDmUqSBnWF6Xr6CDWnCGnpQT1w8BbL\nOi8rU2J9OtXBdIfagMhBYB2FR8dhwmoZ07aVYo+yDrOPWZoYLOcODmQG\n-----END PRIVATE KEY-----',
                    },
                    mspId: 'Org1MSP',
                    type: 'X.509',
                };
                await wallet.put('admin', adminIdentity);
                console.log('Dummy admin identity added to wallet for development purposes');
            }
        } catch (profileError) {
            console.error(`Failed to initialize CA client: ${profileError}`);
            console.log('Creating a dummy admin identity for development purposes');
            
            // Create a dummy admin identity for development purposes
            const adminIdentity = {
                credentials: {
                    certificate: '-----BEGIN CERTIFICATE-----\nMIIB8TCCAZegAwIBAgIUcQF2/sCGkDFQgvZDmStEGTrJxskwCgYIKoZIzj0EAwIw\ncDELMAkGA1UEBhMCVVMxFzAVBgNVBAgTDk5vcnRoIENhcm9saW5hMQ8wDQYDVQQH\nEwZEdXJoYW0xGTAXBgNVBAoTEG9yZzEuZXhhbXBsZS5jb20xHDAaBgNVBAMTE2Nh\nLm9yZzEuZXhhbXBsZS5jb20wHhcNMjIwODAxMTAwMDAwWhcNMjMwODAxMTAwMDAw\nWjAhMQ8wDQYDVQQLEwZjbGllbnQxDjAMBgNVBAMTBWFkbWluMFkwEwYHKoZIzj0C\nAQYIKoZIzj0DAQcDQgAEw3l91+fYMjVQ81uGiHU8xB2CQsXKQQdm3qEzZdO5xUGx\n7Wd+5y5Joji+JzmZB/1Poy4rJUbTzA+K7xGQ+uUK4aNgMF4wDgYDVR0PAQH/BAQD\nAgeAMAwGA1UdEwEB/wQCMAAwHQYDVR0OBBYEFNVPdZzY1HuaFDJa9P0D1fZYRR9F\nMB8GA1UdIwQYMBaAFBdL5x0WxlTzxLHcwYG/28nDR8b4MAoGCCqGSM49BAMCA0gA\nMEUCIQCiHu7l2h/kXmk/jgDpaUzr+6SXKvA6a1zn3xLr2kHQJwIgAy0dXe3p1wxK\nLfG3cqgdgbkYKsM4TAO2l0D3wZIe7gM=\n-----END CERTIFICATE-----',
                    privateKey: '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFi3NjAF9BcQuxYp6\nWtzU/3oI4wbJW6DST5o0AS0d24uhRANCAATDmUqSBnWF6Xr6CDWnCGnpQT1w8BbL\nOi8rU2J9OtXBdIfagMhBYB2FR8dhwmoZ07aVYo+yDrOPWZoYLOcODmQG\n-----END PRIVATE KEY-----',
                },
                mspId: 'Org1MSP',
                type: 'X.509',
            };
            await wallet.put('admin', adminIdentity);
            console.log('Dummy admin identity added to wallet for development purposes');
        }
        
        return wallet;
    } catch (error) {
        console.error(`Failed to initialize wallet: ${error}`);
        throw error;
    }
}

// Function to get network connection
async function getContract(userId) {
    try {
        // Load the connection profile using the helper function
        const connectionProfile = getConnectionProfile();
        
        // Create a new gateway instance
        const gateway = new Gateway();
        
        // Get the wallet
        const walletPath = path.join(__dirname, 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        
        // Check if the user identity exists in the wallet
        const userExists = await wallet.get(userId);
        if (!userExists) {
            throw new Error(`User identity ${userId} does not exist in the wallet`);
        }
        
        // Check if we're running with external access
        const isExternalAccess = process.env.EXTERNAL_ACCESS === 'true';
        
        // Connect to the gateway with discovery enabled
        await gateway.connect(connectionProfile, {
            wallet,
            identity: userId,
            discovery: { 
                enabled: true, 
                asLocalhost: !isExternalAccess  // Set to false for external access
            },
            eventHandlerOptions: {
                commitTimeout: 300 // 5 minutes
            },
            // For development, we can disable TLS verification
            tlsOptions: {
                rejectUnauthorized: false
            }
        });
        
        // Get the network and contract
        const network = await gateway.getNetwork('medchannel');
        const contract = network.getContract('medicalmanagement');
        
        return { gateway, contract };
    } catch (error) {
        console.error(`Failed to connect to the network: ${error}`);
        throw error;
    }
}

// Initialize admin user in database if not exists
function initializeAdminUser() {
    try {
        const adminExists = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
        
        if (!adminExists) {
            const hashedPassword = bcrypt.hashSync('adminpw', 10);
            db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)')
                .run('admin', 'admin', hashedPassword, 'admin');
            console.log('Admin user created in the database');
        } else {
            console.log('Admin user already exists in the database');
        }
    } catch (error) {
        console.error(`Failed to initialize admin user: ${error}`);
    }
}

// Initialize admin user
initializeAdminUser();

// Initialize the wallet
initializeWallet().catch(error => {
    console.error(`Failed to initialize wallet: ${error}`);
});

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    }
    res.redirect('/login');
};

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    res.status(403).send('Access denied');
};

// Middleware to check if user is doctor
const isDoctor = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'doctor') {
        return next();
    }
    res.status(403).send('Access denied');
};

// Routes
app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    res.render('index', { title: 'Medical Management Blockchain' });
});

app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    res.render('login', { title: 'Login', error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    try {
        // Find user in database
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.render('login', { title: 'Login', error: 'Invalid username or password' });
        }
        
        // Set session data
        req.session.user = {
            id: user.id,
            username: user.username,
            role: user.role
        };
        
        res.redirect('/dashboard');
    } catch (error) {
        console.error(`Login error: ${error}`);
        res.render('login', { title: 'Login', error: 'An error occurred during login' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        let stats = {
            patients: 0,
            doctors: 0,
            records: 0
        };
        
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get patients count
            if (req.session.user.role === 'admin' || req.session.user.role === 'doctor') {
                const patientsResult = await contract.evaluateTransaction('listAllPatients');
                const patients = JSON.parse(patientsResult.toString());
                stats.patients = patients.length;
            }
            
            // Get doctors count (admin only)
            if (req.session.user.role === 'admin') {
                const doctorsResult = await contract.evaluateTransaction('listAllDoctors');
                const doctors = JSON.parse(doctorsResult.toString());
                stats.doctors = doctors.length;
            }
            
            // Get records count for patient
            if (req.session.user.role === 'patient') {
                const recordsResult = await contract.evaluateTransaction('getPatientMedicalRecords', req.session.user.id);
                const records = JSON.parse(recordsResult.toString());
                stats.records = records.length;
            }
            
            res.render('dashboard', { 
                title: 'Dashboard', 
                user: req.session.user,
                stats: stats,
                error: null,
                success: null
            });
        } catch (error) {
            console.error(`Failed to get stats: ${error}`);
            res.render('dashboard', { 
                title: 'Dashboard', 
                user: req.session.user,
                stats: stats,
                error: error.message,
                success: null
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('dashboard', { 
            title: 'Dashboard', 
            user: req.session.user,
            stats: {
                patients: 0,
                doctors: 0,
                records: 0
            },
            error: 'Failed to process request',
            success: null
        });
    }
});

// Create Doctor route
app.get('/create-doctor', isAuthenticated, isAdmin, (req, res) => {
    res.render('create-doctor', {
        title: 'Create Doctor',
        user: req.session.user,
        error: null,
        success: null
    });
});

// Function to add a user identity to the wallet
async function addToWallet(userId) {
    try {
        console.log(`Creating wallet identity for user: ${userId}`);
        
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
        throw error;
    }
}

app.post('/create-doctor', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { name, specialization, contact, username, password } = req.body;
        
        // Generate a unique ID with a timestamp to prevent conflicts
        const timestamp = new Date().getTime();
        const doctorId = `DOC${timestamp}`;
        
        // Hash the password
        const hashedPassword = bcrypt.hashSync(password, 10);
        
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Create doctor on the blockchain
            await contract.submitTransaction('createDoctor', doctorId, name, specialization, contact);
            
            // Add doctor to the database
            db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)')
                .run(doctorId, username, hashedPassword, 'doctor');
            
            // Add doctor identity to the wallet
            await addToWallet(doctorId);
            
            res.render('create-doctor', {
                title: 'Create Doctor',
                user: req.session.user,
                error: null,
                success: `Doctor ${doctorId} created successfully`
            });
        } catch (error) {
            console.error(`Failed to create doctor: ${error}`);
            res.render('create-doctor', {
                title: 'Create Doctor',
                user: req.session.user,
                error: error.message,
                success: null
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('create-doctor', {
            title: 'Create Doctor',
            user: req.session.user,
            error: 'Failed to process request',
            success: null
        });
    }
});

// Create Patient route
app.get('/create-patient', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // Connect to the blockchain to get the list of doctors
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get all doctors from the blockchain
            const result = await contract.evaluateTransaction('listAllDoctors');
            const doctors = JSON.parse(result.toString());
            
            res.render('create-patient', {
                title: 'Create Patient',
                user: req.session.user,
                doctors: doctors,
                error: null,
                success: null
            });
        } catch (error) {
            console.error(`Failed to get doctors: ${error}`);
            res.render('create-patient', {
                title: 'Create Patient',
                user: req.session.user,
                doctors: [],
                error: error.message,
                success: null
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('create-patient', {
            title: 'Create Patient',
            user: req.session.user,
            doctors: [],
            error: 'Failed to process request',
            success: null
        });
    }
});

app.post('/create-patient', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { name, dateOfBirth, contact, address, username, password, doctorId } = req.body;
        
        // Generate a unique ID with a timestamp to prevent conflicts
        const timestamp = new Date().getTime();
        const patientId = `PAT${timestamp}`;
        
        // Hash the password
        const hashedPassword = bcrypt.hashSync(password, 10);
        
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Create patient on the blockchain with doctorId
            await contract.submitTransaction('createPatient', patientId, name, dateOfBirth, contact, address, doctorId);
            
            // Add patient to the database
            db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)')
                .run(patientId, username, hashedPassword, 'patient');
            
            // Add patient identity to the wallet
            await addToWallet(patientId);
            
            // Get doctors for re-rendering the page
            let doctors = [];
            try {
                const result = await contract.evaluateTransaction('listAllDoctors');
                doctors = JSON.parse(result.toString());
            } catch (err) {
                console.error(`Failed to get doctors: ${err}`);
            }
            
            res.render('create-patient', {
                title: 'Create Patient',
                user: req.session.user,
                doctors: doctors,
                error: null,
                success: `Patient ${patientId} created successfully`
            });
        } catch (error) {
            console.error(`Failed to create patient: ${error}`);
            
            // Get doctors for re-rendering the page
            let doctors = [];
            try {
                const result = await contract.evaluateTransaction('listAllDoctors');
                doctors = JSON.parse(result.toString());
            } catch (err) {
                console.error(`Failed to get doctors: ${err}`);
            }
            
            res.render('create-patient', {
                title: 'Create Patient',
                user: req.session.user,
                doctors: doctors,
                error: error.message,
                success: null
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('create-patient', {
            title: 'Create Patient',
            user: req.session.user,
            doctors: [],
            error: 'Failed to process request',
            success: null
        });
    }
});

// Patients List route
app.get('/patients', isAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'doctor') {
        return res.status(403).send('Access denied');
    }
    
    try {
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get patients from the blockchain
            // For doctors, the chaincode will filter patients to show only those assigned to them
            // For admins, all patients will be shown
            const result = await contract.evaluateTransaction('listAllPatients');
            const patients = JSON.parse(result.toString());
            
            // If we're a doctor, make sure we only have patients assigned to us
            // This is a double-check in case the chaincode filter isn't working
            let filteredPatients = patients;
            if (req.session.user.role === 'doctor') {
                filteredPatients = patients.filter(patient => patient.doctorId === req.session.user.id);
            }
            
            res.render('patients-list', {
                title: 'Patients List',
                user: req.session.user,
                patients: filteredPatients
            });
        } catch (error) {
            console.error(`Failed to get patients: ${error}`);
            res.render('patients-list', {
                title: 'Patients List',
                user: req.session.user,
                patients: [],
                error: error.message
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('patients-list', {
            title: 'Patients List',
            user: req.session.user,
            patients: [],
            error: 'Failed to process request'
        });
    }
});

// Doctors List route (for admin only)
app.get('/doctors', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get all doctors from the blockchain
            const result = await contract.evaluateTransaction('listAllDoctors');
            const doctors = JSON.parse(result.toString());
            
            res.render('doctors-list', {
                title: 'Doctors List',
                user: req.session.user,
                doctors: doctors,
                error: null
            });
        } catch (error) {
            console.error(`Failed to get doctors: ${error}`);
            res.render('doctors-list', {
                title: 'Doctors List',
                user: req.session.user,
                doctors: [],
                error: error.message
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('doctors-list', {
            title: 'Doctors List',
            user: req.session.user,
            doctors: [],
            error: 'Failed to process request'
        });
    }
});

// Patient Records route
app.get('/patient-records/:patientId', isAuthenticated, async (req, res) => {
    const { patientId } = req.params;
    
    // Only allow admin, doctor, or the patient themselves to view records
    if (req.session.user.role !== 'admin' && 
        req.session.user.role !== 'doctor' && 
        req.session.user.id !== patientId) {
        return res.status(403).send('Access denied');
    }
    
    try {
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get patient profile for name
            const patientResult = await contract.evaluateTransaction('getUserProfile', patientId);
            const patient = JSON.parse(patientResult.toString());
            
            // Get patient medical records from the blockchain
            const recordsResult = await contract.evaluateTransaction('getPatientMedicalRecords', patientId);
            const records = JSON.parse(recordsResult.toString());
            
            res.render('patient-records', {
                title: 'Patient Records',
                user: req.session.user,
                patientId: patientId,
                patientName: patient.name,
                records: records
            });
        } catch (error) {
            console.error(`Failed to get patient records: ${error}`);
            res.render('patient-records', {
                title: 'Patient Records',
                user: req.session.user,
                patientId: patientId,
                patientName: 'Unknown',
                records: [],
                error: error.message
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('patient-records', {
            title: 'Patient Records',
            user: req.session.user,
            patientId: patientId,
            patientName: 'Unknown',
            records: [],
            error: 'Failed to process request'
        });
    }
});

// My Records route (for patients)
app.get('/my-records', isAuthenticated, async (req, res) => {
    if (req.session.user.role !== 'patient') {
        return res.status(403).send('Access denied');
    }
    
    const patientId = req.session.user.id;
    
    try {
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get patient profile
            const patientResult = await contract.evaluateTransaction('getUserProfile', patientId);
            const patient = JSON.parse(patientResult.toString());
            
            // Get patient medical records from the blockchain
            const recordsResult = await contract.evaluateTransaction('getPatientMedicalRecords', patientId);
            const records = JSON.parse(recordsResult.toString());
            
            res.render('patient-records', {
                title: 'My Medical Records',
                user: req.session.user,
                patientId: patientId,
                patientName: patient.name,
                records: records
            });
        } catch (error) {
            console.error(`Failed to get patient records: ${error}`);
            res.render('patient-records', {
                title: 'My Medical Records',
                user: req.session.user,
                patientId: patientId,
                patientName: req.session.user.username,
                records: [],
                error: error.message
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('patient-records', {
            title: 'My Medical Records',
            user: req.session.user,
            patientId: patientId,
            patientName: req.session.user.username,
            records: [],
            error: 'Failed to process request'
        });
    }
});

// Add Medical Record routes
app.get('/add-record', isAuthenticated, isDoctor, async (req, res) => {
    try {
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get patients assigned to this doctor from the blockchain
            const result = await contract.evaluateTransaction('listAllPatients');
            let patients = JSON.parse(result.toString());
            
            // Filter patients to only show those assigned to this doctor
            patients = patients.filter(patient => patient.doctorId === req.session.user.id);
            
            res.render('add-record', {
                title: 'Add Medical Record',
                user: req.session.user,
                patients: patients,
                patientId: null,
                error: null,
                success: null
            });
        } catch (error) {
            console.error(`Failed to get patients: ${error}`);
            res.render('add-record', {
                title: 'Add Medical Record',
                user: req.session.user,
                patients: [],
                patientId: null,
                error: error.message,
                success: null
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('add-record', {
            title: 'Add Medical Record',
            user: req.session.user,
            patients: [],
            patientId: null,
            error: 'Failed to process request',
            success: null
        });
    }
});

app.get('/add-record/:patientId', isAuthenticated, isDoctor, async (req, res) => {
    const { patientId } = req.params;
    
    res.render('add-record', {
        title: 'Add Medical Record',
        user: req.session.user,
        patients: [],
        patientId: patientId,
        error: null,
        success: null
    });
});

app.post('/add-record', isAuthenticated, isDoctor, upload.single('medicalFile'), async (req, res) => {
    try {
        const { patientId, diagnosisDate, diagnosis, treatment, medications, notes } = req.body;
        let fileData = null;
        let fileName = null;
        let fileType = null;
        let tempRecordId = null;
        
        // Process uploaded file if any
        if (req.file) {
            try {
                // Read the file
                const fileBuffer = fs.readFileSync(req.file.path);
                
                // Generate a random key for encryption
                const encryptionKey = crypto.randomBytes(32); // 256 bits key
                const iv = crypto.randomBytes(16); // Initialization vector
                
                // Encrypt the file using AES-256-CBC
                const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
                let encryptedData = cipher.update(fileBuffer);
                encryptedData = Buffer.concat([encryptedData, cipher.final()]);
                
                // Create the encrypted file data (adding IV at the beginning so we can decrypt later)
                const encryptedFileData = Buffer.concat([iv, encryptedData]);
                
                // Base64 encode the encrypted data for storage on blockchain
                fileData = encryptedFileData.toString('base64');
                fileName = req.file.originalname;
                fileType = req.file.mimetype;
                
                // Store the encryption key in the database for later retrieval
                // This could be enhanced with more secure key management
                db.prepare('CREATE TABLE IF NOT EXISTS file_keys (record_id TEXT PRIMARY KEY, encryption_key TEXT, iv TEXT)')
                  .run();
                
                // Create a temporary record ID to be updated later
                tempRecordId = `TEMP_${Date.now()}`;
                db.prepare('INSERT INTO file_keys (record_id, encryption_key, iv) VALUES (?, ?, ?)')
                  .run(tempRecordId, encryptionKey.toString('hex'), iv.toString('hex'));
                
                // Delete the temporary file
                fs.unlinkSync(req.file.path);
            } catch (err) {
                console.error(`Failed to process file: ${err}`);
                if (req.file && fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path); // Clean up
                }
                throw new Error('Failed to process file upload');
            }
        }
        
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Create a transaction with the user ID in the transient data
            const transaction = contract.createTransaction('addMedicalRecord');
            
            // Set the userId in transient data to properly identify the doctor
            const doctorId = req.session.user.id;
            transaction.setTransient({
                userId: Buffer.from(doctorId)
            });
            
            // Add medical record on the blockchain
            const result = await transaction.submit(
                patientId, 
                diagnosisDate, 
                diagnosis, 
                treatment, 
                medications, 
                notes || '',
                fileData,
                fileName,
                fileType
            );
            
            // If there was a file, update the record ID in the database
            if (fileData && tempRecordId) {
                // Extract the record ID from the result
                const recordIdMatch = result.toString().match(/Medical record (REC_[^\s]+) added/);
                if (recordIdMatch && recordIdMatch[1]) {
                    const recordId = recordIdMatch[1];
                    console.log(`Updating encryption key record ID from ${tempRecordId} to ${recordId}`);
                    
                    // Update the record ID in the database
                    db.prepare('UPDATE file_keys SET record_id = ? WHERE record_id = ?')
                      .run(recordId, tempRecordId);
                } else {
                    console.error(`Could not extract record ID from result: ${result.toString()}`);
                }
            }
            
            // Redirect to the patient's records
            res.redirect(`/patient-records/${patientId}`);
        } catch (error) {
            console.error(`Failed to add medical record: ${error}`);
            
            // If there was a file upload that failed, clean up the database entry
            if (tempRecordId) {
                try {
                    db.prepare('DELETE FROM file_keys WHERE record_id = ?').run(tempRecordId);
                    console.log(`Removed temporary encryption key for ${tempRecordId}`);
                } catch (dbErr) {
                    console.error(`Failed to clean up temporary key: ${dbErr}`);
                }
            }
            
            // Get all patients for the dropdown
            let patients = [];
            try {
                const result = await contract.evaluateTransaction('listAllPatients');
                patients = JSON.parse(result.toString());
            } catch (err) {
                console.error(`Failed to get patients: ${err}`);
            }
            
            res.render('add-record', {
                title: 'Add Medical Record',
                user: req.session.user,
                patients: patients,
                patientId: patientId,
                error: error.message,
                success: null
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('add-record', {
            title: 'Add Medical Record',
            user: req.session.user,
            patients: [],
            patientId: req.body.patientId,
            error: 'Failed to process request',
            success: null
        });
    }
});

// Profile route
app.get('/profile', isAuthenticated, async (req, res) => {
    try {
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get user profile from blockchain
            const result = await contract.evaluateTransaction('getUserProfile', req.session.user.id);
            const profile = JSON.parse(result.toString());
            
            // Get user account from database
            const userAccount = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.user.id);
            
            res.render('profile', {
                title: 'User Profile',
                user: req.session.user,
                profile: profile,
                userAccount: userAccount,
                error: null,
                success: null
            });
        } catch (error) {
            console.error(`Failed to get profile: ${error}`);
            res.render('profile', {
                title: 'User Profile',
                user: req.session.user,
                profile: {
                    id: req.session.user.id,
                    role: req.session.user.role,
                    name: req.session.user.username,
                    createdAt: new Date().toISOString()
                },
                userAccount: {
                    username: req.session.user.username
                },
                error: error.message,
                success: null
            });
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.render('profile', {
            title: 'User Profile',
            user: req.session.user,
            profile: {
                id: req.session.user.id,
                role: req.session.user.role,
                name: req.session.user.username,
                createdAt: new Date().toISOString()
            },
            userAccount: {
                username: req.session.user.username
            },
            error: 'Failed to process request',
            success: null
        });
    }
});

// View User Profile route (for admin and doctors)
app.get('/user/:userId', isAuthenticated, async (req, res) => {
    const { userId } = req.params;
    
    // Only admin can view any user profile, doctors can only view patient profiles
    if (req.session.user.role !== 'admin' && 
        !(req.session.user.role === 'doctor' && userId.startsWith('PAT'))) {
        return res.status(403).send('Access denied');
    }
    
    try {
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get user profile from blockchain
            const result = await contract.evaluateTransaction('getUserProfile', userId);
            const profile = JSON.parse(result.toString());
            
            // Get user account from database
            const userAccount = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
            
            // Get medical records if it's a patient
            let medicalRecords = [];
            if (profile.role === 'patient') {
                const recordsResult = await contract.evaluateTransaction('getPatientMedicalRecords', userId);
                medicalRecords = JSON.parse(recordsResult.toString());
            }
            
            res.render('user-profile', {
                title: 'User Profile',
                user: req.session.user,
                profile: profile,
                userAccount: userAccount,
                medicalRecords: medicalRecords,
                error: null,
                success: null
            });
        } catch (error) {
            console.error(`Failed to get user profile: ${error}`);
            res.status(404).send('User not found');
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.status(500).send('Failed to process request');
    }
});

// Update password
app.post('/update-password', isAuthenticated, (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        // Validate that new passwords match
        if (newPassword !== confirmPassword) {
            return res.redirect('/profile?error=New passwords do not match');
        }
        
        // Get user from database
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
        
        // Verify current password
        if (!bcrypt.compareSync(currentPassword, user.password)) {
            return res.redirect('/profile?error=Current password is incorrect');
        }
        
        // Hash the new password
        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        
        // Update password in database
        db.prepare('UPDATE users SET password = ? WHERE id = ?')
            .run(hashedPassword, req.session.user.id);
        
        res.redirect('/profile?success=Password updated successfully');
    } catch (error) {
        console.error(`Failed to update password: ${error}`);
        res.redirect('/profile?error=Failed to update password');
    }
});

// Download Medical Record File
app.get('/download/:recordId', isAuthenticated, async (req, res) => {
    const { recordId } = req.params;
    
    try {
        // Connect to the blockchain
        const { gateway, contract } = await getContract(req.session.user.id);
        
        try {
            // Get the medical record from the blockchain
            const result = await contract.evaluateTransaction('getMedicalRecord', recordId);
            const record = JSON.parse(result.toString());
            
            // Check if the user is authorized to download this file
            const isAdmin = req.session.user.role === 'admin';
            const isPatientRecord = req.session.user.id === record.patientId;
            const isDoctorRecord = req.session.user.role === 'doctor' && req.session.user.id === record.doctorId;
            
            if (!isAdmin && !isPatientRecord && !isDoctorRecord) {
                return res.status(403).send('You are not authorized to download this file');
            }
            
            // Check if the record has a file
            if (!record.hasFile || !record.fileData) {
                return res.status(404).send('No file attached to this record');
            }
            
            // Get the encryption key from the database
            const fileKey = db.prepare('SELECT encryption_key, iv FROM file_keys WHERE record_id = ?').get(recordId);
            if (!fileKey) {
                console.error(`Encryption key not found for record ${recordId}`);
                // List all keys for debugging
                const allKeys = db.prepare('SELECT record_id FROM file_keys').all();
                console.log('Available keys:', allKeys.map(k => k.record_id));
                return res.status(404).send(`Encryption key not found for this file (Record ID: ${recordId})`);
            }
            
            // Convert to buffer
            const fileData = Buffer.from(record.fileData, 'base64');
            
            try {
                // Extract the IV from the database
                const iv = Buffer.from(fileKey.iv, 'hex');
                
                // Get the encryption key
                const key = Buffer.from(fileKey.encryption_key, 'hex');
                
                // The first 16 bytes of fileData should be the IV, but we'll use the one from the database
                const encryptedData = fileData.slice(16); // Skip IV
                
                // Decrypt the file
                const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                let decryptedData = decipher.update(encryptedData);
                decryptedData = Buffer.concat([decryptedData, decipher.final()]);
                
                // Create a temporary file
                const downloadsDir = path.join(__dirname, 'downloads');
                if (!fs.existsSync(downloadsDir)) {
                    fs.mkdirSync(downloadsDir, { recursive: true });
                }
                
                const tempFilePath = path.join(downloadsDir, `${recordId}_${record.fileName}`);
                fs.writeFileSync(tempFilePath, decryptedData);
                
                // Set headers for file download
                res.setHeader('Content-Disposition', `attachment; filename="${record.fileName}"`);
                res.setHeader('Content-Type', record.fileType || 'application/octet-stream');
                
                // Send the file
                res.download(tempFilePath, record.fileName, (err) => {
                    // Delete the temporary file after download
                    if (fs.existsSync(tempFilePath)) {
                        fs.unlinkSync(tempFilePath);
                    }
                    
                    if (err) {
                        console.error(`Failed to download file: ${err}`);
                        return res.status(500).send('Failed to download file');
                    }
                });
            } catch (decryptError) {
                console.error(`Failed to decrypt file: ${decryptError}`);
                return res.status(500).send(`Failed to decrypt file: ${decryptError.message}`);
            }
        } catch (error) {
            console.error(`Failed to get medical record: ${error}`);
            res.status(500).send(`Failed to get medical record: ${error.message}`);
        } finally {
            // Disconnect from the gateway
            gateway.disconnect();
        }
    } catch (error) {
        console.error(`Failed to process request: ${error}`);
        res.status(500).send(`Failed to process request: ${error.message}`);
    }
});

// Start the server (if not imported as a module)
if (require.main === module) {
    const host = process.env.HOST || '0.0.0.0';
    app.listen(port, host, () => {
        console.log(`Server running at http://${host}:${port}/`);
        console.log(`Access locally via: http://localhost:${port}/`);
        try {
            // Try to get the server IP address using the hostname command
            const { execSync } = require('child_process');
            const ipAddress = execSync('hostname -I | awk \'{print $1}\'').toString().trim();
            console.log(`Access via server IP: http://${ipAddress}:${port}/`);
        } catch (err) {
            console.log('Could not determine server IP address');
        }
    });
}

// Export the app for external use
module.exports = app; 