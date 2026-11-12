import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------------------------
app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'Smart Attendance API is running on Render' });
});

// ---------------------------------------------------------------------------
// STEP 1 & 2: TELEMETRY CAPTURE & STORAGE
// Receives GPS/Device ID from Flutter and saves as PENDING_VERIFICATION
// ---------------------------------------------------------------------------
app.post('/api/attendance', async (req: Request, res: Response) => {
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

// ---------------------------------------------------------------------------
// STEP 3 (Trigger): RUN ML ANOMALY DETECTION
// Fetches pending records and sends them to the Python Microservice
// ---------------------------------------------------------------------------
app.post('/api/attendance/run-ml', async (req: Request, res: Response) => {
  const { classId }: { classId?: string } = req.body;
  const mlUrl = process.env.ML_SERVICE_URL;

  if (!classId) {
    return res.status(400).json({ success: false, error: 'classId is required' });
  }
  if (!mlUrl) {
    return res.status(500).json({ success: false, error: 'ML_SERVICE_URL is not configured' });
  }

  try {
    const pendingRecords = await prisma.attendanceRecord.findMany({
      where: { classId, status: 'PENDING_VERIFICATION' }
    });

    if (pendingRecords.length === 0) {
      return res.status(400).json({ success: false, error: 'No pending records to analyze' });
    }

    const mlResponse = await fetch(`${mlUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: pendingRecords })
    });

    const result = await mlResponse.json();
    return res.status(mlResponse.status).json(result);
  } catch (error) {
    console.error('Error calling ML service:', error);
    return res.status(500).json({ success: false, error: 'Failed to run ML analysis' });
  }
});

// ---------------------------------------------------------------------------
// STEP 3 (Callback): ML UPDATE
// Python AI calls this to flag anomalies and verify honest records
// ---------------------------------------------------------------------------
app.post('/api/attendance/ml-update', async (req: Request, res: Response) => {
  const { flaggedRecordIds = [], classId }: { flaggedRecordIds?: string[]; classId?: string } = req.body;

  try {
    // Mark anomalous records as FLAGGED
    const flagged = await prisma.attendanceRecord.updateMany({
      where: { id: { in: flaggedRecordIds } },
      data: { status: 'FLAGGED' }
    });

    // Mark the remaining pending records as VERIFIED
    let verifiedCount = 0;
    if (classId) {
      const verified = await prisma.attendanceRecord.updateMany({
        where: {
          classId,
          status: 'PENDING_VERIFICATION',
          id: { notIn: flaggedRecordIds }
        },
        data: { status: 'VERIFIED' }
      });
      verifiedCount = verified.count;
    }

    res.status(200).json({
      success: true,
      flaggedCount: flagged.count,
      verifiedCount
    });
  } catch (error) {
    console.error('Error updating ML records:', error);
    res.status(500).json({ success: false, error: 'Failed to update records' });
  }
});

// ---------------------------------------------------------------------------
// STEP 4: CRYPTOGRAPHIC PROOF (SHA-256 NOTARY)
// Hashes all VERIFIED entries to seal the day's record
// ---------------------------------------------------------------------------
app.post('/api/attendance/notarize', async (req: Request, res: Response) => {
  const { classId }: { classId?: string } = req.body;

  if (!classId) {
    return res.status(400).json({ success: false, error: 'classId is required' });
  }

  try {
    // 1. Fetch all VERIFIED records for this class
    const records = await prisma.attendanceRecord.findMany({
      where: {
        classId,
        status: 'VERIFIED'
      }
    });

    if (records.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No verified attendance records found to notarize'
      });
    }

    // 2. Sort deterministically by ID and lock all telemetry fields into a payload string
    records.sort((a, b) => a.id.localeCompare(b.id));
    const dataPayload = records
      .map((r) => `${r.id}:${r.studentId}:${r.deviceId}:${r.latitude},${r.longitude}`)
      .join('|');

    // 3. Compute deterministic SHA-256 block hash
    const blockHash = crypto
      .createHash('sha256')
      .update(dataPayload)
      .digest('hex');

    // 4. Return the cryptographic proof
    return res.status(200).json({
      success: true,
      classId,
      recordCount: records.length,
      merkleRootHash: blockHash,
      timestamp: new Date().toISOString(),
      status: 'IMMUTABLE_HASH_GENERATED'
    });
  } catch (error) {
    console.error('Notarization error:', error);
    return res.status(500).json({ success: false, error: 'Failed to generate notary hash' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});