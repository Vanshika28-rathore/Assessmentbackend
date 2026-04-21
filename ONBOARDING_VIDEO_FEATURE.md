# Onboarding Video Feature

## Overview
This feature allows admins to upload a 2-3 minute onboarding video that will be shown to students on their first login. Students must watch at least 80% of the video before they can continue to the dashboard.

## Features
- Admin can upload a video (MP4, WebM, MOV, AVI formats)
- Maximum file size: 100MB
- Only one active video at a time (uploading a new video replaces the old one)
- Admin can preview the current video
- Admin can delete the current video
- Students see the video only on first login
- Students must watch 80% before continuing
- Video progress tracking with visual progress bar

## Database Schema

### New Table: `onboarding_videos`
```sql
CREATE TABLE onboarding_videos (
    id SERIAL PRIMARY KEY,
    video_url TEXT NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    uploaded_by VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    file_size BIGINT,
    duration_seconds INTEGER
);
```

### Modified Table: `students`
```sql
ALTER TABLE students 
ADD COLUMN has_seen_onboarding_video BOOLEAN DEFAULT false;
```

## API Endpoints

### Admin Endpoints

#### Upload Video
```
POST /api/onboarding-video/upload
Authorization: Bearer <admin_token>
Content-Type: multipart/form-data

Body: { video: <file> }

Response: {
  success: true,
  message: "Onboarding video uploaded successfully",
  video: { id, video_url, uploaded_at, ... }
}
```

#### Get Current Video (Admin)
```
GET /api/onboarding-video
Authorization: Bearer <admin_token>

Response: {
  success: true,
  video: { id, video_url, uploaded_at, ... } | null
}
```

#### Delete Video
```
DELETE /api/onboarding-video
Authorization: Bearer <admin_token>

Response: {
  success: true,
  message: "Onboarding video deleted successfully"
}
```

### Student Endpoints

#### Get Onboarding Video (Student)
```
GET /api/onboarding-video/student
Authorization: Bearer <student_token>

Response: {
  success: true,
  video: { id, video_url, uploaded_at } | null,
  hasSeen: boolean
}
```

#### Mark Video as Seen
```
POST /api/onboarding-video/mark-seen
Authorization: Bearer <student_token>

Response: {
  success: true,
  message: "Onboarding video marked as seen"
}
```

## Frontend Components

### Admin Dashboard
- **Location**: `src/components/admin/SystemSettingsTab.jsx`
- **Features**:
  - Upload video with drag-and-drop or file picker
  - Preview current video
  - Delete current video
  - Replace existing video
  - File size and format validation

### Student Dashboard
- **Location**: `src/pages/Dashboard.jsx`
- **Component**: `src/components/OnboardingVideoModal.jsx`
- **Features**:
  - Modal overlay that blocks dashboard access
  - Video player with controls
  - Progress bar showing watch percentage
  - "Continue" button enabled after 80% watched
  - Automatic marking as seen when completed

## File Storage
- Videos are stored in: `aws-assessments-backend/uploads/onboarding/`
- Filename format: `onboarding-{timestamp}-{random}.{ext}`
- Old videos are automatically deleted when new ones are uploaded

## Migration
The migration runs automatically on server startup. To run manually:

```bash
cd aws-assessments-backend
node run-onboarding-migration.js
```

## Usage Instructions

### For Admins
1. Navigate to Admin Dashboard → System Settings
2. Scroll to "Student Onboarding Video" section
3. Click "Click to upload onboarding video" or drag and drop a video file
4. Wait for upload to complete
5. Preview the video using the "Preview" button
6. To replace: Upload a new video (old one is automatically deleted)
7. To remove: Click "Delete" button

### For Students
1. Login to the platform for the first time
2. Onboarding video modal appears automatically
3. Watch the video (at least 80%)
4. Click "Continue to Dashboard" when enabled
5. Video will not appear again on subsequent logins

## Technical Details

### Video Format Support
- MP4 (recommended)
- WebM
- MOV
- AVI

### Constraints
- Maximum file size: 100MB
- Only one active video at a time
- Students must watch 80% to continue
- Video is shown only once per student

### Security
- Admin-only upload/delete operations
- File type validation
- File size validation
- Secure file storage with unique filenames
- Database transaction for atomic operations

## Troubleshooting

### Video not showing for students
- Check if video is marked as active in database
- Verify student's `has_seen_onboarding_video` is false
- Check video file exists in uploads/onboarding/

### Upload fails
- Check file size (must be < 100MB)
- Verify file format (MP4, WebM, MOV, AVI)
- Check uploads/onboarding/ directory permissions
- Review server logs for errors

### Video not playing
- Verify video file is not corrupted
- Check browser video codec support
- Try different video format (MP4 recommended)
