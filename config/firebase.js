const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

// Check if Firebase is already initialized
if (!admin.apps.length) {
    try {
        // Option 1: Use environment variables (recommended for Render)
        if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                }),
            });
            console.log('✅ Firebase Admin SDK initialized with environment variables');
        }
        // Option 2: Use service account file (for local development)
        else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
            const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
            const absolutePath = path.resolve(__dirname, '..', serviceAccountPath);
            const serviceAccount = require(absolutePath);

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            console.log('✅ Firebase Admin SDK initialized with service account file');
        }
        else {
            // Graceful fallback - warn but don't crash the server
            console.warn('⚠️  Firebase credentials not configured properly');
            console.warn('   Authentication features will be limited');
            console.warn('   Please configure Firebase credentials in .env file or add serviceAccountKey.json');
            console.warn('   Server will continue to run for testing purposes...');
            
            // Initialize with minimal configuration to prevent crashes
            module.exports = {
                auth: () => ({
                    verifyIdToken: () => Promise.reject(new Error('Firebase not configured')),
                    createUser: () => Promise.reject(new Error('Firebase not configured')),
                    getUserByEmail: () => Promise.reject(new Error('Firebase not configured'))
                })
            };
            return;        }
    } catch (error) {
        console.warn('⚠️  Firebase initialization failed:', error.message);
        console.warn('   Authentication features will be limited');
        console.warn('   Server will continue to run for testing purposes...');
        
        // Initialize with minimal configuration to prevent crashes
        module.exports = {
            auth: () => ({
                verifyIdToken: () => Promise.reject(new Error('Firebase not configured')),
                createUser: () => Promise.reject(new Error('Firebase not configured')),
                getUserByEmail: () => Promise.reject(new Error('Firebase not configured'))
            })
        };
    return;
    }
}

// Export Firebase Admin instance
module.exports = admin;
