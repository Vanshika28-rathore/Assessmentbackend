-- Create interviews table for PostgreSQL
CREATE TABLE IF NOT EXISTS interviews (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL,
  test_id INTEGER NOT NULL,
  scheduled_time TIMESTAMP NOT NULL,
  duration INTEGER DEFAULT 60,
  status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  peer_id VARCHAR(255),
  admin_notes TEXT,
  technical_score INTEGER,
  communication_score INTEGER,
  recommendation VARCHAR(20) DEFAULT 'on_hold' CHECK (recommendation IN ('selected', 'rejected', 'on_hold')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_interviews_scheduled_time ON interviews(scheduled_time);
CREATE INDEX IF NOT EXISTS idx_interviews_status ON interviews(status);

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_interviews_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_interviews_updated_at
BEFORE UPDATE ON interviews
FOR EACH ROW
EXECUTE FUNCTION update_interviews_updated_at();
