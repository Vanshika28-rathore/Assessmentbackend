const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');
const db = require('../config/db');

// PDF text extractor — pdf-parse@1.1.1 exports a simple async function
async function extractPdfText(buffer) {
    // Attempt 1: pdf-parse v1.1.1 (standard well-known package)
    try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        const text = data && data.text ? data.text.trim() : '';
        if (text.length > 20) {
            console.log('✅ PDF parsed via pdf-parse, chars:', text.length);
            return text;
        }
    } catch (e) {
        console.warn('pdf-parse failed:', e.message);
    }

    // Attempt 2: zlib decompress PDF FlateDecode streams (fallback)
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
                } catch (_) {}
            }
        }
        const plain = hex.match(/\(([^\)\\]{3,})\)/g) || [];
        plain.forEach(m => { allText += m.slice(1, -1) + ' '; });
        const cleaned = allText.replace(/\s+/g, ' ').trim();
        if (cleaned.length > 80) {
            console.log('✅ PDF extracted via zlib fallback, chars:', cleaned.length);
            return cleaned;
        }
    } catch (e) {
        console.warn('Zlib extraction failed:', e.message);
    }

    console.error('❌ All PDF extraction methods failed.');
    return null;
}

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL_NAME = 'llama3.2:1b'; // Lightweight, fits in 1.5GB RAM but extremely smart

// Removed In-memory session store. Backend is now 100% STATELESS and immune to server restarts!
// chatSessions map is no longer needed. History is managed by the client.

router.post('/upload-resume', upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No resume file uploaded' });
        }

        console.log('--- AI Interview: Parsing Resume ---');

        // Use robust extractor
        const rawText = await extractPdfText(req.file.buffer);

        if (!rawText || rawText.length < 30) {
            return res.status(400).json({
                success: false,
                message: 'Resume PDF se text extract nahi ho pa raha. Kripya ek text-based PDF upload karein (Word se export ki hui PDF best hoti hai).'
            });
        }

        // Clean up: remove control chars, collapse spaces
        const cleanText = rawText
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Take first 1000 chars — enough context, keeps AI fast
        const contextText = cleanText.substring(0, 1000);
        console.log('Resume extracted, length:', contextText.length, '| Preview:', contextText.substring(0, 100));

        // Tight, directive system prompt — forces resume-specific questions
        const systemPrompt = `You are a technical interviewer. Here is the candidate's resume:

"${contextText}"

RULES (strictly follow):
1. Ask ONE short simple technical question DIRECTLY based on something in this resume (skills, projects, technologies listed).
2. Never acknowledge answers — just ask the next question immediately.
3. Do NOT say "Good", "Great", "Nice answer". Just ask the next question.
4. Keep every question under 20 words.
5. Do NOT write "Interviewer:", scripts, or meta-text.`;

        const greeting = "Hello! I have read your resume. Let's begin the interview. Please say 'Ready' or press Enter to start.";

        res.json({
            success: true,
            systemPrompt: systemPrompt,
            message: greeting,
            resumeText: contextText
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

        console.log(`--- AI Interview: Received Answer ---`);

        // Use the full askedQuestions list from frontend (never trimmed, always complete)
        const askedFromFrontend = Array.isArray(req.body.askedQuestions) ? req.body.askedQuestions : [];

        // Fallback: also extract from current history in case frontend list is empty
        const askedFromHistory = messages
            .filter(m => m.role === 'assistant' && m.content)
            .map(m => {
                const match = m.content.match(/^[^?]*\?/);
                return match ? match[0].trim() : m.content.substring(0, 80).trim();
            })
            .filter(q => q.length > 5);

        // Merge both (deduplicated), frontend list takes priority
        const allAsked = [...new Set([...askedFromFrontend, ...askedFromHistory])];

        const avoidList = allAsked.length > 0
            ? `\nAlready asked (DO NOT repeat or rephrase): ${allAsked.map(q => `"${q.substring(0, 40)}"`).join(' | ')}`
            : '';

        // Extract resume keywords from system prompt (messages[0]) for reminder
        const systemContent = messages[0]?.content || '';
        const resumeMatch = systemContent.match(/"([^"]{30,})"/);
        const resumeHint = resumeMatch 
            ? `\nCandidate resume snippet: "${resumeMatch[1].substring(0, 200)}"`
            : '';

        console.log(`Preventing repetition of ${allAsked.length} questions.`);

        // Strict injection — ONE resume-specific question, never repeat
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
                num_predict: 40,
                num_ctx: 1536,      // Larger context — resume system prompt always visible
                temperature: 0.1,
                top_p: 0.1,
                repeat_penalty: 1.3,
                stop: ['?\n', '?\r']
            }
        });

        const reply = ollamaResponse.data.message;
        if (reply && reply.content) {
            // Step 1: clean tags and prefixes
            let cleaned = reply.content
                .replace(/<\|.*?\|>/g, '')
                .replace(/^(Interviewer:|AI Interviewer:|AI:|Q:|Question:|\d+\.)/i, '')
                .replace(/\[INSTRUCTION.*?\]/gi, '')
                .trim();

            // Step 2: Keep ONLY the first question (everything up to and including the first "?")
            const firstQMatch = cleaned.match(/^[^?]*\?/);
            if (firstQMatch) {
                cleaned = firstQMatch[0].trim();
            } else {
                // No "?" found — take only the first sentence
                const firstSentence = cleaned.split(/[.!\n]/)[0];
                cleaned = (firstSentence || cleaned).trim();
            }

            reply.content = cleaned;
        }
        console.log('Ollama reply (single Q):', reply?.content);

        // Clean history: remove injected instruction, keep clean answer
        messages.pop();
        messages.push({ role: 'user', content: answer });
        messages.push(reply);

        // Trim history to stay fast (keep last 8 messages + system prompt)
        let updatedHistory = messages;
        if (messages.length > 10) {
            updatedHistory = [messages[0], ...messages.slice(-8)];
        }

        res.json({
            success: true,
            message: reply.content,
            updatedHistory: updatedHistory
        });

    } catch (error) {
        console.error('AI Interview Chat Error:', error?.response?.data || error.message);
        res.status(500).json({ success: false, message: 'Failed to get AI response' });
    }
});

// ============================================
// SAVE interview result to DB
// ============================================
router.post('/save', async (req, res) => {
    try {
        const { studentId, studentName, resumeText, chatHistory, rating, feedbackComment } = req.body;

        if (!chatHistory) {
            return res.status(400).json({ success: false, message: 'Chat history missing.' });
        }

        const result = await db.query(
            `INSERT INTO ai_interviews 
             (student_id, student_name, resume_text, chat_history, rating, feedback_comment)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [studentId, studentName, resumeText, JSON.stringify(chatHistory), rating, feedbackComment]
        );

        console.log(`✅ AI Interview saved for student ${studentName}, id: ${result.rows[0].id}`);
        res.json({ success: true, id: result.rows[0].id });

    } catch (error) {
        console.error('AI Interview Save Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to save interview result.' });
    }
});

// ============================================
// GET all interview results (Admin only)
// ============================================
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

// GET single interview detail (Admin only)
router.get('/results/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query(
            `SELECT * FROM ai_interviews WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Interview not found.' });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('AI Interview Detail Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch interview detail.' });
    }
});

module.exports = router;
