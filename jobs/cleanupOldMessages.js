const { pool } = require('../config/db');
const { logger } = require('../config/logger');

/**
 * Cleanup old student messages and feedback older than 15 days
 * This job should run daily
 */
async function cleanupOldMessages() {
  const client = await pool.connect();
  
  try {
    logger.info({ event: 'cleanup_old_messages_start' }, 'Starting cleanup of old messages');

    // Delete messages older than 15 days
    const deleteResult = await client.query(`
      DELETE FROM student_messages
      WHERE created_at < NOW() - INTERVAL '15 days'
      RETURNING id, student_id, image_path
    `);

    const deletedCount = deleteResult.rowCount;
    const deletedRows = deleteResult.rows;

    // Delete associated images
    const fs = require('fs');
    const path = require('path');
    let deletedImagesCount = 0;

    for (const row of deletedRows) {
      if (!row.image_path) continue;

      const fullPath = path.join(__dirname, '..', row.image_path);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
          deletedImagesCount++;
        } catch (fileErr) {
          logger.warn({
            err: fileErr,
            event: 'cleanup_image_delete_failed',
            messageId: row.id,
            imagePath: row.image_path
          });
        }
      }
    }

    logger.info({
      event: 'cleanup_old_messages_complete',
      deletedMessages: deletedCount,
      deletedImages: deletedImagesCount
    }, `Cleanup complete: ${deletedCount} messages and ${deletedImagesCount} images deleted`);

    return {
      success: true,
      deletedMessages: deletedCount,
      deletedImages: deletedImagesCount
    };

  } catch (error) {
    logger.error({ err: error, event: 'cleanup_old_messages_error' }, 'Error during cleanup');
    throw error;
  } finally {
    client.release();
  }
}

// If run directly (not imported)
if (require.main === module) {
  cleanupOldMessages()
    .then(result => {
      console.log('✅ Cleanup completed:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Cleanup failed:', error);
      process.exit(1);
    });
}

module.exports = cleanupOldMessages;
