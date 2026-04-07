/**
 * Execution Orchestrator
 * Routes code evaluation through Redis+Bull queue when available, else direct execution.
 * Use this instead of codeExecutionService.evaluateWithTestCases for scalable execution.
 */

import codeExecutionService from './codeExecution.service.js';

const REDIS_URL = process.env.REDIS_URL;
const REDIS_HOST = process.env.REDIS_HOST;
const useQueue = !!(REDIS_URL || REDIS_HOST);

let queue = null;
let initPromise = null;
let queueInitialized = false;
let queueFailed = false;

async function initQueue() {
  if (!useQueue) {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[ExecutionQueue] Redis not configured, using direct execution');
    }
    return;
  }
  
  if (queueFailed) return;
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
    try {
      const Bull = (await import('bull')).default;
      const redisConfig = REDIS_URL
        ? REDIS_URL
        : {
            host: REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT, 10) || 6379,
            password: process.env.REDIS_PASSWORD || undefined,
          };

      queue = new Bull('code-execution', {
        redis: redisConfig,
        defaultJobOptions: {
          timeout: 120000,
          attempts: 2,
          backoff: { type: 'exponential', delay: 3000 },
          removeOnComplete: 100,
        },
      });

      const concurrency = parseInt(process.env.CODE_EXEC_QUEUE_CONCURRENCY, 10) || 5;
      
      // Named processors for each job type
      queue.process('evaluate', concurrency, async (job) => {
        const { code, language, testCases } = job.data;
        return await codeExecutionService.evaluateWithTestCases(code, language, testCases);
      });

      queue.process('execute', concurrency, async (job) => {
        const { code, language, input } = job.data;
        return await codeExecutionService.executeCodeWithInput(code, language, input || '');
      });

      // Handle Redis connection errors gracefully
      queue.on('error', (err) => {
        console.error('[ExecutionQueue] Redis error:', err.message);
        queueFailed = true;
        queue = null;
      });

      queue.on('failed', (job, err) => {
        console.error(`[ExecutionQueue] Job ${job.id} failed:`, err.message);
      });

      // Test the connection
      await queue.isReady();
      queueInitialized = true;
      console.log('[ExecutionQueue] Queue active (concurrency:', concurrency, ')');
      
    } catch (err) {
      console.warn('[ExecutionQueue] Redis unavailable, using direct execution:', err.message);
      queueFailed = true;
      queue = null;
    }
  })();
  
  return initPromise;
}

/**
 * Evaluate code against test cases.
 * Uses Bull queue when Redis is configured and available, else direct execution.
 */
export async function evaluateWithTestCases(code, language, testCases) {
  try {
    await initQueue();
    
    if (queue && queueInitialized && !queueFailed) {
      const job = await queue.add('evaluate', { code, language, testCases });
      return await job.finished();
    }
  } catch (err) {
    console.warn('[ExecutionQueue] Queue execution failed, falling back to direct execution:', err.message);
    queueFailed = true;
    queue = null;
  }
  
  return await codeExecutionService.evaluateWithTestCases(code, language, testCases);
}

/**
 * Execute code with input (single run).
 * Uses Bull queue when Redis is configured and available, else direct execution.
 */
export async function executeCodeWithInput(code, language, input) {
  try {
    await initQueue();
    
    if (queue && queueInitialized && !queueFailed) {
      const job = await queue.add('execute', { code, language, input: input || '' });
      return await job.finished();
    }
  } catch (err) {
    console.warn('[ExecutionQueue] Queue execution failed, falling back to direct execution:', err.message);
    queueFailed = true;
    queue = null;
  }
  
  return await codeExecutionService.executeCodeWithInput(code, language, input);
}

export function isQueueActive() {
  return !!(queue && queueInitialized && !queueFailed);
}

export default {
  evaluateWithTestCases,
  executeCodeWithInput,
  isQueueActive,
};