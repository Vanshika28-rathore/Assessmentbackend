const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');
const db = require('../config/db');

const PDF_OPERATOR_PATTERN = /\b(BT|ET|BDC|EMC|Tf|Tm|Td|TJ|Tj|Do|cm|q|Q|re|w|J|j|d|RG|rg|K|k|gs|m|l|c|h|S|s|f|F|B|b|n|W|BI|ID|EI|obj|endobj|stream|endstream|xref|trailer|startxref)\b/g;
const PDF_METADATA_PATTERN = /D:\d{10,}\+00'00'|ReportLab PDF Library|endobj|endstream|startxref|%%EOF|\/Type\s*\/|\bxref\b|\bobj\b\s+\bstream\b|<[0-9a-f]{8,}>/i;

const sanitizeResumeText = (input = '') => input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\/MCID\s*\d+/gi, ' ')
    .replace(/\/F\d+/gi, ' ')
    .replace(/<</g, ' ')
    .replace(/>>/g, ' ')
    .replace(PDF_OPERATOR_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isLowQualityResumeText = (text = '') => {
    if (PDF_METADATA_PATTERN.test(text)) return true;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    const alphaWords = tokens.filter((token) => /[A-Za-z]{3,}/.test(token)).length;
    const operatorHits = (text.match(PDF_OPERATOR_PATTERN) || []).length;
    return alphaWords / Math.max(1, tokens.length) < 0.45 || operatorHits / Math.max(1, tokens.length) > 0.08;
};

// PDF text extractor — pdf-parse@1.1.1 exports a simple async function
async function extractPdfText(buffer) {
    // Attempt 1: pdf-parse v1.1.1 (standard well-known package)
    try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        const text = data && data.text ? sanitizeResumeText(data.text) : '';
        if (text.length > 15 && !isLowQualityResumeText(text)) {
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
        const cleaned = sanitizeResumeText(allText);
        if (cleaned.length > 15 && !isLowQualityResumeText(cleaned)) {
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

// ── Skill extractor ──────────────────────────────────────────────────────────
// Instead of relying on the tiny model to "read" the resume,
// we extract skills server-side and tell it exactly which skill to ask about.
function extractSkillsFromResume(text = '') {
    const normalizedText = text
        .replace(/ReportLab PDF Library/gi, ' ')
        .replace(/\bD:\d{10,}\+00'00'\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const lowerText = normalizedText.toLowerCase();
    const skillPatterns = [
        ['javascript', /\bjavascript\b|\bjs\b/i],
        ['typescript', /\btypescript\b|\bts\b/i],
        ['python', /\bpython\b/i],
        ['java', /\bjava\b/i],
        ['c++', /\bc\+\+\b/i],
        ['c#', /\bc#\b/i],
        ['php', /\bphp\b/i],
        ['kotlin', /\bkotlin\b/i],
        ['go', /\bgolang\b|\bgo\b/i],
        ['rust', /\brust\b/i],
        ['matlab', /\bmatlab\b/i],
        ['react', /\breact(?:\.js|js)?\b/i],
        ['angular', /\bangular\b/i],
        ['vue', /\bvue(?:\.js|js)?\b/i],
        ['next.js', /\bnext(?:\.js|js)?\b/i],
        ['html', /\bhtml5?\b/i],
        ['css', /\bcss3?\b/i],
        ['tailwind', /\btailwind(?: css)?\b/i],
        ['bootstrap', /\bbootstrap\b/i],
        ['redux', /\bredux\b/i],
        ['node.js', /\bnode(?:\.js|js)?\b/i],
        ['express', /\bexpress(?:\.js|js)?\b/i],
        ['django', /\bdjango\b/i],
        ['flask', /\bflask\b/i],
        ['spring', /\bspring(?: boot)?\b/i],
        ['fastapi', /\bfastapi\b/i],
        ['mongodb', /\bmongo ?db\b/i],
        ['mysql', /\bmysql\b/i],
        ['postgresql', /\bpostgres(?:ql)?\b/i],
        ['sqlite', /\bsqlite\b/i],
        ['redis', /\bredis\b/i],
        ['firebase', /\bfirebase\b/i],
        ['sql', /\bsql\b/i],
        ['aws', /\baws\b|amazon web services/i],
        ['azure', /\bazure\b/i],
        ['gcp', /\bgcp\b|google cloud/i],
        ['docker', /\bdocker\b/i],
        ['kubernetes', /\bkubernetes\b|\bk8s\b/i],
        ['linux', /\blinux\b/i],
        ['machine learning', /\bmachine learning\b|\bml\b/i],
        ['deep learning', /\bdeep learning\b/i],
        ['tensorflow', /\btensorflow\b/i],
        ['pytorch', /\bpytorch\b/i],
        ['pandas', /\bpandas\b/i],
        ['numpy', /\bnumpy\b/i],
        ['scikit-learn', /\bscikit[- ]learn\b|\bsklearn\b/i],
        ['data analysis', /\bdata analysis\b|\bdata analytics\b/i],
        ['git', /\bgit\b/i],
        ['github', /\bgithub\b/i],
        ['postman', /\bpostman\b/i],
        ['figma', /\bfigma\b/i],
        ['rest api', /\brest(?:ful)? api\b|\brest\b/i],
        ['microservices', /\bmicroservices?\b/i],
        ['oop', /\boop\b|object oriented/i],
        ['data structures', /\bdata structures?\b/i],
        ['algorithms', /\balgorithms?\b/i],
        ['r programming', /\br programming\b|\br language\b|\bprogramming in r\b/i]
    ];

    const found = [];
    for (const [skill, pattern] of skillPatterns) {
        if (pattern.test(lowerText)) {
            found.push(skill);
        }
    }

    if (found.length > 0) return [...new Set(found)].slice(0, 12);

    const headingMatch = normalizedText.match(/(?:skills|technical skills|technologies|tools)\s*[:\-]\s*([^.\n]{20,300})/i);
    if (headingMatch) {
        const terms = headingMatch[1]
            .split(/[,|;/•]+/)
            .map((term) => term.trim())
            .filter((term) => /^[a-z0-9 .+#-]{2,30}$/i.test(term));
        if (terms.length > 0) return [...new Set(terms)].slice(0, 10);
    }

    const caps = normalizedText.match(/\b[A-Z][a-zA-Z0-9+#.-]{2,}\b/g) || [];
    const ignored = new Set(['The', 'And', 'For', 'With', 'From', 'This', 'That', 'Your', 'Our', 'ReportLab', 'PDF', 'Library']);
    const unique = [...new Set(caps.filter((word) => !ignored.has(word)))];
    return unique.slice(0, 8);
}

router.post('/upload-resume', upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No resume file uploaded' });
        }

        console.log('--- AI Interview: Parsing Resume ---');

        // Use robust extractor
        const rawText = await extractPdfText(req.file.buffer);
        const filenameHint = String(req.file.originalname || '')
            .replace(/\.pdf$/i, '')
            .replace(/[_-]+/g, ' ')
            .replace(/\(\d+\)/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const resumeSourceText = rawText || filenameHint;

        if (!resumeSourceText || resumeSourceText.length < 4) {
            return res.status(400).json({
                success: false,
                message: 'We could not extract readable text from this PDF. Please upload a text-based resume PDF, not a scanned image.'
            });
        }

        const cleanText = sanitizeResumeText(resumeSourceText);
        if (rawText && isLowQualityResumeText(cleanText)) {
            return res.status(400).json({
                success: false,
                message: 'Resume text extraction quality is low. Please upload a clean text-based PDF resume (not a scanned image).'
            });
        }

        // Take first 1000 chars — enough context, keeps AI fast
        const contextText = cleanText.substring(0, 1000);

        // Extract skills from the resume — we'll use these to guide questions
        const resumeSkills = extractSkillsFromResume(contextText);
        console.log('Extracted skills:', resumeSkills);

        // Minimal system prompt — model just needs to ask about a given topic
        const systemPrompt = `You are a Technical Recruiter. Your task is to verify the candidate's resume skills.
CANDIDATE RESUME DATA:
"${contextText}"

STRICT INTERVIEW PROTOCOL:
1. Ask EXACTLY ONE short technical question.
2. The question MUST be directly derived from a skill, tool, project, or experience listed in the resume above.
3. NEVER ask about PDF libraries, PDF metadata, ReportLab, or "R" unless the resume explicitly says R programming.
4. NEVER ask general HR questions.
5. NEVER repeat or rephrase a previous question.
6. Output only the question text. End with "?". Maximum 15 words.`;

        const greeting = "Hello! I have read your resume. Let's begin. Say 'Ready' to start.";

        res.json({
            success: true,
            systemPrompt: systemPrompt,
            message: greeting,
            resumeText: contextText,
            resumeSkills: resumeSkills   // <-- frontend uses this to guide each question
        });

    } catch (error) {
        console.error('AI Interview Upload Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to process resume', error: error.message });
    }
});

router.post('/chat', async (req, res) => {
    try {
        const { messages, answer, currentSkill } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, message: 'Message history missing. Please restart the interview.' });
        }
        if (!answer) {
            return res.status(400).json({ success: false, message: 'Answer missing' });
        }

        const skillToAsk = currentSkill || 'a real skill or project from the resume';
        console.log(`--- AI Interview: Received Answer | Skill to ask about: "${skillToAsk}" ---`);

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
            ? `\nALREADY ASKED (DO NOT REPEAT): ${allAsked.map((q) => `"${q.substring(0, 50)}"`).join(' | ')}`
            : '';

        // GUARANTEED RESUME-RELEVANT QUESTIONS:
        // We tell the model exactly which skill to ask about.
        // The prefix forces the model to generate a question about that specific skill.
        // This bypasses the model's inability to "read" the resume itself.
        messages.push({
            role: 'user',
            content: `${answer}\n\n[STRICT INSTRUCTION: Ask exactly one NEW technical question about "${skillToAsk}" from the resume. Do not ask HR/general questions. Do not ask about ReportLab, PDF metadata, or bare "R". Do not repeat earlier questions. Output only the question ending with "?". Maximum 15 words.${avoidList}]`
        });

        console.log(`Sending to Ollama — forcing question about: "${skillToAsk}"`);

        const ollamaResponse = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME,
            messages: messages,
            stream: false,
            keep_alive: '10m',
            options: {
                num_predict: 32,
                num_ctx: 1024,
                temperature: 0.0,
                top_p: 0.1,
                repeat_penalty: 1.5,
                stop: ['?\n', '?\r', 'Answer:', 'Candidate:', '\n\n']
            }
        }, {
            timeout: 30000
        });
        let replyContent = ollamaResponse.data?.message?.content || '';

        // Clean the completion
        replyContent = replyContent
            .replace(/<\|.*?\|>/g, '')
            .replace(/^[:\s]+/, '')
            .replace(/^(Interviewer:|AI Interviewer:|AI:|Q:|Question:|\d+\.)/i, '')
            .replace(/\[INSTRUCTION.*?\]/gi, '')
            .trim();

        const skillLabel = skillToAsk.charAt(0).toUpperCase() + skillToAsk.slice(1);
        let finalQuestion = replyContent;

        const firstQ = finalQuestion.match(/^[^?]*\?/);
        if (firstQ) {
            finalQuestion = firstQ[0].trim();
        } else {
            const firstSentence = finalQuestion.split(/[.!\n]/)[0];
            finalQuestion = (firstSentence || finalQuestion).trim();
            if (finalQuestion && !finalQuestion.endsWith('?')) {
                finalQuestion = `${finalQuestion.replace(/[.!]*$/, '')}?`;
            }
        }

        if (!finalQuestion || finalQuestion.length < 8) {
            finalQuestion = `Can you describe how you have used ${skillLabel} in a project?`;
        }

        console.log('Final question:', finalQuestion);

        // Clean history — remove prefix, store clean question
        messages.pop();
        messages.push({ role: 'user', content: answer });
        messages.push({ role: 'assistant', content: finalQuestion });

        // Keep history trim: system + last 8
        let updatedHistory = messages;
        if (messages.length > 10) {
            updatedHistory = [messages[0], ...messages.slice(-8)];
        }

        res.json({
            success: true,
            message: finalQuestion,
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

        const normalizedChatHistory = Array.isArray(chatHistory) ? chatHistory : [];
        const normalizedStudentName = (studentName || '').trim() || 'Anonymous';

        const result = await db.query(
            `INSERT INTO ai_interviews 
             (student_id, student_name, resume_text, chat_history, rating, feedback_comment)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [studentId || null, normalizedStudentName, resumeText || null, JSON.stringify(normalizedChatHistory), rating || null, feedbackComment || null]
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

        const interview = result.rows[0];
        // Defensive parsing for older rows where chat_history may be stored as TEXT
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
