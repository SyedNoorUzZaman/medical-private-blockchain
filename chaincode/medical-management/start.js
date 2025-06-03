'use strict';

const { Chaincode, ChaincodeError } = require('fabric-shim');
const MedicalManagement = require('./index');

module.exports.MedicalManagement = MedicalManagement;
module.exports.contracts = [MedicalManagement]; 