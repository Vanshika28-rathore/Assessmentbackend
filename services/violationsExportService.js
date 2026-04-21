const ExcelJS = require('exceljs');
const pool = require('../config/db');

// Format violations data for Excel export
async function getViolationsDataForExport(testId) {
  try {
    // Get test details
    const testResult = await pool.query(
      'SELECT id, title, duration FROM tests WHERE id = $1',
      [testId]
    );

    if (testResult.rows.length === 0) {
      throw new Error('Test not found');
    }

    const test = testResult.rows[0];

    // Get violations grouped by student
    const violationsResult = await pool.query(
      `SELECT 
        pv.student_id,
        s.full_name as student_name,
        s.email as student_email,
        s.phone as student_phone,
        s.roll_number as student_roll_number,
        COUNT(CASE WHEN pv.violation_type = 'no_face' THEN 1 END) as no_face_count,
        COUNT(CASE WHEN pv.violation_type = 'multiple_faces' THEN 1 END) as multiple_faces_count,
        COUNT(CASE WHEN pv.violation_type = 'phone_detected' THEN 1 END) as phone_detected_count,
        COUNT(CASE WHEN pv.violation_type = 'looking_down' THEN 1 END) as looking_down_count,
        COUNT(CASE WHEN pv.violation_type = 'video_blur' THEN 1 END) as video_blur_count,
        COUNT(CASE WHEN pv.violation_type = 'loud_noise' THEN 1 END) as loud_noise_count,
        COUNT(CASE WHEN pv.violation_type = 'voice_detected' THEN 1 END) as voice_detected_count,
        COUNT(CASE WHEN pv.violation_type != 'microphone_silent' THEN 1 END) as total_violations,
        COUNT(CASE WHEN pv.severity = 'high' AND pv.violation_type != 'microphone_silent' THEN 1 END) as high_severity_count,
        COUNT(CASE WHEN pv.severity = 'medium' AND pv.violation_type != 'microphone_silent' THEN 1 END) as medium_severity_count,
        COUNT(CASE WHEN pv.severity = 'low' AND pv.violation_type != 'microphone_silent' THEN 1 END) as low_severity_count,
        MAX(pv.timestamp) as last_violation,
        MIN(pv.timestamp) as first_violation
      FROM proctoring_violations pv
      LEFT JOIN students s ON pv.student_id = s.firebase_uid
      WHERE pv.test_id = $1
      GROUP BY pv.student_id, s.full_name, s.email, s.phone, s.roll_number
      ORDER BY total_violations DESC`,
      [testId]
    );

    return {
      test,
      violations: violationsResult.rows
    };
  } catch (error) {
    console.error('Error fetching violations data:', error);
    throw error;
  }
}

// Generate Excel file with violations report
async function generateViolationsExcel(testId) {
  try {
    const { test, violations } = await getViolationsDataForExport(testId);

    if (violations.length === 0) {
      throw new Error('No violations found for this test');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Violations Report');

    // Set up columns
    worksheet.columns = [
      { header: 'Student ID', key: 'student_id', width: 15 },
      { header: 'Roll Number', key: 'roll_number', width: 15 },
      { header: 'Student Name', key: 'student_name', width: 25 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'No Face', key: 'no_face', width: 12 },
      { header: 'Multiple Faces', key: 'multiple_faces', width: 15 },
      { header: 'Phone Detected', key: 'phone_detected', width: 15 },
      { header: 'Looking Down', key: 'looking_down', width: 15 },
      { header: 'Video Blur', key: 'video_blur', width: 12 },
      { header: 'Loud Noise', key: 'loud_noise', width: 12 },
      { header: 'Voice Detected', key: 'voice_detected', width: 15 },
      { header: 'Total Violations', key: 'total_violations', width: 15 },
      { header: 'High Severity', key: 'high_severity', width: 15 },
      { header: 'Medium Severity', key: 'medium_severity', width: 15 },
      { header: 'Low Severity', key: 'low_severity', width: 15 },
      { header: 'Flagged', key: 'flagged', width: 10 },
      { header: 'First Violation', key: 'first_violation', width: 20 },
      { header: 'Last Violation', key: 'last_violation', width: 20 }
    ];

    // Style the header row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFDC143C' } // Crimson red for violations
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Add title row above headers
    worksheet.insertRow(1, [`Violations Report - ${test.title}`]);
    const titleRow = worksheet.getRow(1);
    titleRow.font = { bold: true, size: 14 };
    titleRow.alignment = { horizontal: 'center' };
    worksheet.mergeCells('A1:S1');

    // Add test info row
    worksheet.insertRow(2, [`Generated on: ${new Date().toLocaleString()}`]);
    const infoRow = worksheet.getRow(2);
    infoRow.font = { italic: true, size: 10 };
    worksheet.mergeCells('A2:S2');

    // Add empty row
    worksheet.insertRow(3, []);

    // Add data rows
    violations.forEach(violation => {
      const isFlagged = violation.high_severity_count >= 3;
      
      const row = worksheet.addRow({
        student_id: violation.student_id,
        roll_number: violation.student_roll_number || 'N/A',
        student_name: violation.student_name,
        email: violation.student_email,
        phone: violation.student_phone || 'N/A',
        no_face: violation.no_face_count || 0,
        multiple_faces: violation.multiple_faces_count || 0,
        phone_detected: violation.phone_detected_count || 0,
        looking_down: violation.looking_down_count || 0,
        video_blur: violation.video_blur_count || 0,
        loud_noise: violation.loud_noise_count || 0,
        voice_detected: violation.voice_detected_count || 0,
        total_violations: violation.total_violations || 0,
        high_severity: violation.high_severity_count || 0,
        medium_severity: violation.medium_severity_count || 0,
        low_severity: violation.low_severity_count || 0,
        flagged: isFlagged ? 'YES' : 'NO',
        first_violation: violation.first_violation 
          ? new Date(violation.first_violation).toLocaleString() 
          : 'N/A',
        last_violation: violation.last_violation 
          ? new Date(violation.last_violation).toLocaleString() 
          : 'N/A'
      });

      // Highlight flagged students
      if (isFlagged) {
        row.eachCell((cell) => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFCCCC' } // Light red background
          };
          cell.font = { bold: true };
        });
      }

      // Color code violation counts
      const violationCells = [6, 7, 8, 9, 10, 11, 12, 13]; // Violation count columns
      violationCells.forEach(colIndex => {
        const cell = row.getCell(colIndex);
        const value = parseInt(cell.value) || 0;
        if (value > 0) {
          if (value >= 5) {
            cell.font = { color: { argb: 'FFDC143C' }, bold: true }; // Red
          } else if (value >= 3) {
            cell.font = { color: { argb: 'FFFF8C00' }, bold: true }; // Orange
          } else {
            cell.font = { color: { argb: 'FFFFA500' } }; // Light orange
          }
        }
      });
    });

    // Add summary section at the bottom
    const summaryStartRow = worksheet.rowCount + 2;
    worksheet.addRow([]);
    worksheet.addRow(['SUMMARY']);
    const summaryTitleRow = worksheet.getRow(summaryStartRow + 1);
    summaryTitleRow.font = { bold: true, size: 12 };
    summaryTitleRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    const totalStudents = violations.length;
    const flaggedStudents = violations.filter(v => v.high_severity_count >= 3).length;
    const totalViolations = violations.reduce((sum, v) => sum + (v.total_violations || 0), 0);
    const avgViolationsPerStudent = totalStudents > 0 ? (totalViolations / totalStudents).toFixed(2) : 0;

    worksheet.addRow(['Total Students with Violations:', totalStudents]);
    worksheet.addRow(['Flagged Students (3+ High Severity):', flaggedStudents]);
    worksheet.addRow(['Total Violations:', totalViolations]);
    worksheet.addRow(['Average Violations per Student:', avgViolationsPerStudent]);

    // Convert to buffer
    const buffer = await workbook.xlsx.writeBuffer();
    
    // Generate filename
    const timestamp = new Date().toISOString().split('T')[0];
    const testName = test.title.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `violations_${testName}_${timestamp}.xlsx`;

    return {
      buffer,
      filename
    };
  } catch (error) {
    console.error('Error generating violations Excel:', error);
    throw error;
  }
}

module.exports = {
  generateViolationsExcel
};
