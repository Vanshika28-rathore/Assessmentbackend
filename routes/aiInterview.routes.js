const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParseModule = require('pdf-parse');
const pdfParse = typeof pdfParseModule === 'function' ? pdfParseModule : (typeof pdfParseModule.default === 'function' ? pdfParseModule.default : null);
const axios = require('axios');

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL_NAME = 'llama3.2:1b';

const extractSkillsHint = (resumeText = '') => {
    const normalized = String(resumeText || '');
    const skillsLineMatch = normalized.match(/skills\s*:\s*([^\n\r]+)/i);
    if (skillsLineMatch?.[1]) {
        return skillsLineMatch[1].trim();
    }

    const knownSkills = [
        'python', 'django', 'node.js', 'nodejs', 'javascript', 'typescript',
        'mysql', 'postgresql', 'mongodb', 'sql', 'rest api', 'apis',
        'java', 'c', 'c++', 'react', 'express'
    ];

    const found = knownSkills.filter((skill) => normalized.toLowerCase().includes(skill));
    return found.slice(0, 8).join(', ');
};

router.post('/upload-resume', upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No resume file uploaded' });
        }

        console.log('--- AI Interview: Starting Upload ---');
        let resumeText = '';

        try {
            if (!pdfParse) {
                resumeText = req.file.buffer.toString('utf-8');
            } else {
                const data = await pdfParse(req.file.buffer);
                resumeText = data.text;
            }
        } catch (pdfErr) {
            console.error('Error parsing PDF:', pdfErr);
            return res.status(400).json({ success: false, message: 'File is not a valid PDF' });
        }

        const contextText = resumeText.substring(0, 2000);
        const skillsHint = extractSkillsHint(resumeText);

        const systemPrompt = `You are a friendly, basic technical interviewer for a BEGINNER.
Candidate's Resume extract: "${contextText}"
    Candidate skills/topics to use: "${skillsHint || 'Not clearly listed'}"

RULES:
1. Speak naturally. Do NOT write transcripts or "Interviewer:".
    2. Ask EXTREMELY SIMPLE, short, basic questions ONLY from the candidate skills/topics above.
    3. If the candidate says they do not know a topic, switch to a different skill/topic next.
    4. Avoid repeating the same topic in consecutive turns.
    5. If data analysis or visualization appears in resume/skills, it is allowed to ask.
    6. Never claim "your resume mentions X" unless X appears exactly in the provided skills/topics or resume extract.
    7. Do not ask about libraries/frameworks not present in the provided skills/topics.
    8. Never repeat labels like "Candidate's response" or quote the candidate answer back verbatim.
    9. Stop after exactly ONE question.`;

        const greeting = "Hello! I am your AI interviewer. I have successfully analyzed your resume. Please type or say 'Yes' when you are ready for your first question.";

        res.json({
            success: true,
            systemPrompt: systemPrompt,
            message: greeting
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

        messages.push({
            role: 'user',
            content: `${answer}\n\n(Interviewer Note: Briefly acknowledge in one short sentence without repeating the exact answer text, then ask one simple next technical question based on their skills. Do not repeat any of your previous questions or the same topic consecutively. Keep it friendly and beginner-level.)`
        });

        const ollamaResponse = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME,
            messages: messages,
            stream: false,
            options: {
                num_predict: 64,
                num_ctx: 768,
                temperature: 0.35,
                top_p: 0.5
            }
        }, { timeout: 45000 });

        let replyContent = ollamaResponse.data.message?.content || '';
        replyContent = replyContent.replace(/<\|.*?\|>/g, '').trim();
        replyContent = replyContent.replace(/^(Interviewer:|AI Interviewer:|AI:)/i, '').trim();

        messages.pop();
        messages.push({ role: 'user', content: answer });
        messages.push({ role: 'assistant', content: replyContent });

        let updatedHistory = messages;
        if (messages.length > 12) {
            const systemPromptMeta = messages[0];
            const recent = messages.slice(-10);
            updatedHistory = [systemPromptMeta, ...recent];
        }

        res.json({
            success: true,
            message: replyContent,
            updatedHistory: updatedHistory
        });

    } catch (error) {
        console.error('AI Interview Chat Error:', error.message);
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({ success: false, message: 'AI response timed out. Please try again.' });
        }
        res.status(500).json({ success: false, message: 'Failed to get AI response' });
    }
});

module.exports = router;