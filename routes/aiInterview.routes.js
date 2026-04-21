const express = require('express');
const router = express.Router();
const multer = require('multer');
// pdf-parse v2.x compatibility: handle both default export styles
const pdfParseModule = require('pdf-parse');
const pdfParse = typeof pdfParseModule === 'function' ? pdfParseModule : (typeof pdfParseModule.default === 'function' ? pdfParseModule.default : null);
const axios = require('axios');
// Aap agar is route par authentication lagana chahein to verifyToken use kar sakte hain
// const verifyToken = require('../middleware/verifyToken');

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

        console.log('--- AI Interview: Starting Upload ---');
        let resumeText = '';

        // Try extracting PDF text
        try {
            if (!pdfParse) {
                // Fallback: if pdf-parse module couldn't load properly, try raw text extraction
                console.warn('pdf-parse not available as function, using raw buffer text');
                resumeText = req.file.buffer.toString('utf-8');
            } else {
                const data = await pdfParse(req.file.buffer);
                resumeText = data.text;
            }
        } catch (pdfErr) {
            console.error('Error parsing PDF:', pdfErr);
            return res.status(400).json({ success: false, message: 'Aapne jo file upload ki hai wo PDF nahi hai, ya parse nahi ho pa rahi.' });
        }

        // Limit resume text heavily to ensure very fast first-response (Llama won't stall reading it)
        const contextText = resumeText.substring(0, 800);

        const systemPrompt = `You are a friendly, basic technical interviewer for a BEGINNER.
Candidate's Resume extract: "${contextText}"

RULES:
1. Speak naturally. Do NOT write transcripts or "Interviewer:".
2. Ask EXTREMELY SIMPLE, short, basic questions about the skills mentioned in the resume. 
3. Stop after exactly ONE question.`;

        // Hardcoded instant greeting to bypass AI processing time during upload
        const greeting = "Hello! I am your AI interviewer. I have successfully analyzed your resume. Please type or say 'Yes' when you are ready for your first question.";

        // Send prompt back to client so client manages the state
        res.json({
            success: true,
            systemPrompt: systemPrompt,
            message: greeting
        });

    } catch (error) {
        console.error('AI Interview Upload Error:', error?.response?.data || error.message);
        res.status(500).json({ success: false, message: 'Failed to process resume or connect to Ollama', error: error.message });
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
        
        // Append user's answer ALONG WITH the reminder to the AI
        messages.push({ 
            role: 'user', 
            content: `Candidate's answer: "${answer}"\n\n(Interviewer Note: Acknowledge this answer briefly, then proceed to the next simple technical question based on their skills. Keep it friendly and beginner-level. Do NOT write a script.)` 
        });

        console.log('Sending chat context to Ollama...');
        const ollamaResponse = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME,
            messages: messages,
            stream: false,
            options: {
                num_predict: 60, // Very short for speed
                num_ctx: 1024,
                temperature: 0.3,
                top_p: 0.2
            }
        });

        const reply = ollamaResponse.data.message;
        // Clean up any leaked internal Llama tags like <|start_header_id|>
        if (reply && reply.content) {
            reply.content = reply.content.replace(/<\|.*?\|>/g, '').trim();
            // Optional: Strip "Interviewer:" or "AI:" prefixes if it still tries to write a script
            reply.content = reply.content.replace(/^(Interviewer:|AI Interviewer:|AI:|Interviewer \s*-)/i, '').trim();
        }
        console.log('Ollama chat reply received.');

        // Since we combined user answer and instruction for Ollama, we can just save it as the user's answer in our local history
        // to keep the history clean for future requests
        messages.pop(); // Remove the "instruction-injected" user message
        messages.push({ role: 'user', content: answer }); // Add clean user message
        messages.push(reply);

        // Memory cleanup to prevent large payload over network
        let updatedHistory = messages;
        if (messages.length > 12) {
            const systemPromptMeta = messages[0];
            const recent = messages.slice(-10); // Keep last 10
            updatedHistory = [systemPromptMeta, ...recent];
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

module.exports = router;
