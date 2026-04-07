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

      for (const question of codingQuestions) {
        // Insert coding question
        const questionResult = await client.query(
          `INSERT INTO coding_questions 
           (test_id, title, description, time_limit, memory_limit, question_order, created_at, updated_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) 
           RETURNING id`,
          [
            testId,
            question.title || 'Untitled',
            question.description || '',
            question.timeLimit || 2,
            question.memoryLimit || 256,
            savedCount
          ]
        );

        const codingQuestionId = questionResult.rows[0].id;

        // Insert public test cases
        if (question.publicTestCases && question.publicTestCases.length > 0) {
          for (let i = 0; i < question.publicTestCases.length; i++) {
            const testCase = question.publicTestCases[i];
            await client.query(
              `INSERT INTO coding_test_cases 
               (coding_question_id, input, output, is_hidden, explanation, test_case_order) 
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                codingQuestionId,
                testCase.input || '',
                testCase.output || '',
                false,
                testCase.explanation || '',
                i
              ]
            );
          }
        }

        // Insert hidden test cases
        if (question.hiddenTestCases && question.hiddenTestCases.length > 0) {
          for (let i = 0; i < question.hiddenTestCases.length; i++) {
            const testCase = question.hiddenTestCases[i];
            await client.query(
              `INSERT INTO coding_test_cases 
               (coding_question_id, input, output, is_hidden, test_case_order) 
               VALUES ($1, $2, $3, $4, $5)`,
              [
                codingQuestionId,
                testCase.input || '',
                testCase.output || '',
                true,
                i
              ]
            );
          }
        }

        savedCount++;
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

      const questions = [];

      for (const question of questionsResult.rows) {
        // Get test cases for this question
        const testCasesResult = await pool.query(
          `SELECT input, output, is_hidden, explanation, test_case_order
           FROM coding_test_cases
           WHERE coding_question_id = $1
           ORDER BY test_case_order, id`,
          [question.id]
        );

        const publicTestCases = testCasesResult.rows
          .filter(tc => !tc.is_hidden)
          .map(tc => ({
            input: tc.input,
            output: tc.output,
            explanation: tc.explanation || ''
          }));

        const hiddenTestCases = testCasesResult.rows
          .filter(tc => tc.is_hidden)
          .map(tc => ({
            input: tc.input,
            output: tc.output
          }));

        questions.push({
          id: question.id,
          title: question.title,
          description: question.description,
          timeLimit: question.time_limit,
          memoryLimit: question.memory_limit,
          publicTestCases,
          hiddenTestCases
        });
      }

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