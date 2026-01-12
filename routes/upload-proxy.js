const express = require('express');
const multer = require('multer');
const azureStorage = require('../utils/azureStorage');

const router = express.Router();

// Configure multer for memory storage (no temp files)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB
  }
});

// Proxy upload to Azure (fallback for CORS issues)
router.post('/video-proxy', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Video file is required'
      });
    }

    const { title, description, visibility, tags } = req.body;
    const videoPublicId = `video_${Date.now()}_proxy`;

    console.log('Proxying video upload to Azure:', {
      filename: req.file.originalname,
      size: req.file.size,
      videoPublicId
    });

    // Upload buffer directly to Azure
    const uploadResult = await azureStorage.uploadBuffer(
      req.file.buffer,
      'videos',
      `${videoPublicId}.mp4`,
      req.file.mimetype
    );

    // Create video database record
    const Video = require('../models/Video');
    const videoData = {
      title: title || 'Untitled Video',
      description: description || '',
      creatorId: null, // Anonymous upload
      tags: tags ? JSON.parse(tags) : [],
      visibility: visibility || 'public',
      video: {
        original: {
          url: uploadResult.url,
          blobName: `${videoPublicId}.mp4`,
          format: 'mp4',
          bytes: req.file.size
        }
      },
      thumbnails: [],
      metadata: {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        uploadedAt: new Date()
        // Don't include location field to avoid geo indexing issues
      },
      status: 'ready'
    };

    const video = new Video(videoData);
    await video.save();

    console.log('Video saved to database:', video._id);

    // Return video data
    res.json({
      success: true,
      data: {
        video: video.toObject()
      }
    });

  } catch (error) {
    console.error('Proxy upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed'
    });
  }
});

module.exports = router;
