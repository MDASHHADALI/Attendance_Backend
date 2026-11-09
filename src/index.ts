import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// Health check endpoint for Render to verify the server is alive
app.get('/', (req, res) => {
  res.json({ status: 'Smart Attendance API is running on Render' });
});

// The endpoint Flutter will POST telemetry data to
app.post('/api/attendance', async (req, res) => {
  const { studentId, classId, latitude, longitude, deviceId } = req.body;

  try {
    const record = await prisma.attendanceRecord.create({
      data: {
        studentId,
        classId,
        latitude,
        longitude,
        deviceId,
        status: 'PENDING_VERIFICATION' // Awaiting ML check
      }
    });
    res.status(201).json({ success: true, record });
  } catch (error) {
    console.error('Error logging attendance:', error);
    res.status(500).json({ success: false, error: 'Failed to log attendance' });
  }
});

// The ML microservice will call this endpoint to update flagged records
app.post('/api/attendance/ml-update', async (req, res) => {
  const { flaggedRecordIds } = req.body; // Array of IDs flagged by Scikit-learn

  try {
    const updated = await prisma.attendanceRecord.updateMany({
      where: { id: { in: flaggedRecordIds } },
      data: { status: 'FLAGGED' }
    });
    res.status(200).json({ success: true, updatedCount: updated.count });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update records' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});