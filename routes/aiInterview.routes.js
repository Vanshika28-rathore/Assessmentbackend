const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');
const db = require('../config/db');
const PDFDocument = require('pdfkit');

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
    return alphaWords / Math.max(1, tokens.length) < 0.28 || operatorHits / Math.max(1, tokens.length) > 0.12;
};

const hasUsableResumeContent = (text = '') => {
    const tokens = String(text || '').split(/\s+/).filter(Boolean);
    if (tokens.length < 12) return false;
    const alphaWords = tokens.filter((token) => /[A-Za-z]{2,}/.test(token)).length;
    return alphaWords >= 8;
};

const formatReportDate = (value) => {
    if (!value) return '-';
    return new Date(value).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
};

const ensurePdfSpace = (doc, neededHeight = 24) => {
    if (doc.y + neededHeight <= doc.page.height - 50) return;
    doc.addPage();
};

const writePdfSummaryRow = (doc, items = []) => {
    const startX = 50;
    const startY = doc.y;
    const gap = 12;
    const width = Math.floor((doc.page.width - 100 - (gap * (items.length - 1))) / items.length);
    const height = 42;

    items.forEach((item, index) => {
        const x = startX + (index * (width + gap));
        doc.roundedRect(x, startY, width, height, 8).fillAndStroke('#eef0fb', '#eef0fb');
        doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(8).text(String(item.label || '').toUpperCase(), x + 10, startY + 8, { width: width - 20 });
        doc.fillColor('#1e1e3f').font('Helvetica-Bold').fontSize(13).text(String(item.value || '-'), x + 10, startY + 20, { width: width - 20 });
    });

    doc.x = startX;
    doc.y = startY + height + 12;
};

const writePdfSectionTitle = (doc, title) => {
    ensurePdfSpace(doc, 28);
    doc.moveDown(0.5);
    doc.fillColor('#5b5ba8').font('Helvetica-Bold').fontSize(13).text(title);
    doc.moveDown(0.25);
    doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.5);
};

const writePdfWrappedBlock = (doc, title, text, options = {}) => {
    writePdfSectionTitle(doc, title);
    doc.fillColor('#1e1e3f').font('Helvetica').fontSize(options.fontSize || 10).text(String(text || options.emptyText || '-'), {
        width: options.width || (doc.page.width - 100),
        lineGap: options.lineGap || 2
    });
};

const normalizeStoredJson = (value, fallback) => {
    if (typeof value !== 'string') return value || fallback;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
};

const parseStoredInterview = (interview = {}) => ({
    ...interview,
    chat_history: normalizeStoredJson(interview.chat_history, []),
    assessment_summary: normalizeStoredJson(interview.assessment_summary, {}),
    scored_questions: normalizeStoredJson(interview.scored_questions, []),
    ignored_questions: normalizeStoredJson(interview.ignored_questions, []),
    proctoring_counts: normalizeStoredJson(interview.proctoring_counts, {}),
    proctoring_events: normalizeStoredJson(interview.proctoring_events, [])
});

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
const INTERVIEW_CONFIG = {
    maxQuestions: 20,
    correctAnswersPerStar: 4,
    shortlistCorrectThreshold: 15
};
const {
    maxQuestions: MAX_INTERVIEW_QUESTIONS,
    correctAnswersPerStar: CORRECT_ANSWERS_PER_STAR,
    shortlistCorrectThreshold: SHORTLIST_CORRECT_THRESHOLD
} = INTERVIEW_CONFIG;

let aiInterviewSchemaReady = false;

const ensureAiInterviewSchema = async () => {
    if (aiInterviewSchemaReady) return;
    await db.query(`
        ALTER TABLE ai_interviews
        ADD COLUMN IF NOT EXISTS assessment_summary JSONB DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS scored_questions JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS ignored_questions JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS correct_count INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_scored_questions INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS shortlisted BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS result_status VARCHAR(40) DEFAULT 'disqualified',
        ADD COLUMN IF NOT EXISTS proctoring_counts JSONB DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS proctoring_events JSONB DEFAULT '[]'::jsonb
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_interviews_shortlisted ON ai_interviews (shortlisted);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_interviews_result_status ON ai_interviews (result_status);`);
    aiInterviewSchemaReady = true;
};

const normalizeText = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();

const buildFallbackQuestion = (skill = '', askedQuestions = []) => {
    const focusedQuestion = generateFocusedQuestion(skill, askedQuestions);
    if (focusedQuestion) return focusedQuestion;

    const cleanSkill = normalizeText(skill);
    if (cleanSkill) {
        return `Can you explain how you used ${cleanSkill} in one project from your resume?`;
    }
    return 'Can you explain one technical challenge you solved in a project from your resume?';
};

const normalizeSkill = (skill = '') => normalizeText(skill)
    .toLowerCase()
    .replace(/\bfront\s*end\b/g, 'frontend')
    .replace(/\bback\s*end\b/g, 'backend')
    .replace(/\bnodejs\b/g, 'node.js')
    .replace(/\bnextjs\b/g, 'next.js');

const isBlockedSkill = (skill = '') => {
    const value = normalizeSkill(skill);
    return !value ||
        value.length < 2 ||
        ['r', 'pdf', 'resume', 'document', 'library', 'candidate', 'student', 'reportlab', 'frontendresume', 'backendresume'].includes(value) ||
        /\b(resume|document|pdf|reportlab)\b/i.test(value);
};

const isTechnicalQuestion = (question = '') => {
    const q = normalizeText(question).toLowerCase();
    if (!q.endsWith('?')) return false;
    const blocked = [
        'ready', 'let us begin', 'let\'s begin', 'how are you', 'tell me about yourself',
        'which programming language did you use to create', 'create this resume',
        'create and manage this document', 'this document', 'resume be used as input',
        'manipulating resumes', 'openresume', 'readthedocs', 'reportlab', 'pdf generation',
        'syntax for creating a pdf'
    ];
    if (blocked.some((phrase) => q.includes(phrase))) return false;
    const technicalStarters = [
        'how ', 'what ', 'why ', 'when ', 'which ', 'can ', 'could ', 'would ',
        'do ', 'does ', 'did ', 'explain ', 'describe ', 'choose '
    ];
    const technicalSignals = [
        'explain', 'describe', 'difference', 'how do you', 'what is', 'why', 'when would',
        'implement', 'debug', 'optimize', 'design', 'api', 'database', 'sql', 'java',
        'python', 'react', 'node', 'express', 'algorithm', 'data structure', 'oop',
        'pandas', 'machine learning', 'model', 'component', 'state', 'query', 'index',
        'authentication', 'backend', 'frontend', 'server', 'cloud', 'docker',
        'technical challenge', 'tradeoff', 'reliability', 'performance', 'security', 'bug'
    ];
    return technicalStarters.some((starter) => q.startsWith(starter)) ||
        technicalSignals.some((signal) => q.includes(signal));
};

const tokenize = (text = '') => {
    const stopWords = new Set([
        'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'were',
        'have', 'has', 'had', 'can', 'could', 'would', 'should', 'from', 'into', 'about',
        'what', 'when', 'where', 'which', 'how', 'why', 'does', 'did', 'use', 'used'
    ]);
    return normalizeText(text)
        .toLowerCase()
        .match(/[a-z0-9+#.]{3,}/g)?.filter((word) => !stopWords.has(word)) || [];
};

const classifyAnswer = (question = '', answer = '') => {
    const cleanAnswer = normalizeText(answer);
    const lowerAnswer = cleanAnswer.toLowerCase();
    if (!cleanAnswer || cleanAnswer.length < 3) {
        return { verdict: 'incorrect', score: 0, correct: false, reason: 'No meaningful answer was provided.' };
    }
    if (/\b(don'?t know|no idea|not sure|none|nothing|skip|pass)\b/i.test(lowerAnswer)) {
        return { verdict: 'incorrect', score: 0, correct: false, reason: 'The student did not provide a technical answer.' };
    }

    const questionTokens = tokenize(question);
    const answerTokens = tokenize(answer);
    const answerSet = new Set(answerTokens);
    const overlap = questionTokens.filter((token) => answerSet.has(token)).length;
    const lengthScore = cleanAnswer.length >= 160 ? 2 : cleanAnswer.length >= 80 ? 1 : 0;
    const conceptScore = overlap >= 3 ? 2 : overlap >= 1 ? 1 : 0;
    const explanationScore = /\b(because|for example|such as|means|used to|helps|works|handles|prevents|improves|ensures|trade-?off|accuracy|performance|security|reliability|debug|testing|validation|monitoring|latency|scaling)\b/i.test(lowerAnswer) ? 1 : 0;
    const structureScore = /[,.]/.test(cleanAnswer) || /\b(and|but|so|then|after|before|while)\b/i.test(lowerAnswer) ? 1 : 0;
    const score = Math.min(5, lengthScore + conceptScore + explanationScore + structureScore);

    if ((conceptScore >= 2 && (explanationScore >= 1 || structureScore >= 1)) || (cleanAnswer.length >= 45 && overlap >= 2)) {
        return { verdict: 'correct', score: Math.max(score, 4), correct: true, reason: 'The answer is relevant and technically aligned with the question.' };
    }

    if (score >= 4) {
        return { verdict: 'correct', score, correct: true, reason: 'The answer is relevant and includes useful technical explanation.' };
    }
    if (score >= 2) {
        return { verdict: 'partially_correct', score, correct: false, reason: 'The answer is related but lacks enough detail or precision.' };
    }
    return { verdict: 'incorrect', score, correct: false, reason: 'The answer is too short, vague, or not technically relevant.' };
};

const buildViolationSummary = (proctoringCounts = {}, proctoringEvents = []) => {
    const counts = {
        multipleFaces: Number(proctoringCounts.multipleFaces || 0),
        noFace: Number(proctoringCounts.noFace || 0),
        phoneDetected: Number(proctoringCounts.phoneDetected || 0),
        objectDetected: Number(proctoringCounts.objectDetected || 0),
        voiceDetected: Number(proctoringCounts.voiceDetected || 0),
        tabSwitch: Number(proctoringCounts.tabSwitch || 0),
        responseTimeout: Number(proctoringCounts.responseTimeout || 0),
    };
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const events = Array.isArray(proctoringEvents) ? proctoringEvents.slice(0, 200) : [];
    return { counts, total, events };
};

const buildRating = (correctCount = 0) =>
    Math.max(0, Math.min(5, Math.ceil(correctCount / CORRECT_ANSWERS_PER_STAR)));

const buildInterviewAssessment = (chatHistory = [], resumeText = '', proctoringCounts = {}, proctoringEvents = []) => {
    const normalized = Array.isArray(chatHistory) ? chatHistory : [];
    const scoredQuestions = [];
    const ignoredQuestions = [];
    let pendingQuestion = null;

    normalized.forEach((message) => {
        const role = message?.role === 'ai' ? 'assistant' : message?.role;
        const content = normalizeText(message?.content);
        if (!content) return;

        if (role === 'assistant') {
            if (isTechnicalQuestion(content)) {
                pendingQuestion = content;
            } else {
                ignoredQuestions.push({ question: content, reason: 'Greeting, setup, resume/document question, or non-technical prompt.' });
                pendingQuestion = null;
            }
            return;
        }

        if (role === 'user' && pendingQuestion) {
            const assessment = classifyAnswer(pendingQuestion, content);
            scoredQuestions.push({
                number: scoredQuestions.length + 1,
                question: pendingQuestion,
                answer: content,
                verdict: assessment.verdict,
                score: assessment.score,
                correct: assessment.correct,
                reason: assessment.reason
            });
            pendingQuestion = null;
        }
    });

    const limitedScored = scoredQuestions.slice(0, MAX_INTERVIEW_QUESTIONS);
    const correctCount = limitedScored.filter((item) => item.correct).length;
    const rating = buildRating(correctCount);
    const shortlisted = correctCount >= SHORTLIST_CORRECT_THRESHOLD;

    const verdictCounts = limitedScored.reduce((acc, item) => {
        acc[item.verdict] = (acc[item.verdict] || 0) + 1;
        return acc;
    }, {});

    const skills = extractSkillsFromResume(resumeText).filter((skill) => !isBlockedSkill(skill)).slice(0, 8);
    const violationSummary = buildViolationSummary(proctoringCounts, proctoringEvents);
    const weakAreas = limitedScored
        .filter((item) => item.verdict !== 'correct')
        .slice(0, 5)
        .map((item) => item.question);

    const summaryText = [
        `The AI interview scored ${correctCount} correct answer${correctCount === 1 ? '' : 's'} out of ${limitedScored.length} technical question${limitedScored.length === 1 ? '' : 's'}.`,
        `Rating is ${rating}/5 using ${CORRECT_ANSWERS_PER_STAR} correct answers per star.`,
        shortlisted
            ? 'The student is auto-shortlisted for admin interview scheduling.'
            : `The student is not auto-shortlisted because the threshold is ${SHORTLIST_CORRECT_THRESHOLD}/${MAX_INTERVIEW_QUESTIONS}.`,
        skills.length > 0 ? `Main resume topics detected: ${skills.join(', ')}.` : 'No clear resume skill list was detected.',
        weakAreas.length > 0 ? `Needs review on: ${weakAreas.join(' | ')}` : 'Most scored answers were relevant.',
        violationSummary.total > 0
            ? `Proctoring recorded ${violationSummary.total} issue(s): no face ${violationSummary.counts.noFace}, multiple faces ${violationSummary.counts.multipleFaces}, phone ${violationSummary.counts.phoneDetected}, object ${violationSummary.counts.objectDetected}, voice/noise ${violationSummary.counts.voiceDetected}, tab switch ${violationSummary.counts.tabSwitch}, timeout ${violationSummary.counts.responseTimeout}.`
            : 'No AI interview proctoring issues were recorded.'
    ].join(' ');

    return {
        scoredQuestions: limitedScored,
        ignoredQuestions,
        correctCount,
        totalScoredQuestions: limitedScored.length,
        rating,
        shortlisted,
        resultStatus: shortlisted ? 'auto_shortlisted' : 'disqualified',
        summary: {
            text: summaryText,
            maxQuestions: MAX_INTERVIEW_QUESTIONS,
            correctAnswersPerStar: CORRECT_ANSWERS_PER_STAR,
            shortlistThreshold: SHORTLIST_CORRECT_THRESHOLD,
            verdictCounts,
            skills,
            weakAreas,
            violations: violationSummary
        }
    };
};


const questionTemplates = {
    python: [
        'In your resume project, how would you structure Python modules to keep the code maintainable?',
        'How would you debug a slow Python API or script used in one of your projects?',
        'Explain a Python decision from your project where you handled errors or edge cases.',
        'How would you test the important Python functions in your resume project?'
    ],
    javascript: [
        'In your project, how did you manage asynchronous JavaScript operations and possible failures?',
        'How would you prevent duplicate API calls or race conditions in your JavaScript code?',
        'Explain how your JavaScript code handles state changes after a user action.',
        'How would you debug a browser issue where JavaScript works locally but fails in production?'
    ],
    react: [
        'In your React project, how did you split components to avoid unnecessary re-renders?',
        'How would you manage form state and validation in the React screen from your resume?',
        'Explain how you handled API loading, success, and error states in your React project.',
        'How would you make one React component reusable without making it too generic?'
    ],
    frontend: [
        'In your frontend work, how would you make a complex page responsive without layout breaks?',
        'How did you handle API errors and loading states in your frontend project?',
        'Explain how you would improve accessibility for one screen from your frontend project.',
        'How would you optimize a frontend page that becomes slow after many records load?'
    ],
    backend: [
        'In your backend project, how did you validate inputs before saving data?',
        'How would you design error handling for an API used by your frontend project?',
        'Explain how you would protect one backend route from unauthorized access.',
        'How would you debug an API that works sometimes but fails under load?'
    ],
    'node.js': [
        'In your Node.js project, how did you organize routes, services, and database logic?',
        'How would you handle async errors in an Express API without crashing the server?',
        'Explain how you would secure a Node.js endpoint that updates important records.',
        'How would you improve performance for a slow Node.js API route?'
    ],
    express: [
        'In your Express project, how did you structure middleware for authentication and validation?',
        'How would you handle one failed database query inside an Express route?',
        'Explain how you would design REST endpoints for a feature from your resume.',
        'How would you prevent invalid requests from reaching your Express business logic?'
    ],
    sql: [
        'In your project database, how would you choose indexes for frequently used queries?',
        'How would you prevent duplicate records while multiple users submit data together?',
        'Explain how you would design tables for one feature mentioned in your resume.',
        'How would you debug a SQL query that becomes slow with more data?'
    ],
    bootstrap: [
        'In your Bootstrap work, how did you customize responsive layouts beyond default classes?',
        'How would you fix a Bootstrap layout that breaks between tablet and desktop widths?',
        'Explain how you would keep Bootstrap styling consistent across multiple pages.',
        'How would you combine Bootstrap utilities with custom CSS without conflicts?'
    ]
};

const genericTemplates = [
    'Choose one resume project and explain a technical challenge you solved end to end?',
    'How would you improve performance, security, or reliability in one project from your resume?',
    'Explain one bug you might face in your resume project and how you would isolate it?',
    'Describe one design decision from your resume project and the tradeoff behind it?'
];

const generateFocusedQuestion = (skill = '', askedQuestions = []) => {
    const normalizedSkill = normalizeSkill(skill);
    const bank = questionTemplates[normalizedSkill] || genericTemplates.map((template) => {
        if (!normalizedSkill || isBlockedSkill(normalizedSkill)) return template;
        return template.replace('resume project', `${normalizedSkill} project`);
    });
    const askedSet = new Set((askedQuestions || []).map((q) => normalizeText(q).toLowerCase()));
    return bank.find((question) => !askedSet.has(question.toLowerCase())) || null;
};

const recomputeInterviewRowIfNeeded = async (interview) => {
    if (!interview) return interview;
    const chatHistory = Array.isArray(interview.chat_history) ? interview.chat_history : [];
    const existingSummary = `${interview.assessment_summary?.text || ''} ${interview.feedback_comment || ''}`;
    const needsRecompute =
        chatHistory.length > 0 && (
        !interview.assessment_summary?.text ||
        Number(interview.total_scored_questions || 0) === 0 ||
        Number(interview.assessment_summary?.maxQuestions || 0) !== MAX_INTERVIEW_QUESTIONS ||
        Number(interview.assessment_summary?.correctAnswersPerStar || 0) !== CORRECT_ANSWERS_PER_STAR ||
        Number(interview.assessment_summary?.shortlistThreshold || 0) !== SHORTLIST_CORRECT_THRESHOLD ||
        /reportlab|pdf generation|syntax for creating a pdf|test mode/i.test(existingSummary)
        );
    if (!needsRecompute || chatHistory.length === 0) return interview;

    const assessment = buildInterviewAssessment(
        chatHistory,
        interview.resume_text || '',
        interview.proctoring_counts || {},
        interview.proctoring_events || []
    );
    await db.query(
        `UPDATE ai_interviews
         SET rating = $1,
             feedback_comment = $2,
             assessment_summary = $3::jsonb,
             scored_questions = $4::jsonb,
             ignored_questions = $5::jsonb,
             correct_count = $6,
             total_scored_questions = $7,
             shortlisted = $8,
             result_status = $9
         WHERE id = $10`,
        [
            assessment.rating,
            assessment.summary.text,
            JSON.stringify(assessment.summary),
            JSON.stringify(assessment.scoredQuestions),
            JSON.stringify(assessment.ignoredQuestions),
            assessment.correctCount,
            assessment.totalScoredQuestions,
            assessment.shortlisted,
            assessment.resultStatus,
            interview.id
        ]
    );
    return {
        ...interview,
        rating: assessment.rating,
        feedback_comment: assessment.summary.text,
        assessment_summary: assessment.summary,
        scored_questions: assessment.scoredQuestions,
        ignored_questions: assessment.ignoredQuestions,
        correct_count: assessment.correctCount,
        total_scored_questions: assessment.totalScoredQuestions,
        shortlisted: assessment.shortlisted,
        result_status: assessment.resultStatus
    };
};

const mapInterviewListRows = async (rows = [], options = {}) => {
    const includeEvents = Boolean(options.includeEvents);
    const data = [];

    for (const row of rows) {
        const normalized = parseStoredInterview(row);
        const recomputed = await recomputeInterviewRowIfNeeded(normalized);
        data.push({
            id: recomputed.id,
            student_id: recomputed.student_id,
            student_name: recomputed.student_name,
            roll_number: recomputed.roll_number,
            full_name: recomputed.full_name,
            email: recomputed.email,
            institute: recomputed.institute,
            rating: recomputed.rating,
            feedback_comment: recomputed.feedback_comment,
            correct_count: recomputed.correct_count,
            total_scored_questions: recomputed.total_scored_questions,
            shortlisted: recomputed.shortlisted,
            result_status: recomputed.result_status,
            proctoring_counts: recomputed.proctoring_counts,
            created_at: recomputed.created_at,
            ...(includeEvents
                ? { proctoring_events: recomputed.proctoring_events }
                : {})
        });
    }

    return data;
};

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
        if (pattern.test(lowerText) && !isBlockedSkill(skill)) {
            found.push(skill);
        }
    }

    if (found.length > 0) return [...new Set(found)].slice(0, 12);

    const headingMatch = normalizedText.match(/(?:skills|technical skills|technologies|tools)\s*[:\-]\s*([^.\n]{20,300})/i);
    if (headingMatch) {
        const terms = headingMatch[1]
            .split(/[,|;/•]+/)
            .map((term) => term.trim())
            .filter((term) => /^[a-z0-9 .+#-]{2,30}$/i.test(term))
            .filter((term) => !isBlockedSkill(term));
        if (terms.length > 0) return [...new Set(terms)].slice(0, 10);
    }

    const caps = normalizedText.match(/\b[A-Z][a-zA-Z0-9+#.-]{2,}\b/g) || [];
    const ignored = new Set(['The', 'And', 'For', 'With', 'From', 'This', 'That', 'Your', 'Our', 'ReportLab', 'PDF', 'Library', 'Resume']);
    const unique = [...new Set(caps.filter((word) => !ignored.has(word) && !isBlockedSkill(word)))];
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
        if (rawText && isLowQualityResumeText(cleanText) && !hasUsableResumeContent(cleanText)) {
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
3. NEVER ask about PDF libraries, PDF metadata, ReportLab, resumes, documents, or "R" unless the resume explicitly says R programming.
4. NEVER ask general HR questions.
5. NEVER repeat or rephrase a previous question.
6. Ask applied technical questions that can be judged for correctness.
7. Output only the question text. End with "?". Maximum 18 words.`;

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

        const skillToAsk = normalizeText(currentSkill) || 'a real skill or project from the resume';
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
        if (allAsked.filter(isTechnicalQuestion).length >= MAX_INTERVIEW_QUESTIONS) {
            return res.json({
                success: true,
                completed: true,
                message: 'Interview completed.',
                updatedHistory: messages
            });
        }
        const avoidList = allAsked.length > 0
            ? `\nALREADY ASKED (DO NOT REPEAT): ${allAsked.map((q) => `"${q.substring(0, 50)}"`).join(' | ')}`
            : '';

        const focusedQuestion = generateFocusedQuestion(currentSkill, allAsked);
        if (focusedQuestion) {
            messages.push({ role: 'user', content: answer });
            messages.push({ role: 'assistant', content: focusedQuestion });
            const updatedHistory = messages.length > 10 ? [messages[0], ...messages.slice(-8)] : messages;
            return res.json({
                success: true,
                message: focusedQuestion,
                updatedHistory
            });
        }

        // GUARANTEED RESUME-RELEVANT QUESTIONS:
        // We tell the model exactly which skill to ask about.
        // The prefix forces the model to generate a question about that specific skill.
        // This bypasses the model's inability to "read" the resume itself.
        messages.push({
            role: 'user',
            content: `${answer}\n\n[STRICT INSTRUCTION: Ask exactly one NEW applied technical question about "${skillToAsk}" from the resume. Do not ask HR/general questions. Do not ask about ReportLab, PDF metadata, resumes, documents, or bare "R". Do not repeat earlier questions. Output only the question ending with "?". Maximum 18 words.${avoidList}]`
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

        if (!finalQuestion || finalQuestion.length < 8 || !isTechnicalQuestion(finalQuestion)) {
            finalQuestion = buildFallbackQuestion(skillLabel, allAsked);
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
        const askedQuestions = Array.isArray(req.body?.askedQuestions) ? req.body.askedQuestions : [];
        const fallbackQuestion = buildFallbackQuestion(req.body?.currentSkill || '', askedQuestions);
        const history = Array.isArray(req.body?.messages) ? [...req.body.messages] : [];
        if (req.body?.answer) {
            history.push({ role: 'user', content: req.body.answer });
        }
        history.push({ role: 'assistant', content: fallbackQuestion });
        const updatedHistory = history.length > 10 ? [history[0], ...history.slice(-8)] : history;
        res.json({ success: true, message: fallbackQuestion, updatedHistory, fallback: true });
    }
});

// ============================================
// SAVE interview result to DB
// ============================================
router.post('/save', async (req, res) => {
    try {
        await ensureAiInterviewSchema();
        const { studentId, studentName, resumeText, chatHistory, proctoringCounts, proctoringEvents } = req.body;

        if (!chatHistory) {
            return res.status(400).json({ success: false, message: 'Chat history missing.' });
        }

        const normalizedChatHistory = Array.isArray(chatHistory) ? chatHistory : [];
        const normalizedStudentName = (studentName || '').trim() || 'Anonymous';
        const assessment = buildInterviewAssessment(normalizedChatHistory, resumeText || '', proctoringCounts || {}, proctoringEvents || []);

        const result = await db.query(
            `INSERT INTO ai_interviews 
             (student_id, student_name, resume_text, chat_history, rating, feedback_comment,
              assessment_summary, scored_questions, ignored_questions, correct_count,
              total_scored_questions, shortlisted, result_status, proctoring_counts, proctoring_events)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
             RETURNING id`,
            [
                studentId || null,
                normalizedStudentName,
                resumeText || null,
                JSON.stringify(normalizedChatHistory),
                assessment.rating,
                assessment.summary.text,
                JSON.stringify(assessment.summary),
                JSON.stringify(assessment.scoredQuestions),
                JSON.stringify(assessment.ignoredQuestions),
                assessment.correctCount,
                assessment.totalScoredQuestions,
                assessment.shortlisted,
                assessment.resultStatus,
                JSON.stringify(proctoringCounts || {}),
                JSON.stringify(Array.isArray(proctoringEvents) ? proctoringEvents.slice(0, 200) : [])
            ]
        );

        console.log(`✅ AI Interview saved for student ${studentName}, id: ${result.rows[0].id}`);
        res.json({ success: true, id: result.rows[0].id, assessment });

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
        await ensureAiInterviewSchema();
        const result = await db.query(
            `SELECT ai.id, ai.student_id, ai.student_name, ai.resume_text, ai.chat_history,
                    ai.assessment_summary, ai.scored_questions, ai.ignored_questions,
                    ai.rating, ai.feedback_comment, ai.correct_count,
                    ai.total_scored_questions, ai.shortlisted, ai.result_status, ai.created_at,
                    ai.proctoring_counts, ai.proctoring_events, s.roll_number, s.full_name, s.email, s.institute
             FROM ai_interviews ai
             LEFT JOIN students s ON s.id::text = ai.student_id OR s.roll_number::text = ai.student_id
             ORDER BY created_at DESC`
        );
        const data = await mapInterviewListRows(result.rows);
        res.json({ success: true, data });
    } catch (error) {
        console.error('AI Interview Results Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch results.' });
    }
});

const exportAiInterviewResults = async (req, res) => {
    try {
        await ensureAiInterviewSchema();
        const type = ['shortlisted', 'disqualified'].includes(req.query.type) ? req.query.type : 'all';
        let where = '';
        if (type === 'shortlisted') where = 'WHERE shortlisted = true';
        if (type === 'disqualified') where = 'WHERE shortlisted = false';

        const result = await db.query(
            `SELECT ai.id, ai.student_id, ai.student_name, ai.resume_text, ai.chat_history,
                    ai.assessment_summary, ai.scored_questions, ai.ignored_questions,
                    ai.rating, ai.correct_count, ai.total_scored_questions,
                    ai.shortlisted, ai.result_status, ai.feedback_comment, ai.created_at,
                    ai.proctoring_counts, ai.proctoring_events,
                    s.roll_number, s.full_name, s.email, s.institute
             FROM ai_interviews ai
             LEFT JOIN students s ON s.id::text = ai.student_id OR s.roll_number::text = ai.student_id
             ${where}
             ORDER BY ai.created_at DESC`
        );

        const data = await mapInterviewListRows(result.rows, { includeEvents: true });

        res.json({ success: true, type, data });
    } catch (error) {
        console.error('AI Interview Export Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to export interview results.' });
    }
};

router.get('/export', exportAiInterviewResults);
router.get('/results/export', exportAiInterviewResults);

// GET single interview detail (Admin only)
router.get('/results/:id', async (req, res) => {
    try {
        await ensureAiInterviewSchema();
        const { id } = req.params;
        const result = await db.query(
            `SELECT * FROM ai_interviews WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Interview not found.' });
        }

        let interview = parseStoredInterview(result.rows[0]);
        interview = await recomputeInterviewRowIfNeeded(interview);

        res.json({ success: true, data: interview });
    } catch (error) {
        console.error('AI Interview Detail Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch interview detail.' });
    }
});

router.get('/results/:id/report', async (req, res) => {
    try {
        await ensureAiInterviewSchema();
        const { id } = req.params;
        const result = await db.query(`SELECT * FROM ai_interviews WHERE id = $1`, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Interview not found.' });
        }

        let interview = parseStoredInterview(result.rows[0]);
        interview = await recomputeInterviewRowIfNeeded(interview);

        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const safeName = String(interview.student_name || 'student').replace(/[^a-z0-9_-]+/gi, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Interview_Report_${safeName}.pdf"`);
        doc.pipe(res);

        doc.fillColor('#1e1e3f').font('Helvetica-Bold').fontSize(24).text(`Interview Detail - ${interview.student_name || 'Anonymous'}`);
        doc.moveDown(0.2);
        doc.fillColor('#64748b').font('Helvetica').fontSize(10).text(formatReportDate(interview.created_at));
        doc.moveDown(0.6);

        writePdfSummaryRow(doc, [
            { label: 'Student ID', value: interview.student_id || '-' },
            { label: 'Rating', value: `${interview.rating || 0}/5` },
            { label: 'Score', value: `${interview.correct_count || 0}/${interview.total_scored_questions || 0}` },
            { label: 'Decision', value: interview.shortlisted ? 'Shortlisted' : 'Disqualified' }
        ]);

        writePdfWrappedBlock(
            doc,
            'Interview Summary',
            interview.assessment_summary?.text || interview.feedback_comment || 'Summary not available.'
        );

        writePdfSectionTitle(doc, 'Scored Technical Questions');
        if (Array.isArray(interview.scored_questions) && interview.scored_questions.length > 0) {
            interview.scored_questions.forEach((item) => {
                ensurePdfSpace(doc, 78);
                const top = doc.y;
                const boxWidth = doc.page.width - 100;
                doc.roundedRect(50, top, boxWidth, 64, 8).stroke('#e2e8f0');
                doc.fillColor('#5b5ba8').font('Helvetica-Bold').fontSize(10).text(`Q${item.number || ''}`, 62, top + 10);
                doc.fillColor('#1e1e3f').font('Helvetica-Bold').fontSize(10).text(String(item.question || '-'), 62, top + 24, { width: boxWidth - 24 });
                doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(String(item.reason || '-'), 62, top + 42, { width: boxWidth - 24 });
                doc.y = top + 74;
            });
        } else {
            doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('No scored technical questions available.');
        }

        writePdfSectionTitle(doc, 'Interview Transcript');
        const transcript = (Array.isArray(interview.chat_history) ? interview.chat_history : []).filter((msg) => {
            const role = msg?.role === 'assistant' ? 'ai' : msg?.role;
            return role === 'ai' || role === 'user';
        });
        if (transcript.length > 0) {
            transcript.forEach((msg) => {
                const role = msg?.role === 'assistant' || msg?.role === 'ai' ? 'AI' : 'Student';
                ensurePdfSpace(doc, 34);
                doc.fillColor('#5b5ba8').font('Helvetica-Bold').fontSize(9).text(role);
                doc.fillColor('#1e1e3f').font('Helvetica').fontSize(10).text(String(msg?.content || '-'), { width: doc.page.width - 100, lineGap: 2 });
                doc.moveDown(0.4);
            });
        } else {
            doc.fillColor('#64748b').font('Helvetica').fontSize(10).text('No transcript available.');
        }

        writePdfWrappedBlock(doc, 'Resume Text', interview.resume_text || 'Resume text not captured.', { fontSize: 9, lineGap: 1.5 });

        const counts = interview.proctoring_counts || {};
        writePdfWrappedBlock(
            doc,
            'AI Interview Violations',
            `No face: ${counts.noFace || 0} | Multiple faces: ${counts.multipleFaces || 0} | Phone: ${counts.phoneDetected || 0} | Object: ${counts.objectDetected || 0} | Voice/noise: ${counts.voiceDetected || 0} | Tab switch: ${counts.tabSwitch || 0} | Timeout: ${counts.responseTimeout || 0}`
        );

        doc.end();
    } catch (error) {
        console.error('AI Interview PDF Report Error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Failed to generate report PDF.' });
        }
    }
});

module.exports = router;
