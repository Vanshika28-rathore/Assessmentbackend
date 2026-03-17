const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
// Create PostgreSQL connection pool
// Support both individual credentials and DATABASE_URL
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : {
        rejectUnauthorized: false,
      },
    }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT || 5432,
      ssl: process.env.DB_SSL === 'false' ? false : {
        rejectUnauthorized: false,
      },
    };

// Optimized pool settings for high concurrency
poolConfig.max = parseInt(process.env.DB_POOL_MAX) || 25; // Increased from 20
poolConfig.min = 5; // Increased from 2 to keep connections warm
poolConfig.idleTimeoutMillis = 30000; // Reduced from 60s to recycle faster
poolConfig.connectionTimeoutMillis = 8000; // Reduced from 10s for faster failures
poolConfig.allowExitOnIdle = false; // Keep pool alive
poolConfig.statement_timeout = 30000; // 30 second query timeout

const pool = new Pool(poolConfig);

// Test database connection and set timezone
pool.on('connect', (client) => {
  console.log('✅ Connected to PostgreSQL database');
  // Set session timezone to Asia/Kolkata for all connections
  client.query("SET timezone = 'Asia/Kolkata'");
  // Set session parameters for better performance
  client.query('SET statement_timeout = 30000'); // 30 second timeout
  client.query('SET idle_in_transaction_session_timeout = 60000'); // 60 second idle timeout
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
});

pool.on('remove', () => {
  console.log('🔄 Client removed from pool');
});

// Helper function to execute queries
const query = (text, params) => {
  return pool.query(text, params);
};

// Helper function to get a client from the pool (for transactions)
const getClient = () => {
  return pool.connect();
};

// Simple in-memory cache for frequently accessed data
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper function to get cached data or fetch from DB
const cachedQuery = async (cacheKey, queryText, params, ttl = CACHE_TTL) => {
  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ttl) {
    console.log(`📦 Cache HIT: ${cacheKey}`);
    return cached.data;
  }

  // Cache miss - fetch from database
  console.log(`🔍 Cache MISS: ${cacheKey}`);
  const result = await pool.query(queryText, params);
  
  // Store in cache
  cache.set(cacheKey, {
    data: result,
    timestamp: Date.now()
  });

  return result;
};

// Clear cache for specific key or pattern
const clearCache = (keyPattern) => {
  if (keyPattern) {
    // Clear specific keys matching pattern
    for (const key of cache.keys()) {
      if (key.includes(keyPattern)) {
        cache.delete(key);
      }
    }
  } else {
    // Clear all cache
    cache.clear();
  }
  console.log(`🗑️ Cache cleared: ${keyPattern || 'all'}`);
};

// Periodic cache cleanup (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
  console.log(`🧹 Cache cleanup: ${cache.size} entries remaining`);
}, 10 * 60 * 1000);

module.exports = {
  pool,
  query,
  getClient,
  cachedQuery,
  clearCache,
};

