const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { exportExamResults } = require('../services/exportService');
const verifyAdmin = require('../middleware/verifyAdmin');
const PDFDocument = require('pdfkit');
require('pdfkit-table');
const fs = require('fs');

const path = require('path');

// Get all results as JSON - admin only (shows only highest score per student per test)
router.get('/all-results', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      WITH ranked_results AS (
        SELECT 
          r.id,
          r.marks_obtained,
          r.total_marks,
          r.created_at as submitted_at,
          ROUND((r.marks_obtained::numeric / r.total_marks::numeric * 100), 2) as percentage,
          e.name as exam_name,
          e.date as exam_date,
          s.full_name as student_name,
          s.roll_number,
          s.email as student_email,
          s.id as student_id,
          COALESCE(i.display_name, s.institute, 'Not Specified') as institute_name,
          t.id as test_id,
          t.duration,
          t.max_attempts,
          t.passing_percentage,
          t.start_datetime,
          t.end_datetime,
          COALESCE(SUM(CASE WHEN pv.violation_type = 'no_face' THEN 1 ELSE 0 END), 0) as no_face_count,
          COALESCE(SUM(CASE WHEN pv.violation_type = 'multiple_faces' THEN 1 ELSE 0 END), 0) as multiple_faces_count,
          COALESCE(SUM(CASE WHEN pv.violation_type = 'phone_detected' THEN 1 ELSE 0 END), 0) as phone_detected_count,
          COALESCE(SUM(CASE WHEN pv.violation_type = 'loud_noise' THEN 1 ELSE 0 END), 0) as loud_noise_count,
          COALESCE(SUM(CASE WHEN pv.violation_type = 'voice_detected' THEN 1 ELSE 0 END), 0) as voice_detected_count,
          COALESCE(SUM(CASE WHEN pv.violation_type != 'microphone_silent' THEN 1 ELSE 0 END), 0) as total_violations,
          COALESCE(SUM(CASE WHEN pv.severity = 'high' THEN 1 ELSE 0 END), 0) as high_severity_count,
          ROW_NUMBER() OVER (
            PARTITION BY s.id, t.id 
            ORDER BY r.marks_obtained DESC, r.created_at DESC
          ) as rank
        FROM results r
        INNER JOIN exams e ON r.exam_id = e.id
        INNER JOIN students s ON r.student_id = s.id
        LEFT JOIN institutes i ON LOWER(s.institute) = i.name
        LEFT JOIN tests t ON t.title = e.name
        LEFT JOIN proctoring_violations pv ON pv.student_id = s.firebase_uid AND pv.test_id = t.id
        WHERE t.id IS NOT NULL
        GROUP BY r.id, r.marks_obtained, r.total_marks, r.created_at, e.name, e.date, s.full_name, s.roll_number, s.email, s.id, i.display_name, s.institute, t.id, t.duration, t.max_attempts, t.passing_percentage, t.start_datetime, t.end_datetime
      )
      SELECT 
        id,
        marks_obtained,
        total_marks,
        submitted_at,
        percentage,
        exam_name,
        exam_date,
        student_name,
        roll_number,
        student_email,
        student_id,
        institute_name,
        test_id,
        duration,
        max_attempts,
        passing_percentage,
        start_datetime,
        end_datetime,
        no_face_count,
        multiple_faces_count,
        phone_detected_count,
        loud_noise_count,
        voice_detected_count,
        total_violations,
        high_severity_count
      FROM ranked_results
      WHERE rank = 1
      ORDER BY submitted_at DESC
    `);

    res.json({
      success: true,
      results: result.rows
    });
  } catch (error) {
    console.error('Error fetching all results:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch results'
    });
  }
});

// Export endpoint - admin only
router.get('/results', verifyAdmin, async (req, res) => {
  console.log('=== EXPORT ROUTE HIT ===');
  console.log('Query params:', req.query);
  console.log('Headers:', req.headers.authorization);

  try {
    const { examId, testId, startDate, endDate, studentIds } = req.query;
    console.log('Parsed examId:', examId, 'testId:', testId);

    const filters = {};

    // If testId is provided, find the corresponding exam(s) by name
    if (testId) {
      const parsedTestId = parseInt(testId, 10);
      if (isNaN(parsedTestId)) {
        return res.status(400).json({ error: 'Invalid test ID format' });
      }

      // Get the test name
      const testResult = await pool.query('SELECT title FROM tests WHERE id = $1', [parsedTestId]);
      if (testResult.rows.length === 0) {
        return res.status(404).json({ error: 'Test not found' });
      }

      const testName = testResult.rows[0].title;

      // Find ALL matching exams by name
      const examResult = await pool.query('SELECT id FROM exams WHERE name = $1', [testName]);
      if (examResult.rows.length === 0) {
        return res.status(404).json({ error: 'No results found for this exam. Please ensure students have completed the exam before exporting.' });
      }

      // Use ALL matching exam IDs
      filters.examIds = examResult.rows.map(row => row.id);
      console.log('Found matching exam IDs:', filters.examIds, 'for test:', testName);
    } else if (examId) {
      const parsedExamId = parseInt(examId, 10);
      console.log('Parsed exam ID:', parsedExamId);
      if (isNaN(parsedExamId)) {
        return res.status(400).json({ error: 'Invalid exam ID format' });
      }
      filters.examId = parsedExamId;
    }

    if (startDate) {
      filters.startDate = startDate;
    }
    if (endDate) {
      filters.endDate = endDate;
    }

    if (studentIds) {
      filters.studentIds = studentIds;
    }

    console.log('Calling exportExamResults with filters:', filters);
    const { buffer, filename } = await exportExamResults(filters);
    console.log('Export successful, filename:', filename);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );

    res.send(buffer);

  } catch (error) {
    console.error('=== EXPORT ERROR ===');
    console.error('Error:', error);
    console.error('Status code:', error.statusCode);
    console.error('Message:', error.message);

    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal server error';

    if (statusCode === 500) {
      console.error('Error in export endpoint:', error);
    }

    res.status(statusCode).json({ error: message });
  }
});

router.get('/institutes', verifyAdmin, async (req, res) => {
  try {
    console.log('=== FETCHING INSTITUTES FOR EXPORT ===');

    // Get institutes from the institutes table (same as dashboard uses)
    // This ensures the dropdown shows the same names that are stored
    const result = await pool.query(
      `SELECT DISTINCT display_name as institute_name
       FROM institutes
       WHERE is_active = true
       ORDER BY display_name`
    );

    const institutes = result.rows.map(row => row.institute_name);
    console.log('Found institutes:', institutes);
    res.json({ success: true, institutes });
  } catch (error) {
    console.error('Error fetching institutes:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch institutes' });
  }
});

router.get('/students', verifyAdmin, async (req, res) => {
  try {
    const { institutes } = req.query;
    console.log('=== STUDENT EXPORT REQUEST ===');
    console.log('Raw institutes param:', institutes);
    console.log('Decoded institutes:', decodeURIComponent(institutes || ''));

    let queryText = `
      SELECT 
        s.id, 
        s.full_name, 
        s.roll_number, 
        s.email, 
        COALESCE(s.phone, 'N/A') as phone, 
        COALESCE(s.address, 'N/A') as address, 
        COALESCE(i.display_name, s.institute, 'Not Specified') as institute_name, 
        COALESCE(s.course, 'N/A') as course, 
        COALESCE(s.specialization, 'N/A') as specialization,
        COALESCE(s.resume_link, 'N/A') as resume_link,
        s.created_at
      FROM students s
      LEFT JOIN institutes i ON LOWER(s.institute) = i.name
    `;
    const queryParams = [];

    if (institutes && institutes !== 'ALL') {
      // Split by pipe (|) instead of comma to handle institute names with commas
      const instituteList = institutes.split('|').map(c => c.trim());
      console.log('Institute list after split:', instituteList);

      if (instituteList.length > 0) {
        // Handle "Not Specified" case
        const hasNotSpecified = instituteList.includes('Not Specified');
        const otherInstitutes = instituteList.filter(c => c !== 'Not Specified');

        console.log('Has Not Specified:', hasNotSpecified);
        console.log('Other institutes:', otherInstitutes);

        if (hasNotSpecified && otherInstitutes.length > 0) {
          // Match against display_name from institutes table
          queryText += ` WHERE (i.display_name = ANY($1) OR s.institute IS NULL OR s.institute = '')`;
          queryParams.push(otherInstitutes);
        } else if (hasNotSpecified) {
          queryText += ` WHERE (s.institute IS NULL OR s.institute = '' OR i.display_name = 'Not Specified')`;
        } else {
          // Match against display_name from institutes table
          queryText += ` WHERE i.display_name = ANY($1)`;
          queryParams.push(instituteList);
        }
      }
    }

    queryText += ` ORDER BY institute_name, s.full_name`;

    console.log('Final query:', queryText);
    console.log('Query params:', queryParams);

    const result = await pool.query(queryText, queryParams);
    const students = result.rows;

    console.log(`Found ${students.length} students`);

    if (students.length > 0) {
      console.log('Sample student institutes:', students.slice(0, 3).map(s => s.institute_name));
    }

    // Check if no students found
    if (students.length === 0) {
      console.log('No students found - returning 404');
      return res.status(404).json({
        success: false,
        message: 'No students found for the selected institute(s)'
      });
    }

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Student Report');

    // Define columns
    worksheet.columns = [
      { header: 'Registration ID', key: 'roll_number', width: 15 },
      { header: 'Name', key: 'full_name', width: 25 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Institute Name', key: 'institute_name', width: 30 },
      { header: 'Course', key: 'course', width: 15 },
      { header: 'Specialization', key: 'specialization', width: 20 },
      { header: 'Address', key: 'address', width: 40 },
      { header: 'Resume Link', key: 'resume_link', width: 50 },
      { header: 'Registration Date', key: 'created_at', width: 20 },
    ];

    // Style header row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 20;

    // Add data rows
    students.forEach((student, index) => {
      const row = worksheet.addRow({
        roll_number: student.roll_number || 'N/A',
        full_name: student.full_name || 'N/A',
        email: student.email || 'N/A',
        phone: student.phone || 'N/A',
        institute_name: student.institute_name || 'Not Specified',
        course: student.course || 'N/A',
        specialization: student.specialization || 'N/A',
        address: student.address || 'N/A',
        resume_link: student.resume_link || 'N/A',
        created_at: student.created_at ? new Date(student.created_at).toLocaleDateString('en-IN') : 'N/A'
      });

      // Alternate row colors
      if (index % 2 === 0) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF3F4F6' }
        };
      }
    });

    // Add borders to all cells
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
    });

    console.log('Excel file generated successfully');

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `Students_Report_${timestamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();

    console.log('Excel file sent successfully');
  } catch (error) {
    console.error('=== STUDENT EXPORT ERROR ===');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({ success: false, message: 'Failed to export students', error: error.message });
  }
});

// PDF Export endpoint for shortlisted candidates
router.post('/shortlisted-pdf', verifyAdmin, async (req, res) => {
  try {
    const { examName, collegeName, students } = req.body;

    console.log('=== PDF EXPORT REQUEST ===');
    console.log('Exam Name:', examName);
    console.log('College Name:', collegeName);
    console.log('Students Count:', students?.length);

    // Validate request body
    if (!students || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No students provided for PDF export'
      });
    }

    // Set response headers for PDF
    const sanitizedExamName = (examName || 'Assessment_Report').replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedExamName}.pdf"`);

    // Initialize PDF document in landscape mode for more columns
    const doc = new PDFDocument({ 
      margin: 30, 
      size: 'A4',
      layout: 'landscape',
      bufferPages: true,
      autoFirstPage: true
    });
    doc.pipe(res);

    // Document Information
    doc.info['Title'] = examName || 'Assessment Report';
    doc.info['Author'] = 'SHNOOR Management System';

    // 1. Logo Insertion - Positioned neatly top left
    const logoPath = path.resolve(__dirname, '../assets/shnoor-logo1.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 30, 15, { width: 100 });
    }

    // 2. Header Content - Right Aligned
    doc.y = 30;
    const rightColumnX = 30;
    const rightAlign = { align: 'right', width: doc.page.width - 60, lineBreak: false };

    // Get exam date from first student's date (all students should have same exam date)
    const examDate = students && students.length > 0 && students[0].date 
      ? students[0].date 
      : new Date().toLocaleDateString('en-IN');

    doc.font('Helvetica-Bold')
      .fontSize(16)
      .fillColor('#111827')
      .text('ASSESSMENTS REPORT', rightColumnX, doc.y, rightAlign);

    doc.moveDown(0.3);
    doc.font('Helvetica')
      .fontSize(10)
      .fillColor('#4B5563')
      .text(`Exam Date: ${examDate}`, rightColumnX, doc.y, { ...rightAlign, continued: false });

    doc.moveDown(0.2);
    const displayInstitute = collegeName || 'All Institutes';
    doc.fontSize(9)
      .fillColor('#6B7280')
      .text(`Institute: ${displayInstitute}`, rightColumnX, doc.y, rightAlign);

    doc.moveDown(0.2);
    doc.text(`Generated on: ${new Date().toLocaleDateString('en-IN')}`, rightColumnX, doc.y, rightAlign);

    // 3. Horizontal Rule
    doc.moveDown(1.5);
    const lineY = doc.y;
    doc.strokeColor('#E5E7EB')
      .lineWidth(1)
      .moveTo(30, lineY)
      .lineTo(doc.page.width - 30, lineY)
      .stroke();
    doc.moveDown(1.5);

    console.log('Students data received:', JSON.stringify(students, null, 2));

    // 4. Table Setup - All columns like Excel
    let tableTop = doc.y;
    const tableHeaders = ['ID', 'Name', 'Email', 'Date', 'Obtained', 'Total', '%', 'Status', 'No Face', 'Multi', 'Phone', 'Noise', 'Voice', 'Total Viol', 'Flagged', 'Shortlisted'];
    // Adjust widths to fit A4 Landscape (842 pts wide: margins 30+30 = 60, usable = 782)
    // Optimized to use full width: Total = 782 points (removed 65pt unused space)
    const colWidths = [38, 84, 128, 54, 42, 37, 37, 40, 37, 34, 37, 37, 37, 40, 42, 58];
    const rowHeight = 22;
    let tableX = 30;
    let currentY = tableTop;

    // Draw Table Header Background (Light gray, not solid blue)
    doc.rect(tableX, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
      .fill('#F3F4F6');

    // Draw Header Text
    doc.font('Helvetica-Bold')
      .fontSize(7)
      .fillColor('#374151');

    tableHeaders.forEach((header, i) => {
      const x = tableX + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
      doc.text(header, x + 3, currentY + 7, {
        width: colWidths[i] - 6,
        align: i >= 4 ? 'center' : 'left',
        lineBreak: false
      });
    });

    currentY += rowHeight;

    // Header Bottom Border
    doc.strokeColor('#D1D5DB')
      .lineWidth(1)
      .moveTo(tableX, currentY)
      .lineTo(tableX + colWidths.reduce((a, b) => a + b, 0), currentY)
      .stroke();

    // Draw table rows
    doc.font('Helvetica')
      .fontSize(7)
      .fillColor('#1F2937');

    // Industry Standard: Calculate safe page break threshold
    // A4 Landscape height = 595pt, bottom margin + footer = 80pt, safe threshold = 510pt
    const pageBreakThreshold = 510;

    students.forEach((student, idx) => {
      const rowData = [
        String(student.student_id || student.roll_number || student.id || 'N/A'),
        String(student.full_name || student.student_name || student.name || 'N/A'),
        String(student.email || 'N/A'),
        String(student.date || 'N/A'),
        String(student.marks_obtained || '0'),
        String(student.total_marks || '0'),
        String(student.percentage || '0'),
        String(student.status || 'N/A'),
        String(student.no_face || '0'),
        String(student.multiple_faces || '0'),
        String(student.phone_detected || '0'),
        String(student.loud_noise || '0'),
        String(student.voice_detected || '0'),
        String(student.total_violations || '0'),
        String(student.flagged || 'No'),
        String(student.shortlisted || 'No')
      ];

      // Industry Standard: Only break page if NEXT row won't fit AND there are more students
      // This prevents unnecessary blank pages for small datasets
      const willNextRowFit = (currentY + rowHeight) <= pageBreakThreshold;
      const isNotLastStudent = idx < students.length - 1;
      
      if (!willNextRowFit && isNotLastStudent) {
        // Draw Outer Table Border for current page before breaking
        doc.strokeColor('#D1D5DB')
          .lineWidth(1)
          .rect(tableX, tableTop, colWidths.reduce((a, b) => a + b, 0), currentY - tableTop)
          .stroke();

        // Add new page without footer (prevents extra blank pages)
        doc.addPage();

        // Reset position for new page
        currentY = 50;
        tableTop = currentY;

        // Re-draw table header on new page
        doc.rect(tableX, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
          .fill('#F3F4F6');
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#374151');

        tableHeaders.forEach((header, i) => {
          const x = tableX + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
          doc.text(header, x + 3, currentY + 7, {
            width: colWidths[i] - 6,
            align: i >= 4 ? 'center' : 'left',
            lineBreak: false
          });
        });

        currentY += rowHeight;
        doc.strokeColor('#D1D5DB').lineWidth(1).moveTo(tableX, currentY).lineTo(tableX + colWidths.reduce((a, b) => a + b, 0), currentY).stroke();
      }

      // Draw row background (zebra striping)
      if (idx % 2 !== 0) {
        doc.rect(tableX, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
          .fill('#F9FAFB');
      }

      // Draw row bottom border
      doc.strokeColor('#E5E7EB')
        .lineWidth(0.5)
        .moveTo(tableX, currentY + rowHeight)
        .lineTo(tableX + colWidths.reduce((a, b) => a + b, 0), currentY + rowHeight)
        .stroke();

      // Draw row text
      rowData.forEach((data, i) => {
        const x = tableX + colWidths.slice(0, i).reduce((a, b) => a + b, 0);

        // Apply semantic colors for special columns
        if (i === 7) { // Status column
          doc.font('Helvetica-Bold');
          doc.fillColor(data.toLowerCase() === 'pass' ? '#059669' : '#DC2626');
        } else if (i === 14) { // Flagged column
          doc.font('Helvetica-Bold');
          doc.fillColor(data.toLowerCase() === 'yes' ? '#DC2626' : '#6B7280');
        } else if (i === 15) { // Shortlisted column
          doc.font('Helvetica-Bold');
          doc.fillColor(data.toLowerCase() === 'yes' ? '#059669' : '#6B7280');
        } else {
          doc.font('Helvetica');
          doc.fillColor('#1F2937');
        }

        doc.text(data, x + 3, currentY + 7, {
          width: colWidths[i] - 6,
          align: i >= 4 ? 'center' : 'left',
          lineBreak: false
        });
      });

      currentY += rowHeight;
    });

    // Draw Outer Table Border
    doc.strokeColor('#D1D5DB')
      .lineWidth(1)
      .rect(tableX, tableTop, colWidths.reduce((a, b) => a + b, 0), currentY - tableTop)
      .stroke();

    // Add Vertical Lines for better visual separation
    let xPos = tableX;
    doc.lineWidth(0.5).strokeColor('#E5E7EB');
    for (let i = 1; i < colWidths.length; i++) {
      xPos += colWidths[i-1];
      doc.moveTo(xPos, tableTop).lineTo(xPos, currentY).stroke();
    }

    // Footer removed to prevent auto-pagination issues
    // Industry standard: Small datasets don't need footers

    doc.end();

    console.log('PDF generated successfully with', students.length, 'students');
  } catch (error) {
    console.error('=== PDF EXPORT ERROR ===');
    console.error('Error:', error);
    console.error('Stack:', error.stack);

    // If headers haven't been sent yet, send error response
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to generate PDF',
        error: error.message
      });
    }
  }
});

// Helper function to add footer securely
function addPageFooter(doc, examName) {
  const footerY = doc.page.height - 40;

  // Footer Line
  doc.strokeColor('#E5E7EB')
    .lineWidth(1)
    .moveTo(40, footerY - 10)
    .lineTo(doc.page.width - 40, footerY - 10)
    .stroke();

  // Footer text with lineBreak:false to prevent auto-pagination
  doc.font('Helvetica')
    .fontSize(8)
    .fillColor('#9CA3AF');

  doc.text('SHNOOR Management System - Strictly Confidential', 40, footerY, {
    lineBreak: false,
    width: 300
  });

  doc.text('Page', doc.page.width - 100, footerY, {
    align: 'right',
    lineBreak: false,
    width: 60
  });
}

module.exports = router;