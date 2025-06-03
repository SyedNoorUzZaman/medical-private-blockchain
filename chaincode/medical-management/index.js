'use strict';

const { Contract } = require('fabric-contract-api');

class MedicalManagement extends Contract {

    // Initialize the ledger with admin
    async initLedger(ctx) {
        console.info('============= Initialize Ledger ===========');
        
        try {
            // Check if admin already exists
            const adminAsBytes = await ctx.stub.getState('admin');
            if (adminAsBytes && adminAsBytes.length > 0) {
                console.info('Admin already exists, skipping creation');
            } else {
                // Get transaction timestamp from the context
                const txTimestamp = ctx.stub.getTxTimestamp();
                const timestamp = new Date(txTimestamp.seconds.low * 1000).toISOString();
                
                // Create admin user
                const admin = {
                    docType: 'user',
                    id: 'admin',
                    role: 'admin',
                    name: 'System Administrator',
                    createdAt: timestamp,
                };
                
                await ctx.stub.putState('admin', Buffer.from(JSON.stringify(admin)));
                console.info('Added admin to world state');
            }
            
            return 'Ledger initialized successfully';
        } catch (error) {
            console.error(`Error initializing ledger: ${error}`);
            throw new Error(`Failed to initialize ledger: ${error.message}`);
        }
    }

    // Helper function to check if caller has admin role
    async isAdmin(ctx) {
        try {
            // Special case: For direct CLI invocations (like during network initialization or testing),
            // accept operations from peer admin identities
            const mspID = ctx.clientIdentity.getMSPID();
            if (mspID === 'Org1MSP' || mspID === 'Org2MSP') {
                // Get the function name from the arguments
                const args = ctx.stub.getArgs();
                if (args.length > 0) {
                    const fcn = args[0].toString('utf8');
                    // These functions should be allowed from CLI for initialization
                    if (fcn === 'initLedger' || fcn === 'createDoctor') {
                        console.log(`Admin operation '${fcn}' via CLI detected from ${mspID} - authorizing`);
                        return true;
                    }
                }
            }
            
            // Normal application flow - check for admin user
            const clientID = await this._getClientID(ctx);
            
            // Special handling for 'admin' identifier directly
            if (clientID === 'admin') {
                return true;
            }
            
            const clientAsBytes = await ctx.stub.getState(clientID);
            if (!clientAsBytes || clientAsBytes.length === 0) {
                // During initialization, admin record might not exist yet
                const args = ctx.stub.getArgs();
                if (args.length > 0 && args[0].toString('utf8') === 'initLedger') {
                    return true;
                }
                console.log(`User ${clientID} does not exist`);
                return false;
            }
            
            const client = JSON.parse(clientAsBytes.toString());
            return client.role === 'admin';
        } catch (error) {
            console.error(`Error checking admin role: ${error}`);
            // Special handling for initialization to prevent bootstrapping issues
            const args = ctx.stub.getArgs();
            if (args.length > 0 && args[0].toString('utf8') === 'initLedger') {
                return true;
            }
            return false;
        }
    }

    // Helper function to check if caller has doctor role
    async isDoctor(ctx) {
        try {
            const clientID = await this._getClientID(ctx);
            const clientAsBytes = await ctx.stub.getState(clientID);
            if (!clientAsBytes || clientAsBytes.length === 0) {
                throw new Error(`User ${clientID} does not exist`);
            }
            
            const client = JSON.parse(clientAsBytes.toString());
            return client.role === 'doctor';
        } catch (error) {
            console.error(`Error checking doctor role: ${error}`);
            return false;
        }
    }

    // Helper function to get client ID from certificate
    async _getClientID(ctx) {
        try {
            // Get the user ID from the client identity
            const clientID = ctx.clientIdentity.getID();
            
            // Extract the user ID from the X.509 certificate
            // The format is typically: x509::/OU=client/CN=<username>::/C=US/ST=North Carolina/L=Durham/O=org1.example.com/CN=ca.org1.example.com
            const idString = clientID.toString();
            
            // Check if we're using the identity from the wallet
            if (idString.includes('user1') || idString.includes('admin')) {
                // For queries initiated by the website using identities from wallet
                // Return the real user ID that was passed from the UI
                const creator = ctx.stub.getCreator();
                const mspid = creator.mspid;
                
                // Get submitting client identity
                const invokeId = ctx.stub.getTransient().get('userId');
                if (invokeId) {
                    // If a userId was explicitly passed as a transient, use it
                    return invokeId.toString('utf8');
                }
                
                // Check creator ID attributes
                const attrs = ctx.clientIdentity.getAttributeValue('id');
                if (attrs) {
                    return attrs;
                }
                
                // Fall back to using the ID from the request body if present
                // This allows us to determine who's making the call from the application
                const args = ctx.stub.getArgs();
                if (args.length > 0 && ctx.stub.getFunction() === 'addMedicalRecord') {
                    // The doctorId parameter (first function parameter is function name, second is doctorId)
                    return ctx.stub.getCreator().id || args[0];
                }
            }
            
            // Default: extract the CN from the distinguished name
            const startIndex = idString.indexOf('CN=') + 3;
            const endIndex = idString.indexOf(':', startIndex);
            if (startIndex > 3 && endIndex > startIndex) {
                return idString.substring(startIndex, endIndex);
            }
            
            // If we couldn't parse the certificate, use the session user's ID
            // This ensures permissions will still work from the UI
            return ctx.stub.getCreator().id || ctx.clientIdentity.getID() || "admin";
        } catch (error) {
            console.error(`Error getting client ID: ${error}`);
            // For backward compatibility, default to admin
            return "admin";
        }
    }

    // Admin creates a new doctor
    async createDoctor(ctx, doctorId, name, specialization, contact) {
        try {
            const isAdmin = await this.isAdmin(ctx);
            if (!isAdmin) {
                throw new Error('Only admin can create doctors');
            }

            const doctorExists = await ctx.stub.getState(doctorId);
            if (doctorExists && doctorExists.length > 0) {
                throw new Error(`Doctor with ID ${doctorId} already exists`);
            }

            // Get transaction timestamp from the context
            const txTimestamp = ctx.stub.getTxTimestamp();
            const timestamp = new Date(txTimestamp.seconds.low * 1000).toISOString();

            const doctor = {
                docType: 'user',
                id: doctorId,
                role: 'doctor',
                name: name,
                specialization: specialization,
                contact: contact,
                createdAt: timestamp,
            };

            await ctx.stub.putState(doctorId, Buffer.from(JSON.stringify(doctor)));
            return `Doctor ${doctorId} has been created successfully`;
        } catch (error) {
            console.error(`Error creating doctor: ${error}`);
            throw error;
        }
    }

    // Admin creates a new patient
    async createPatient(ctx, patientId, name, dateOfBirth, contact, address, doctorId) {
        try {
            const isAdmin = await this.isAdmin(ctx);
            if (!isAdmin) {
                throw new Error('Only admin can create patients');
            }

            const patientExists = await ctx.stub.getState(patientId);
            if (patientExists && patientExists.length > 0) {
                throw new Error(`Patient with ID ${patientId} already exists`);
            }

            // Verify if the doctor exists
            if (doctorId) {
                const doctorExists = await ctx.stub.getState(doctorId);
                if (!doctorExists || doctorExists.length === 0) {
                    throw new Error(`Doctor with ID ${doctorId} does not exist`);
                }
            }

            // Get transaction timestamp from the context
            const txTimestamp = ctx.stub.getTxTimestamp();
            const timestamp = new Date(txTimestamp.seconds.low * 1000).toISOString();

            const patient = {
                docType: 'user',
                id: patientId,
                role: 'patient',
                name: name,
                dateOfBirth: dateOfBirth,
                contact: contact,
                address: address,
                doctorId: doctorId, // Store the associated doctor ID
                createdAt: timestamp,
                medicalRecords: [],
            };

            await ctx.stub.putState(patientId, Buffer.from(JSON.stringify(patient)));
            return `Patient ${patientId} has been created successfully`;
        } catch (error) {
            console.error(`Error creating patient: ${error}`);
            throw error;
        }
    }

    // Doctor adds medical data for a patient
    async addMedicalRecord(ctx, patientId, diagnosisDate, diagnosis, treatment, medications, notes, fileData, fileName, fileType) {
        try {
            const isDoctor = await this.isDoctor(ctx);
            if (!isDoctor) {
                throw new Error('Only doctors can add medical records');
            }

            const doctorId = await this._getClientID(ctx);

            // Check if patient exists
            const patientAsBytes = await ctx.stub.getState(patientId);
            if (!patientAsBytes || patientAsBytes.length === 0) {
                throw new Error(`Patient ${patientId} does not exist`);
            }

            const patient = JSON.parse(patientAsBytes.toString());
            
            // Check if this doctor is assigned to this patient
            if (!patient.doctorId) {
                throw new Error(`This patient doesn't have an assigned doctor. Please contact an administrator.`);
            }
            
            if (patient.doctorId !== doctorId) {
                throw new Error(`You are not authorized to add records for this patient. The patient is assigned to doctor ${patient.doctorId}.`);
            }
            
            // Get transaction timestamp and use it for both ID and timestamp
            const txTimestamp = ctx.stub.getTxTimestamp();
            const timestamp = new Date(txTimestamp.seconds.low * 1000).toISOString();
            const recordId = `REC_${patientId}_${txTimestamp.seconds.low}`;
            
            const medicalRecord = {
                id: recordId,
                doctorId: doctorId,
                patientId: patientId,
                diagnosisDate: diagnosisDate,
                diagnosis: diagnosis,
                treatment: treatment,
                medications: medications,
                notes: notes,
                timestamp: timestamp,
            };
            
            // Add file data if provided
            if (fileData && fileName) {
                medicalRecord.hasFile = true;
                medicalRecord.fileName = fileName;
                medicalRecord.fileType = fileType || 'application/octet-stream';
                medicalRecord.fileData = fileData; // This should be encrypted data
            } else {
                medicalRecord.hasFile = false;
            }
            
            // Store the medical record separately
            await ctx.stub.putState(recordId, Buffer.from(JSON.stringify(medicalRecord)));
            
            // Add the record ID to the patient's list of records
            if (!patient.medicalRecords) {
                patient.medicalRecords = [];
            }
            patient.medicalRecords.push(recordId);
            
            // Update the patient record
            await ctx.stub.putState(patientId, Buffer.from(JSON.stringify(patient)));
            
            return `Medical record ${recordId} added for patient ${patientId}`;
        } catch (error) {
            console.error(`Error adding medical record: ${error}`);
            throw error;
        }
    }

    // Get medical record
    async getMedicalRecord(ctx, recordId) {
        try {
            const recordAsBytes = await ctx.stub.getState(recordId);
            if (!recordAsBytes || recordAsBytes.length === 0) {
                throw new Error(`Medical record ${recordId} does not exist`);
            }
            
            return recordAsBytes.toString();
        } catch (error) {
            console.error(`Error getting medical record: ${error}`);
            throw error;
        }
    }

    // Get patient medical records
    async getPatientMedicalRecords(ctx, patientId) {
        try {
            // Get the patient data
            const patientAsBytes = await ctx.stub.getState(patientId);
            if (!patientAsBytes || patientAsBytes.length === 0) {
                throw new Error(`Patient ${patientId} does not exist`);
            }
            
            const patient = JSON.parse(patientAsBytes.toString());
            
            // Get all medical records for this patient
            const records = [];
            if (patient.medicalRecords && patient.medicalRecords.length > 0) {
                for (const recordId of patient.medicalRecords) {
                    const recordAsBytes = await ctx.stub.getState(recordId);
                    if (recordAsBytes && recordAsBytes.length > 0) {
                        records.push(JSON.parse(recordAsBytes.toString()));
                    }
                }
            }
            
            return JSON.stringify(records);
        } catch (error) {
            console.error(`Error getting patient medical records: ${error}`);
            throw error;
        }
    }

    // List all patients
    async listAllPatients(ctx) {
        try {
            const startKey = '';
            const endKey = '';
            const allResults = [];
            
            const iterator = await ctx.stub.getStateByRange(startKey, endKey);
            let result = await iterator.next();
            
            // Get the current user's ID and role
            const userId = await this._getClientID(ctx);
            const isAdmin = await this.isAdmin(ctx);
            const isDoctor = await this.isDoctor(ctx);
            
            while (!result.done) {
                if (result.value && result.value.value.toString()) {
                    let jsonRes;
                    try {
                        jsonRes = JSON.parse(result.value.value.toString('utf8'));
                    } catch (err) {
                        console.log(err);
                        jsonRes = result.value.value.toString('utf8');
                    }
                    
                    if (jsonRes.docType === 'user' && jsonRes.role === 'patient') {
                        // If admin, show all patients
                        // If doctor, only show patients assigned to this doctor
                        if (isAdmin || (isDoctor && jsonRes.doctorId === userId)) {
                            allResults.push(jsonRes);
                        }
                    }
                }
                result = await iterator.next();
            }
            await iterator.close();
            
            return JSON.stringify(allResults);
        } catch (error) {
            console.error(`Error listing patients: ${error}`);
            throw error;
        }
    }

    // List all doctors (admin only or CLI)
    async listAllDoctors(ctx) {
        try {
            // Allow access from CLI for testing
            const mspID = ctx.clientIdentity.getMSPID();
            const args = ctx.stub.getArgs();
            const isCLI = (mspID === 'Org1MSP' || mspID === 'Org2MSP') && 
                         args.length > 0 && args[0].toString('utf8') === 'listAllDoctors';
            
            const isAdmin = await this.isAdmin(ctx);
            if (!isAdmin && !isCLI) {
                throw new Error('Only admin can list all doctors');
            }

            const startKey = '';
            const endKey = '';
            const allResults = [];
            
            const iterator = await ctx.stub.getStateByRange(startKey, endKey);
            let result = await iterator.next();
            
            while (!result.done) {
                const strValue = Buffer.from(result.value.value.toString()).toString('utf8');
                let record;
                try {
                    record = JSON.parse(strValue);
                } catch (err) {
                    console.log(err);
                    record = strValue;
                }
                
                if (record.docType === 'user' && record.role === 'doctor') {
                    allResults.push(record);
                }
                result = await iterator.next();
            }
            
            return JSON.stringify(allResults);
        } catch (error) {
            console.error(`Error listing all doctors: ${error}`);
            throw error;
        }
    }

    // Get user profile
    async getUserProfile(ctx, userId) {
        try {
            const userAsBytes = await ctx.stub.getState(userId);
            if (!userAsBytes || userAsBytes.length === 0) {
                throw new Error(`User ${userId} does not exist`);
            }
            
            return userAsBytes.toString();
        } catch (error) {
            console.error(`Error getting user profile: ${error}`);
            throw error;
        }
    }
}

module.exports = MedicalManagement; 