const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');
const db = require('../config/db');

const PDF_OPERATOR_PATTERN = /\b(BT|ET|BDC|EMC|Tf|Tm|Td|TJ|Tj|Do|cm|q|Q|re|w|J|j|d|RG|rg|K|k|gs|m|l|c|h|S|s|f|F|B|b|n|W|BI|ID|EI|obj|endobj|stream|endstream|xref|trailer|startxref)\b/g;

const sanitizeResumeText = (input = '') => {
    return input
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/\/MCID\s*\d+/gi, ' ')
        .replace(/\/F\d+/gi, ' ')
        .replace(/<</g, ' ')
        .replace(/>>/g, ' ')
        .replace(PDF_OPERATOR_PATTERN, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const isLowQualityResumeText = (text = '') => {
    const tokenized = text.split(/\s+/).filter(Boolean);
    if (tokenized.length < 30) return true;

    const alphaWords = tokenized.filter((token) => /[A-Za-z]{3,}/.test(token)).length;
    const operatorHits = (text.match(PDF_OPERATOR_PATTERN) || []).length;
    const operatorRatio = operatorHits / Math.max(1, tokenized.length);
    const alphaRatio = alphaWords / Math.max(1, tokenized.length);

    return alphaRatio < 0.45 || operatorRatio > 0.08;
};

const buildAutoFeedback = (chatHistory = []) => {
    const userAnswers = chatHistory.filter((m) => m && m.role === 'user' && String(m.content || '').trim().length > 0);
    const aiQuestions = chatHistory.filter((m) => m && m.role === 'assistant' && /\?/.test(String(m.content || '')));
    const avgAnswerLength = userAnswers.length
        ? userAnswers.reduce((sum, m) => sum + String(m.content || '').trim().length, 0) / userAnswers.length
        : 0;

    let rating = 2;
    if (userAnswers.length >= 8 && avgAnswerLength >= 45) rating = 5;
    else if (userAnswers.length >= 6 && avgAnswerLength >= 32) rating = 4;
    else if (userAnswers.length >= 4 && avgAnswerLength >= 22) rating = 3;

    const feedbackComment =
        rating >= 5
            ? 'Strong interview engagement with clear, sufficiently detailed responses.'
            : rating >= 4
                ? 'Good participation and mostly relevant responses across the interview.'
                : rating >= 3
                    ? 'Moderate performance. Answers were brief in places; improve depth and clarity.'
                    : 'Limited response depth. Encourage more complete and structured answers.';

    const hasConversation = userAnswers.length > 0 && aiQuestions.length > 0;
    return {
        rating: hasConversation ? rating : null,
        feedbackComment: hasConversation ? feedbackComment : null
    };
};

// PDF text extractor with robust fallbacks.
async function extractPdfText(buffer) {
    // Attempt 1: pdf-parse v1.1.1
    try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        const text = data && data.text ? sanitizeResumeText(data.text) : '';
        if (text.length > 60 && !isLowQualityResumeText(text)) {
            console.log('PDF parsed via pdf-parse, chars:', text.length);
            return text;
        }
    } catch (e) {
        console.warn('pdf-parse failed:', e.message);
    }

    // Attempt 2: zlib-decompress FlateDecode streams.
    try {
        const zlib = require('zlib');
        const { promisify } = require('util');
        const inflate = promisify(zlib.inflate);
        const inflateRaw = promisify(zlib.inflateRaw);
        const hex = buffer.toString('binary');
        const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        let match;
        let allText = '';

        while ((match = streamRegex.exec(hex)) !== null) {
            const raw = Buffer.from(match[1], 'binary');
            for (const decompress of [inflate, inflateRaw]) {
                try {
                    const out = await decompress(raw);
                    const readable = out.toString('utf8').match(/[\x20-\x7E\n]{3,}/g) || [];
                    allText += readable.join(' ') + ' ';
                    break;
                } catch (_) {
                    // Ignore and try next strategy.
                }
            }
        }

        const plain = hex.match(/\(([^\)\\]{3,})\)/g) || [];
        plain.forEach((m) => {
            allText += `${m.slice(1, -1)} `;
        });

        const cleaned = sanitizeResumeText(allText);
        if (cleaned.length > 120 && !isLowQualityResumeText(cleaned)) {
            console.log('PDF extracted via zlib fallback, chars:', cleaned.length);
            return cleaned;
        }
    } catch (e) {
        console.warn('Zlib extraction failed:', e.message);
    }

    console.error('All PDF extraction methods failed.');
    return null;
}

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL_NAME = 'llama3.2:1b';

router.post('/upload-resume', upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No resume file uploaded' });
        }

        console.log('--- AI Interview: Parsing Resume ---');

        const rawText = await extractPdfText(req.file.buffer);
        if (!rawText || rawText.length < 30) {
            return res.status(400).json({
                success: false,
                message: 'Resume PDF se text extract nahi ho pa raha. Kripya ek text-based PDF upload karein (Word se export ki hui PDF best hoti hai).'
            });
        }

        const cleanText = sanitizeResumeText(rawText);
        if (isLowQualityResumeText(cleanText)) {
            return res.status(400).json({
                success: false,
                message: 'Resume text extraction quality is low. Please upload a clean text-based PDF resume.'
            });
        }

        const contextText = cleanText.substring(0, 1500);
        const resumeTextForStorage = cleanText.substring(0, 6000);
        console.log('Resume extracted, length:', contextText.length, '| Preview:', contextText.substring(0, 100));

        const systemPrompt = `You are a technical interviewer. Here is the candidate's resume:

"${contextText}"

RULES (strictly follow):
1. Ask ONE short simple technical question DIRECTLY based on something in this resume (skills, projects, technologies listed).
2. Never acknowledge answers - just ask the next question immediately.
3. Do NOT say "Good", "Great", "Nice answer". Just ask the next question.
4. Keep every question under 20 words.
5. Do NOT write "Interviewer:", scripts, or meta-text.`;

        const greeting = "Hello! I have read your resume. Let's begin the interview. Please say 'Ready' or press Enter to start.";

        res.json({
            success: true,
            systemPrompt: systemPrompt,
            message: greeting,
            resumeText: resumeTextForStorage
        });

    } catch (error) {
        console.error('AI Interview Upload Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to process resume', error: error.message });
    }
});

router.post('/chat', async (req, res) => {
    try {
        const { messages, answer } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, message: 'Message history missing. Please restart the interview.' });
        }
        if (!answer) {
            return res.status(400).json({ success: false, message: 'Answer missing' });
        }

        console.log('--- AI Interview: Received Answer ---');

        const askedFromFrontend = Array.isArray(req.body.askedQuestions) ? req.body.askedQuestions : [];
        const askedFromHistory = messages
            .filter((m) => m.role === 'assistant' && m.content)
            .map((m) => {
                const match = m.content.match(/^[^?]*\?/);
                return match ? match[0].trim() : m.content.substring(0, 80).trim();
            })
            .filter((q) => q.length > 5);

        const allAsked = [...new Set([...askedFromFrontend, ...askedFromHistory])];

        const avoidList = allAsked.length > 0
            ? `\nAlready asked (DO NOT repeat or rephrase): ${allAsked.map((q) => `"${q.substring(0, 40)}"`).join(' | ')}`
            : '';

        const systemContent = messages[0]?.content || '';
        const resumeMatch = systemContent.match(/"([^"]{30,})"/);
        const resumeHint = resumeMatch
            ? `\nCandidate resume snippet: "${resumeMatch[1].substring(0, 200)}"`
            : '';

        console.log(`Preventing repetition of ${allAsked.length} questions.`);

        messages.push({
            role: 'user',
            content: `${answer}\n\n[INSTRUCTION: Ask ONE new short technical question specifically about a skill, project, or technology mentioned in the candidate's resume. End with "?". Do not say anything else.${resumeHint}${avoidList}]`
        });

        console.log('Sending to Ollama...');

        const ollamaResponse = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME,
            messages: messages,
            stream: false,
            options: {
                num_predict: 28,
                num_ctx: 1536,
                temperature: 0.1,
                top_p: 0.1,
                repeat_penalty: 1.3,
                stop: ['?\n', '?\r']
            }
        }, {
            timeout: 25000
        });

        const reply = ollamaResponse.data.message;
        if (reply && reply.content) {
            let cleaned = reply.content
                .replace(/<\|.*?\|>/g, '')
                .replace(/^(Interviewer:|AI Interviewer:|AI:|Q:|Question:|\d+\.)/i, '')
                .replace(/\[INSTRUCTION.*?\]/gi, '')
                .trim();

            const firstQMatch = cleaned.match(/^[^?]*\?/);
            if (firstQMatch) {
                cleaned = firstQMatch[0].trim();
            } else {
                const firstSentence = cleaned.split(/[.!\n]/)[0];
                cleaned = (firstSentence || cleaned).trim();
            }

            reply.content = cleaned;
        }

        console.log('Ollama reply (single Q):', reply?.content);

        messages.pop();
        messages.push({ role: 'user', content: answer });
        messages.push(reply);

        res.json({
            success: true,
            message: reply.content,
            updatedHistory: messages
        });

    } catch (error) {
        console.error('AI Interview Chat Error:', error.message);
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({ success: false, message: 'AI response timed out. Please try again.' });
        }
        res.status(500).json({ success: false, message: 'Failed to get AI response' });
    }
});

// Save interview result to DB.
router.post('/save', async (req, res) => {
    try {
        const { studentId, studentName, resumeText, chatHistory, rating, feedbackComment } = req.body;

        if (!chatHistory) {
            return res.status(400).json({ success: false, message: 'Chat history missing.' });
        }

        const normalizedChatHistory = Array.isArray(chatHistory) ? chatHistory : [];
        const normalizedStudentName = (studentName || '').trim() || 'Anonymous';

        const fallback = buildAutoFeedback(normalizedChatHistory);
        const normalizedRating = Number.isInteger(rating) ? rating : fallback.rating;
        const normalizedFeedbackComment = typeof feedbackComment === 'string' && feedbackComment.trim().length > 0
            ? feedbackComment.trim()
            : fallback.feedbackComment;

        const result = await db.query(
            `INSERT INTO ai_interviews
             (student_id, student_name, resume_text, chat_history, rating, feedback_comment)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [studentId || null, normalizedStudentName, resumeText || null, JSON.stringify(normalizedChatHistory), normalizedRating, normalizedFeedbackComment]
        );

        console.log(`AI Interview saved for student ${normalizedStudentName}, id: ${result.rows[0].id}`);
        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        console.error('AI Interview Save Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to save interview result.' });
    }
});

// Get all interview results for admin.
router.get('/results', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, student_id, student_name, rating, feedback_comment, created_at
             FROM ai_interviews
             ORDER BY created_at DESC`
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('AI Interview Results Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch results.' });
    }
});

// Get single interview detail for admin.
router.get('/results/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(
            'SELECT * FROM ai_interviews WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Interview not found.' });
        }

        const interview = result.rows[0];
        if (typeof interview.chat_history === 'string') {
            try {
                interview.chat_history = JSON.parse(interview.chat_history);
            } catch (_) {
                interview.chat_history = [];
            }
        } else if (!Array.isArray(interview.chat_history)) {
            interview.chat_history = [];
        }

        res.json({ success: true, data: interview });
    } catch (error) {
        console.error('AI Interview Detail Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch interview detail.' });
    }
});

module.exports = router;