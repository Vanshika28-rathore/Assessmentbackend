const { pool } = require('../config/db');

class CodingQuestionsController {
  // Save coding questions for a test
  async saveCodingQuestions(req, res) {
    const client = await pool.connect();
    
    try {
      const { testId } = req.params;
      const { codingQuestions } = req.body;
      
      console.log(`[CODING QUESTIONS] Saving ${codingQuestions?.length || 0} questions for test ${testId}`);
      
      if (!testId) {
        return res.status(400).json({
          success: false,
          message: 'Test ID is required'
        });
      }

      // Start transaction
      await client.query('BEGIN');

      // Delete existing coding questions for this test
      await client.query(
        'DELETE FROM coding_questions WHERE test_id = $1',
        [testId]
      );

      if (!codingQuestions || codingQuestions.length === 0) {
        await client.query('COMMIT');
        return res.json({
          success: true,
          message: 'Coding questions cleared successfully',
          saved: 0
        });
      }

      let savedCount = 0;

      if (codingQuestions.length > 0) {
        // Step 1: Batch insert all coding questions and get their IDs
        // We'll insert one by one inside the loop but return them? 
        // Actually, for multiple questions, we can use UNNEST or just a single multi-row INSERT if the data is clean.
        // But since we need the IDs to map test cases, and Postgres supports multi-row RETURNING, we can batch insert.
        
        const questionValues = codingQuestions.map((_, i) => 
          `($1, $${i*5+2}, $${i*5+3}, $${i*5+4}, $${i*5+5}, $${i*5+6}, NOW(), NOW())`
        ).join(', ');
        const questionParams = [testId];
        codingQuestions.forEach((q, i) => {
          questionParams.push(q.title || 'Untitled', q.description || '', q.timeLimit || 2, q.memoryLimit || 256, i);
        });

        const questionsResult = await client.query(
          `INSERT INTO coding_questions 
           (test_id, title, description, time_limit, memory_limit, question_order, created_at, updated_at) 
           VALUES ${questionValues} 
           RETURNING id`,
          questionParams
        );

        const questionIds = questionsResult.rows.map(r => r.id);
        const allTestCases = [];

        // Prepare test cases for batch insert
        codingQuestions.forEach((question, qIdx) => {
          const codingQuestionId = questionIds[qIdx];
          
          if (question.publicTestCases && question.publicTestCases.length > 0) {
            question.publicTestCases.forEach((tc, tcIdx) => {
              allTestCases.push({
                coding_question_id: codingQuestionId,
                input: tc.input || '',
                output: tc.output || '',
                is_hidden: false,
                explanation: tc.explanation || '',
                test_case_order: tcIdx
              });
            });
          }

          if (question.hiddenTestCases && question.hiddenTestCases.length > 0) {
            question.hiddenTestCases.forEach((tc, tcIdx) => {
              allTestCases.push({
                coding_question_id: codingQuestionId,
                input: tc.input || '',
                output: tc.output || '',
                is_hidden: true,
                explanation: '',
                test_case_order: tcIdx
              });
            });
          }
        });

        // Step 2: Batch insert all test cases in one query
        if (allTestCases.length > 0) {
          const tcValues = allTestCases.map((_, i) => 
            `($${i*6+1}, $${i*6+2}, $${i*6+3}, $${i*6+4}, $${i*6+5}, $${i*6+6})`
          ).join(', ');
          const tcParams = allTestCases.flatMap(tc => [
            tc.coding_question_id, tc.input, tc.output, tc.is_hidden, tc.explanation, tc.test_case_order
          ]);

          await client.query(
            `INSERT INTO coding_test_cases 
             (coding_question_id, input, output, is_hidden, explanation, test_case_order) 
             VALUES ${tcValues}`,
            tcParams
          );
        }

        savedCount = codingQuestions.length;
      }

      await client.query('COMMIT');

      console.log(`[CODING QUESTIONS] Successfully saved ${savedCount} questions for test ${testId}`);

      res.json({
        success: true,
        message: `Successfully saved ${savedCount} coding questions`,
        saved: savedCount
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[CODING QUESTIONS] Error saving questions:', error);
      
      res.status(500).json({
        success: false,
        message: 'Failed to save coding questions',
        error: error.message
      });
    } finally {
      client.release();
    }
  }

  // Get coding questions for a test
  async getCodingQuestions(req, res) {
    try {
      const { testId } = req.params;
      
      const questionsResult = await pool.query(
        `SELECT 
          cq.id,
          cq.title,
          cq.description,
          cq.time_limit,
          cq.memory_limit,
          cq.question_order
         FROM coding_questions cq
         WHERE cq.test_id = $1
         ORDER BY cq.question_order, cq.id`,
        [testId]
      );

      const questionIds = questionsResult.rows.map(q => q.id);
      let allTestCases = [];
      
      if (questionIds.length > 0) {
        // ✅ FIX: Fetch all test cases for ALL questions in a single query (O(1) SQL complexity)
        const testCasesResult = await pool.query(
          `SELECT coding_question_id, input, output, is_hidden, explanation, test_case_order
           FROM coding_test_cases
           WHERE coding_question_id = ANY($1)
           ORDER BY test_case_order, id`,
          [questionIds]
        );
        allTestCases = testCasesResult.rows;
      }

      const questions = questionsResult.rows.map(question => {
        const questionTestCases = allTestCases.filter(tc => tc.coding_question_id === question.id);
        
        const publicTestCases = questionTestCases
          .filter(tc => !tc.is_hidden)
          .map(tc => ({
            input: tc.input,
            output: tc.output,
            explanation: tc.explanation || ''
          }));

        const hiddenTestCases = questionTestCases
          .filter(tc => tc.is_hidden)
          .map(tc => ({
            input: tc.input,
            output: tc.output
          }));

        return {
          id: question.id,
          title: question.title,
          description: question.description,
          timeLimit: question.time_limit,
          memoryLimit: question.memory_limit,
          publicTestCases,
          hiddenTestCases
        };
      });

      res.json({
        success: true,
        questions
      });

    } catch (error) {
      console.error('[CODING QUESTIONS] Error fetching questions:', error);
      
      res.status(500).json({
        success: false,
        message: 'Failed to fetch coding questions',
        error: error.message
      });
    }
  }
}

const codingQuestionsController = new CodingQuestionsController();
module.exports = codingQuestionsController;