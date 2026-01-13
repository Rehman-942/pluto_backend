const express = require('express');
const multer = require('multer');
const azureStorage = require('../utils/azureStorage');
const videoProcessor = require('../utils/videoProcessor');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Configure multer for memory storage (no temp files)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB
  }
});

// Direct proxy upload to Azure with optional thumbnail
router.post('/video-proxy', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]), async (req, res) => {
  try {
    // Check for video file (req.files when using upload.fields)
    if (!req.files || !req.files.video || !req.files.video[0]) {
      return res.status(400).json({
        success: false,
        error: 'Video file is required'
      });
    }

    const videoFile = req.files.video[0];
    const thumbnailFile = req.files.thumbnail ? req.files.thumbnail[0] : null;
    
    const { title, description, visibility, tags } = req.body;
    const videoPublicId = `video_${Date.now()}_proxy`;

    console.log('Direct Azure upload:', {
      videoFilename: videoFile.originalname,
      videoSize: videoFile.size,
      hasThumbnail: !!thumbnailFile,
      thumbnailFilename: thumbnailFile?.originalname,
      videoPublicId
    });

    // Upload video buffer directly to Azure
    console.log('📤 Uploading video directly to Azure...');
    const videoUploadResult = await azureStorage.uploadBuffer(
      videoFile.buffer,
      'videos',
      `${videoPublicId}.mp4`,
      videoFile.mimetype
    );

    console.log('✅ Video upload completed:', videoUploadResult.url);

    // Upload thumbnail if provided
    let thumbnails = {};
    if (thumbnailFile) {
      console.log('📸 Uploading thumbnail to Azure...');
      
      // Determine thumbnail file extension
      const thumbnailExt = path.extname(thumbnailFile.originalname) || '.jpg';
      const thumbnailUploadResult = await azureStorage.uploadBuffer(
        thumbnailFile.buffer,
        'video_thumbnails',
        `${videoPublicId}_poster${thumbnailExt}`,
        thumbnailFile.mimetype
      );
      
      console.log('✅ Thumbnail upload completed:', thumbnailUploadResult.url);
      
      // Create thumbnail object
      thumbnails = {
        poster: {
          url: thumbnailUploadResult.url,
          blobName: thumbnailUploadResult.blobName,
          width: 1280, // Default dimensions
          height: 720
        },
        large: {
          url: thumbnailUploadResult.url,
          blobName: thumbnailUploadResult.blobName,
          width: 1280,
          height: 720
        },
        medium: {
          url: thumbnailUploadResult.url,
          blobName: thumbnailUploadResult.blobName,
          width: 1280,
          height: 720
        },
        small: {
          url: thumbnailUploadResult.url,
          blobName: thumbnailUploadResult.blobName,
          width: 1280,
          height: 720
        }
      };
    }

    // Create video database record with thumbnails
    const Video = require('../models/Video');
    const videoData = {
      title: title || 'Untitled Video',
      description: description || '',
      creatorId: null, // Anonymous upload
      tags: tags ? JSON.parse(tags) : [],
      visibility: visibility || 'public',
      video: {
        original: {
          url: videoUploadResult.url,
          blobName: videoUploadResult.blobName,
          format: 'mp4',
          bytes: videoFile.size
        }
      },
      thumbnails: thumbnails, // Uploaded thumbnails or empty object
      metadata: {
        fileName: videoFile.originalname,
        mimeType: videoFile.mimetype,
        fileSize: videoFile.size,
        uploadedAt: new Date(),
        processingStatus: 'completed'
      },
      status: 'ready'
    };

    const video = new Video(videoData);
    await video.save();

    console.log('✅ Video saved to database:', video._id);

    // Return video data
    res.json({
      success: true,
      data: {
        video: video.toObject()
      }
    });

  } catch (error) {
    console.error('❌ Direct upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed: ' + error.message
    });
  }
});

module.exports = router;
